# Installation

This guide installs Role Explorer into one Snowflake account. The whole install takes about ten minutes plus a
few minutes for the app's container to start the first time.

To have Cortex Code run these steps for you, see [Install with Cortex Code](COCO_INSTALL.md).

## Prerequisites

| Requirement | Notes |
|---|---|
| Snowflake account | Streamlit in Snowflake with the **container runtime** must be available in your region ([runtime environments](https://docs.snowflake.com/en/developer-guide/streamlit/app-development/runtime-environments)). |
| `ACCOUNTADMIN` | Needed once, for `setup/setup.sql` (it creates a role, integrations and account-level grants). |
| Snowflake CLI 3.x | [Install guide](https://docs.snowflake.com/en/developer-guide/snowflake-cli/installation/installation). The setup scripts use its `-D name=value` template variables. Check with `snow --version`. |
| A CLI connection | `snow connection add`, then `snow connection test -c <connection>`. See [connecting](https://docs.snowflake.com/en/developer-guide/snowflake-cli/connecting/configure-connections). |
| A warehouse | Any existing warehouse; an X-Small is plenty. The app and the setup scripts run their queries on it. |
| A verified email address | The address that should receive alerts. It must belong to a user in this account who has [verified their email](https://docs.snowflake.com/en/user-guide/notifications/email-notifications). |
| Cortex AI | The Ask assistant and alert drafting call `AI_COMPLETE`. See [Architecture](ARCHITECTURE.md#ask-assistant) if `claude-sonnet-4-5` isn't available in your region. |
| Node.js 18+ (optional) | Only to rebuild the UI. The repo ships a pre-built bundle (`ui/sl_ui.js`), so deploying does not need Node. |

Run every command below from the root of your clone:

```bash
git clone https://github.com/sfc-gh-vshiv/snowflake-rbac-explorer.git
cd snowflake-rbac-explorer
```

## Step 1: Account setup

```bash
snow sql -c <connection> -f setup/setup.sql \
  -D admin_user=<YOUR_USER> \
  -D warehouse=<WAREHOUSE> \
  -D alert_email=<you@company.com>
```

| Variable | Meaning |
|---|---|
| `admin_user` | The Snowflake user who will deploy and use the app. They receive `RBAC_EXPLORER_ROLE`. |
| `warehouse` | Existing warehouse used for the app's queries. |
| `alert_email` | The only address alert emails may be sent to (you can add more later). |

The script is idempotent: re-running it is safe. It creates and grants the following.

| Grant / object | Why the app needs it |
|---|---|
| Role `RBAC_EXPLORER_ROLE`, granted to `ACCOUNTADMIN` and `admin_user` | Owns the app and every object it creates. |
| `SNOWFLAKE.SECURITY_VIEWER` | Read `ACCOUNT_USAGE.GRANTS_TO_ROLES` and `GRANTS_TO_USERS` (the role graph and privileges). |
| `SNOWFLAKE.GOVERNANCE_VIEWER` | Read `ACCOUNT_USAGE.QUERY_HISTORY`, used to name the user and statement behind a violating `GRANT`. |
| `MANAGE GRANTS ON ACCOUNT` | Run `SHOW GRANTS OF ROLE` / `SHOW GRANTS TO ROLE` on any role (live checks and the watcher), and revoke grants for rules that opt into auto-revoke. |
| `SNOWFLAKE.CORTEX_USER` | Call `AI_COMPLETE` for the Ask assistant and alert drafting. |
| `USAGE` on the warehouse | Run the app's queries. |
| `EXECUTE TASK`, `EXECUTE MANAGED TASK` | Run the serverless watcher task. |
| `USAGE ON COMPUTE POOL SYSTEM_COMPUTE_POOL_CPU` | Run the app on the Streamlit container runtime. |
| Integration `RBAC_EXPLORER_EMAIL_INT` | Send alert emails with `SYSTEM$SEND_EMAIL`. |
| Integration `RBAC_EXPLORER_PYPI_EAI` (network rule `SNOWFLAKE.EXTERNAL_ACCESS.PYPI_RULE`) | The container runtime installs the packages pinned in `pyproject.toml` from PyPI. |
| Database `RBAC_EXPLORER_DB`, schemas `APP` and `ALERTS`, stage `APP.ROLE_EXPLORER_STAGE` | Where the app and its alert state live. |

> **Security note.** `RBAC_EXPLORER_ROLE` can see every grant in the account and holds `MANAGE GRANTS`.
> Treat it like `SECURITYADMIN`: grant it only to the people who administer access.

## Step 2: Alerting objects

```bash
snow sql -c <connection> -f setup/alerts.sql -D warehouse=<WAREHOUSE>
```

This creates the alert tables (`PROTECTED_ROLES`, `WATCH_RULES`, `WATCH_STATE`, `ALERT_LOG`), uploads
`modules/watch_kinds.py` to the `ALERTS.CODE` stage (so it must be run from the repo root), creates the
`CHECK_PROTECTED_ROLES` procedure and starts the `PROTECTED_ROLE_WATCH` task, which runs every minute.
See [Alerts](ALERTS.md) for how the watcher works and what it costs.

## Step 3: Deploy the app

```bash
RX_WAREHOUSE=<WAREHOUSE> bash deploy/deploy.sh <connection>
```

The script uploads the app files, creates the Streamlit object if needed, publishes a new version and then
downloads what Snowflake serves and compares it byte for byte with your local files. Every file should print
`match`.

| Setting | Default | Meaning |
|---|---|---|
| `RX_WAREHOUSE` | `COMPUTE_WH` | Query warehouse for the app. |
| `RX_COMPUTE_POOL` | `SYSTEM_COMPUTE_POOL_CPU` | Compute pool for the container runtime. |
| `RX_EAIS` | `RBAC_EXPLORER_PYPI_EAI` | External access integrations attached to the app. |
| `RX_APP` | `RBAC_EXPLORER_DB.APP.ROLE_EXPLORER` | Fully qualified app name (must stay in `RBAC_EXPLORER_DB`). |
| `RX_ARTIFACT_REPOS` | (none) | Artifact repositories to install packages from. When set, no external access integration is attached. |

If you omit the connection argument the script uses `$SNOWFLAKE_CONNECTION`, then the connection named `default`.

### Open the app

In Snowsight, switch your role to `RBAC_EXPLORER_ROLE` and open **Projects > Streamlit > Role Explorer**.
The first load takes a few minutes while the container starts and installs packages; after that it opens in
seconds. The first scan of `ACCOUNT_USAGE` takes up to about a minute on large accounts.

### Using an artifact repository instead of PyPI egress

Snowflake recommends attaching an
[artifact repository](https://docs.snowflake.com/en/developer-guide/streamlit/app-development/dependency-management)
rather than allowing egress to PyPI. To use the built-in PyPI mirror instead of `RBAC_EXPLORER_PYPI_EAI`:

```sql
USE ROLE ACCOUNTADMIN;
GRANT DATABASE ROLE SNOWFLAKE.PYPI_REPOSITORY_USER TO ROLE RBAC_EXPLORER_ROLE;
USE ROLE RBAC_EXPLORER_ROLE;
ALTER STREAMLIT RBAC_EXPLORER_DB.APP.ROLE_EXPLORER UNSET EXTERNAL_ACCESS_INTEGRATIONS;
ALTER STREAMLIT RBAC_EXPLORER_DB.APP.ROLE_EXPLORER
  SET ARTIFACT_REPOSITORIES = (snowflake.snowpark.pypi_shared_repository);
```

Or set it at deploy time, which attaches the repository and no external access integration:

```bash
RX_ARTIFACT_REPOS=snowflake.snowpark.pypi_shared_repository RX_WAREHOUSE=<WAREHOUSE> bash deploy/deploy.sh <connection>
```

`RBAC_EXPLORER_PYPI_EAI` is then unused; drop it if you like.

## Optional: Slack notifications

1. In Slack, create an app with an [incoming webhook](https://api.slack.com/messaging/webhooks) for the channel
   that should receive alerts. Copy the webhook URL.
2. Run, passing everything after `https://hooks.slack.com/services/`:

   ```bash
   snow sql -c <connection> -f setup/slack.sql -D slack_webhook_path=<T000/B000/XXXX>
   ```

   The path is stored in the Snowflake secret `RBAC_EXPLORER_DB.ALERTS.SLACK_WEBHOOK_SECRET`; it never appears in
   the repo or in the integration definition.
3. In the app's **Alerts** tab, tick **Post to Slack** on the rules that should post.

## Optional: demo scenario

`setup/demo_seed.sql` creates a service role meant only for one `SERVICE` user, a `PERSON` user to grant it to
by mistake, and a protected-role rule that forbids it. The users have no credentials and cannot sign in.

```bash
snow sql -c <connection> -f setup/demo_seed.sql -D warehouse=<WAREHOUSE> -D alert_email=<you@company.com>
```

Then use **Alerts > Try it: demo violation > Grant to DEMO_ANALYST_JANE** in the app, or grant the role yourself:

```sql
GRANT ROLE DEMO_PIPELINE_SVC_ROLE TO USER DEMO_ANALYST_JANE;   -- an alert arrives within about a minute
REVOKE ROLE DEMO_PIPELINE_SVC_ROLE FROM USER DEMO_ANALYST_JANE; -- the alert is marked resolved
```

## Adding alert recipients

Email can only be sent to addresses in the integration's allow-list, each a verified email of a user in the
account:

```sql
USE ROLE ACCOUNTADMIN;
ALTER NOTIFICATION INTEGRATION RBAC_EXPLORER_EMAIL_INT
  SET ALLOWED_RECIPIENTS = ('secops@company.com', 'you@company.com');
```

## Sharing the app

The app runs with the privileges of its owner (`RBAC_EXPLORER_ROLE`), so **anyone who can open it sees every
grant in the account and can edit alert rules**, including auto-revoke. Share it only with access administrators:

```sql
USE ROLE RBAC_EXPLORER_ROLE;
GRANT USAGE ON DATABASE RBAC_EXPLORER_DB TO ROLE <SECURITY_ADMIN_ROLE>;
GRANT USAGE ON SCHEMA RBAC_EXPLORER_DB.APP TO ROLE <SECURITY_ADMIN_ROLE>;
GRANT USAGE ON STREAMLIT RBAC_EXPLORER_DB.APP.ROLE_EXPLORER TO ROLE <SECURITY_ADMIN_ROLE>;
```

Granting `RBAC_EXPLORER_ROLE` itself to those users is the simpler alternative.

## Upgrading

```bash
git pull
snow sql -c <connection> -f setup/alerts.sql -D warehouse=<WAREHOUSE>   # safe to re-run; keeps rules and log
RX_WAREHOUSE=<WAREHOUSE> bash deploy/deploy.sh <connection>
```

If `pyproject.toml` changed, add `--rebuild` to the deploy command so the container reinstalls packages.

## Uninstalling

```bash
snow sql -c <connection> -f setup/uninstall.sql
```

This suspends the watcher, drops `RBAC_EXPLORER_DB` (app, rules, log, task, procedure, secret), the three
integrations, `RBAC_EXPLORER_ROLE` and the optional demo users and role.
