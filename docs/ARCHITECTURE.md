# Architecture and security

## Components

```
Snowsight ── Streamlit in Snowflake app (container runtime, one shared instance)
               │  streamlit_app.py      request router, query runner, result cache
               │  react_bridge.py       renders the React UI inline with st.html (no iframe)
               │  ui/sl_ui.js           pre-built React bundle (graph layout, all tabs, Ask panel)
               │  modules/model.py      RBAC model: ACCOUNT_USAGE grants + live SHOW results
               │  modules/ask.py        Ask assistant (AI_COMPLETE)
               │  modules/alerts.py     alert rules, alert log, watcher status, demo scenario
               │  modules/watch_kinds.py  custom alert kinds (shared with the watcher)
               │
               └─ queries run as RBAC_EXPLORER_ROLE on the query warehouse

Serverless task PROTECTED_ROLE_WATCH (every minute)
               └─ CALL CHECK_PROTECTED_ROLES()  ──>  ALERT_LOG ──> SYSTEM$SEND_EMAIL / Slack webhook
```

The UI is a React application bundled with esbuild into a single file. Streamlit renders it inline and the
two halves talk through a small request/response bridge: the browser posts a request (load the model, check a
role live, save a rule, ask a question), Python runs the matching queries and returns JSON. Long-running
queries are submitted asynchronously and polled, so the page never blocks.

All RBAC computation (transitive closure, paths, effective privileges, who-can-access, what-if revokes,
hygiene checks) runs in the browser in `frontend/src/graph.ts` over the model loaded once per refresh. That keeps
every click instant and means the app issues only a handful of queries per refresh.

## Data sources and freshness

| Data | Source | Freshness |
|---|---|---|
| Roles, users, user types, sign-in methods, owners | `SHOW ROLES`, `SHOW USERS` | Live |
| System-role holders (ACCOUNTADMIN, SECURITYADMIN, ...) | `SHOW GRANTS OF ROLE` | Live |
| Role-to-role edges, role-to-user grants, object privileges | `SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_ROLES`, `GRANTS_TO_USERS` | Up to about 2 hours behind |
| Role 360 **Check live** | `SHOW GRANTS OF ROLE`, `SHOW GRANTS TO ROLE` | Live |
| Alert detection | `SHOW GRANTS OF ROLE`, `SHOW GRANTS ON ACCOUNT / DATABASE`, `SHOW USERS`, `SHOW ROLES` | Live, every minute |
| Alert attribution (user and statement) | `ACCOUNT_USAGE.QUERY_HISTORY` | Filled in when it catches up |

See [ACCOUNT_USAGE data latency](https://docs.snowflake.com/en/sql-reference/account-usage#data-latency).
Refreshing the model scans `ACCOUNT_USAGE`, which takes from a few seconds to about a minute depending on the
size of the account. Results are cached on the server for 30 minutes and shared across viewers.

## What the app can and cannot see

- It reads **metadata only**: role, user and grant information and, for alert attribution, the text of `GRANT`
  statements in query history. It never reads data in your tables.
- `SHOW USERS` returns profile fields such as email and comment. They are shown in the Users tab to people who
  can open the app.
- The Ask assistant sends a summary of the RBAC data relevant to the question (role names, user names, grants)
  to `AI_COMPLETE`. Cortex AI functions run inside Snowflake; see
  [Snowflake AI and ML](https://docs.snowflake.com/en/guides-overview-ai-features) for how your data is handled.
- The app makes no outbound network calls except the container's package install from PyPI (or your artifact
  repository) and, if you set it up, Slack webhook posts made through a Snowflake notification integration.

## Security model

- **Owner's rights.** Streamlit in Snowflake apps run with the privileges of the app's owner role,
  `RBAC_EXPLORER_ROLE`, regardless of who is viewing. Anyone who can open the app sees all RBAC metadata and can
  edit alert rules. Grant access only to access administrators (see [Sharing the app](INSTALL.md#sharing-the-app)).
- **Least privilege.** The role gets the viewer database roles it needs (`SECURITY_VIEWER`,
  `GOVERNANCE_VIEWER`), `CORTEX_USER`, task privileges and `MANAGE GRANTS`. `MANAGE GRANTS` is required to run
  `SHOW GRANTS OF ROLE` on roles it does not own; it also allows the opt-in auto-revoke.
- **No changes without consent.** Revoke what-if only generates SQL. The app changes grants in exactly two places:
  rules you explicitly set to auto-revoke, and the demo scenario's buttons, which only touch the
  `DEMO_*` objects created by `setup/demo_seed.sql`.
- **Input handling.** Role and user names from the browser are checked against the live list before they are
  used in a `SHOW` command, identifiers are quoted, and values are passed as bind parameters. Alert rule specs
  are validated field by field (`clean_spec` in `modules/watch_kinds.py`).
- **Secrets.** The repo contains no credentials. The Slack webhook path lives only in a Snowflake secret.
  `deploy/deploy.sh` refuses to upload `secrets.toml`.

## Ask assistant

`modules/ask.py` builds one prompt per question from the page context and the last few turns, and calls:

```sql
SELECT AI_COMPLETE('claude-sonnet-4-5', <prompt>, {'temperature': 0.2, 'max_tokens': 1200})
```

The assistant is instructed to answer only from the supplied RBAC data and to say when the data doesn't
contain the answer. Alert drafting (`modules/alerts.py`, `DRAFT_MODEL`) uses the same model.

To use a different model, change `MODEL` in `modules/ask.py` and `DRAFT_MODEL` in `modules/alerts.py`, then
redeploy. Check which models your account can use and where they are available:

- [Model availability by region](https://docs.snowflake.com/en/user-guide/snowflake-cortex/aisql-regional-availability#regional-availability)
- [Cross-region inference](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cross-region-inference),
  if the model you want isn't in your region

## Runtime and packages

The app uses the Streamlit
[container runtime](https://docs.snowflake.com/en/developer-guide/streamlit/app-development/runtime-environments)
(`SYSTEM$ST_CONTAINER_RUNTIME_PY3_11`) on `SYSTEM_COMPUTE_POOL_CPU`. `pyproject.toml` pins the packages to the
versions pre-installed in that runtime, so installing them changes nothing underneath the running server. When
Snowflake updates the runtime image, update the pins to the new base versions, which are listed in the
container's install log.
