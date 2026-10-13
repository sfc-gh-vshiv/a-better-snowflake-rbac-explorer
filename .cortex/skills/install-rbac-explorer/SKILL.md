---
name: install-rbac-explorer
description: Install, deploy, verify, upgrade or uninstall the Snowflake RBAC Explorer (Role Explorer) Streamlit app from this repository. Use when the user asks to install, set up, deploy, upgrade, reinstall, troubleshoot or remove Role Explorer / RBAC Explorer, or to add Slack alerts or the demo scenario.
---

# Install Snowflake RBAC Explorer

You are installing the Streamlit in Snowflake app in this repository into the user's Snowflake account.
The repository root is the current project directory. Run every command from that root.

Read `docs/INSTALL.md` before you start; it is the source of truth for every step. This skill tells you how
to run it safely.

## Ground rules

- Never invent values. Ask the user for anything below that you cannot discover.
- Confirm with the user before running `setup/setup.sql` (it needs ACCOUNTADMIN and grants `MANAGE GRANTS`)
  and before `setup/uninstall.sql` (it drops the database and integrations).
- Never print, log or commit a Slack webhook URL. Pass it only as the `-D slack_webhook_path=` variable.
- Do not edit the SQL scripts to hard-code account values; use the `-D` variables.
- Do not turn on auto-revoke for any rule unless the user explicitly asks.

## Step 0: Gather inputs

1. Snowflake CLI: run `snow --version` (needs 3.x). If missing, point the user to
   https://docs.snowflake.com/en/developer-guide/snowflake-cli/installation/installation and stop.
2. Connection: run `snow connection list`. Ask which connection to use if there is more than one, then
   `snow connection test -c <connection>`.
3. Ask for, or confirm:
   - `admin_user`: the Snowflake user who will use the app (default: the connection's user, from
     `snow sql -c <connection> -q "SELECT CURRENT_USER()"`).
   - `warehouse`: an existing warehouse (list with `SHOW WAREHOUSES`).
   - `alert_email`: a verified email address of a user in this account.
4. Check the user can use ACCOUNTADMIN: `snow sql -c <connection> -q "USE ROLE ACCOUNTADMIN"`.
   If not, stop and explain that an account administrator must run Step 1.

## Step 1: Account setup (ACCOUNTADMIN)

Summarise what `setup/setup.sql` creates (role, database, two integrations, grants including
`MANAGE GRANTS`) and get a yes, then run:

```bash
snow sql -c <connection> -f setup/setup.sql -D admin_user=<admin_user> -D warehouse=<warehouse> -D alert_email=<alert_email>
```

## Step 2: Alerting objects

```bash
snow sql -c <connection> -f setup/alerts.sql -D warehouse=<warehouse>
```

It must run from the repo root because it uploads `modules/watch_kinds.py` with a relative path.

## Step 3: Deploy

```bash
RX_WAREHOUSE=<warehouse> bash deploy/deploy.sh <connection>
```

Success means every line ends with `match`. If any line says `DIFF`, re-run the script once; if it still
differs, report the output.

## Step 4: Verify

Run these and report the results in a short table:

```sql
USE ROLE RBAC_EXPLORER_ROLE;
SHOW STREAMLITS IN SCHEMA RBAC_EXPLORER_DB.APP;
SHOW TASKS LIKE 'PROTECTED_ROLE_WATCH' IN SCHEMA RBAC_EXPLORER_DB.ALERTS;   -- state should be "started"
CALL RBAC_EXPLORER_DB.ALERTS.CHECK_PROTECTED_ROLES(TRUE);                   -- dry run, sends nothing
```

Then tell the user to open Snowsight with role `RBAC_EXPLORER_ROLE`, go to **Projects > Streamlit >
Role Explorer**, and expect a few minutes on the first open while the container starts.

## Optional steps (only when asked)

- Slack: ask the user to create a Slack incoming webhook, then run
  `snow sql -c <connection> -f setup/slack.sql -D slack_webhook_path=<path after /services/>`.
- Demo scenario: `snow sql -c <connection> -f setup/demo_seed.sql -D warehouse=<warehouse> -D alert_email=<alert_email>`.
- Artifact repository instead of PyPI egress: see "Using an artifact repository" in `docs/INSTALL.md`.
- Upgrade: `git pull`, re-run Step 2 and Step 3.
- Uninstall: confirm first, then `snow sql -c <connection> -f setup/uninstall.sql`.

## When something fails

Look up the error in `docs/TROUBLESHOOTING.md` and apply the fix it describes. Report the exact error text
to the user if it is not covered there.
