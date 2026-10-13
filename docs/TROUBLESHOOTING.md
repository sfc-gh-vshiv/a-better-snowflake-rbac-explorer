# Troubleshooting

Start with the Alerts tab: it shows the watcher's last run, duration and any error, and every alert's delivery
result. For the app itself, see the
[Streamlit troubleshooting guide](https://docs.snowflake.com/en/developer-guide/streamlit/troubleshooting),
which also explains how to read the app's logs.

## Setup

| Symptom | Cause and fix |
|---|---|
| `-D` is rejected, or `<% ... %>` appears literally in errors | Snowflake CLI is older than 3.x. Upgrade it ([install guide](https://docs.snowflake.com/en/developer-guide/snowflake-cli/installation/installation)). |
| `setup.sql` says the user does not exist | `admin_user` must be the user's login name (`SELECT CURRENT_USER()` shows yours). |
| `SYSTEM_COMPUTE_POOL_CPU` does not exist | Your account has no default Streamlit compute pool. Create one ([compute pools](https://docs.snowflake.com/en/developer-guide/snowpark-container-services/working-with-compute-pool)), grant `USAGE` on it to `RBAC_EXPLORER_ROLE`, and deploy with `RX_COMPUTE_POOL=<pool>`. |
| `SNOWFLAKE.EXTERNAL_ACCESS.PYPI_RULE` is not found | Use an artifact repository instead (see [INSTALL.md](INSTALL.md#using-an-artifact-repository-instead-of-pypi-egress)) and skip the integration. |
| `alerts.sql` fails on `PUT 'file://modules/watch_kinds.py'` | Run it from the repository root, not from `setup/`. |
| The task fails because the owner lacks a task privilege | Re-run `setup/setup.sql`; it grants `EXECUTE TASK` and `EXECUTE MANAGED TASK`. |

## Deploy and start-up

| Symptom | Cause and fix |
|---|---|
| `deploy.sh` prints `DIFF` for a file | A copy was interrupted. Run the script again. |
| App spins for several minutes on first open | Normal: the container starts and installs packages. Later opens are fast. |
| App fails to start with a package install error | The app has no way to reach PyPI. Check `SHOW STREAMLITS IN SCHEMA RBAC_EXPLORER_DB.APP` lists `RBAC_EXPLORER_PYPI_EAI` (or an artifact repository); redeploy with `--rebuild`. |
| Insufficient privileges on the compute pool | `GRANT USAGE ON COMPUTE POOL <pool> TO ROLE RBAC_EXPLORER_ROLE;` |
| Old UI after a deploy | Reload the page. `window.SnowUI.version` in the browser console shows which bundle is loaded. |

## Using the app

| Symptom | Cause and fix |
|---|---|
| A new grant or role is missing from the graph | `ACCOUNT_USAGE` can be up to two hours behind. Use **Check live** on the role in Role 360, or refresh later. |
| First load takes about a minute | The app scans `ACCOUNT_USAGE.GRANTS_TO_ROLES` and `GRANTS_TO_USERS`; large accounts take longer. Results are cached for 30 minutes. |
| Ask returns an error about the model | `claude-sonnet-4-5` isn't available to your account or region. Enable [cross-region inference](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cross-region-inference) or change the model (see [Architecture](ARCHITECTURE.md#ask-assistant)). |
| Ask fails with a privilege error on `AI_COMPLETE` | `GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE RBAC_EXPLORER_ROLE;` |

## Alerts

| Symptom | Cause and fix |
|---|---|
| Alert logged but delivery shows `email failed` | The address isn't in `RBAC_EXPLORER_EMAIL_INT`'s allow-list or isn't a verified user email. See [Adding alert recipients](INSTALL.md#adding-alert-recipients). |
| Delivery says `slack failed` | Run `setup/slack.sql` (it creates `RBAC_EXPLORER_SLACK_INT`), check the webhook path, and confirm the Slack app still has the webhook enabled. |
| No alerts at all | Check the task is started: `SHOW TASKS IN SCHEMA RBAC_EXPLORER_DB.ALERTS;`. If it is suspended, `ALTER TASK RBAC_EXPLORER_DB.ALERTS.PROTECTED_ROLE_WATCH RESUME;`. Then check the latest row of `RBAC_EXPLORER_DB.ALERTS.WATCH_STATE` for an error. |
| The alert names a role but not the user who granted it | Attribution comes from `ACCOUNT_USAGE.QUERY_HISTORY`, which lags. The user and statement are filled in when it catches up. |
| A custom alert never fires for existing state | By design: custom alerts record a baseline when saved and alert only on changes after that. |
