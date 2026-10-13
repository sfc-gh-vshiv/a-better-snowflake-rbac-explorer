# Snowflake RBAC Explorer

A Streamlit in Snowflake app that makes your account's role-based access control (RBAC) readable, and
alerts you within about a minute when a role is granted to a user or role that shouldn't have it.

It runs entirely inside your Snowflake account. It reads RBAC metadata (roles, users, grants), never your
table data, and it never changes a grant unless you explicitly turn on auto-revoke for a rule.

| Tab | What it answers |
|---|---|
| **Hierarchy** | The role graph laid out top-down. Hover to trace ancestors and descendants, click to inspect, double-click to focus N hops, search with `/`. Busy parents fold their leaf roles into "+N roles" bundles; unconnected roles are listed as pills below the graph. Optional user and database-role layers. |
| **Role 360** | Who holds a role (and through which chain), what it inherits, every effective privilege (direct vs inherited), paths to the top, copy-ready SQL, and a live check against `SHOW GRANTS OF ROLE`. |
| **Who can access?** | Pick any object: every role and user that can reach it, the privilege, and the chain. Flags roles missing `USAGE` on the parent database or schema. |
| **Users** | Everything a user can use and touch, sign-in methods, idle or disabled status, secondary roles. |
| **Hygiene** | ACCOUNTADMIN holders, roles that inherit ACCOUNTADMIN, grants to PUBLIC, roles not rolled up to SYSADMIN, empty or unreachable roles, deep chains, idle users holding roles, people in service-style roles, password users without MFA, ownership concentration. |
| **Revoke what-if** | Stage revokes (role to role, role to user, privilege) and see exactly which users lose which privileges, before you run the generated `REVOKE` statements. Nothing is changed in Snowflake. |
| **Alerts** | Protected-role rules and custom alerts, the watcher's status, the alert log, and a one-click demo violation. |

An **Ask** assistant (bottom-right button) answers plain-English questions such as *"Who can use
ACCOUNTADMIN?"* using the RBAC data already loaded in the app, through Snowflake Cortex `AI_COMPLETE`.

## Quick start

You need a Snowflake account, the `ACCOUNTADMIN` role (for the one-time setup), and the
[Snowflake CLI](https://docs.snowflake.com/en/developer-guide/snowflake-cli/installation/installation)
3.x configured with a connection.

```bash
git clone https://github.com/sfc-gh-vshiv/snowflake-rbac-explorer.git
cd snowflake-rbac-explorer

# 1. Account setup: role, database, integrations, grants (as ACCOUNTADMIN)
snow sql -c <connection> -f setup/setup.sql \
  -D admin_user=<YOUR_USER> -D warehouse=<WAREHOUSE> -D alert_email=<you@company.com>

# 2. Alert tables, watcher procedure and the 1-minute task (run from the repo root)
snow sql -c <connection> -f setup/alerts.sql -D warehouse=<WAREHOUSE>

# 3. Deploy the app
RX_WAREHOUSE=<WAREHOUSE> bash deploy/deploy.sh <connection>
```

Then in Snowsight switch to the `RBAC_EXPLORER_ROLE` role and open **Projects > Streamlit > Role Explorer**.
The first open takes a few minutes while the container starts.

Prefer to let an AI assistant do it? See [Install with Cortex Code](docs/COCO_INSTALL.md): one prompt
installs, deploys and verifies the app for you.

## Documentation

| Guide | Contents |
|---|---|
| [Installation](docs/INSTALL.md) | Prerequisites, every privilege and why it is needed, step-by-step setup, optional Slack and demo data, sharing the app, upgrading and uninstalling. |
| [Install with Cortex Code](docs/COCO_INSTALL.md) | Install the Cortex Code CLI and let it install the app using the skill bundled in this repo. |
| [Alerts](docs/ALERTS.md) | Protected-role rules, custom alert kinds, how detection and attribution work, email and Slack delivery, auto-revoke, cost. |
| [Architecture and security](docs/ARCHITECTURE.md) | Components, data sources and freshness, what the app can and cannot see, the security model. |
| [Development](docs/DEVELOPMENT.md) | Run locally, build the UI, run the tests, project layout. |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Common errors and how to fix them. |

## What gets created

All objects live in one database plus a few account-level objects, so the app is easy to audit and remove.

| Object | Purpose |
|---|---|
| Role `RBAC_EXPLORER_ROLE` | Owns the app and runs the watcher. Holds `MANAGE GRANTS`: grant it to security administrators only. |
| Database `RBAC_EXPLORER_DB` (schemas `APP`, `ALERTS`) | The Streamlit app, its source stage, alert rules, alert log, watcher procedure and task. |
| Integration `RBAC_EXPLORER_EMAIL_INT` | Email notifications to the recipients you allow. |
| Integration `RBAC_EXPLORER_PYPI_EAI` | Lets the Streamlit container runtime install its Python packages from PyPI. |
| Integration `RBAC_EXPLORER_SLACK_INT` (optional) | Slack notifications through an incoming webhook. |

`setup/uninstall.sql` removes all of them.

## Limitations

- Role edges, user grants and object privileges come from `SNOWFLAKE.ACCOUNT_USAGE`, which can be up to two
  hours behind. Use **Check live** on a role (Role 360) for its current state; the alert watcher always reads live.
- Access analysis covers privileges granted on objects. Future grants are not modelled, and roles holding
  `ACCOUNTADMIN` or `MANAGE GRANTS` can always grant themselves more.
- The Ask assistant needs a Cortex model that is available in your region (default `claude-sonnet-4-5`; see
  [Architecture](docs/ARCHITECTURE.md#ask-assistant) to change it).

## Support

This is a sample application provided as-is, without warranty or official Snowflake support. Review the code
and the privileges it requests before installing it in a production account.
