# Alerts

Role Explorer watches your account for grants that break rules you define and notifies you by email and,
optionally, Slack. Each alert includes who received the grant, through which chain, who granted it, and a
ready-to-run `REVOKE`.

## Rule types

Create rules in the app's **Alerts** tab with **+ Protect a role** or **+ Custom alert**. You can also describe an
alert in plain English (**Describe an alert**, or **Alert me about this** under an Ask answer) and the app drafts
a rule for you to review before saving.

| Rule | Fires when | Options |
|---|---|---|
| **Protected role** | A role is held by a user who isn't allowed, or is granted to a parent role that isn't allowed. Granting a role to another role hands it to everyone who holds that role, so parents are checked too. | Allowed users; required user `TYPE` (for example `SERVICE`); allowed parent roles; auto-revoke. |
| **Role holders change** | Someone new gets one of the listed roles (for example `ACCOUNTADMIN`), directly or, optionally, through another role. | Roles; include inherited holders; users to ignore. |
| **Sensitive privilege** | A role is granted one of the listed privileges (for example `MANAGE GRANTS`, `CREATE USER`) on the account or on chosen databases. | Privileges; scope; roles to ignore. |
| **New user / role** | A user or role is created that matches a filter. | Name pattern (`*` and `?` wildcards); user type; owner roles. |

When you save a custom alert, the app records what already exists as the rule's **baseline**, so only changes
after that moment alert. A protected-role rule checks the current state on every run, so an existing violation
alerts on the first run.

The **Insights** in the Hygiene tab and the role graph can start a rule for you (for example *Protect these roles
with an alert*), and roles covered by a rule are marked in the Hierarchy tab.

## How detection works

```
every minute ──> task PROTECTED_ROLE_WATCH ──> CALL CHECK_PROTECTED_ROLES()
                                                 │  live SHOW GRANTS OF ROLE / SHOW GRANTS ON ... / SHOW USERS / SHOW ROLES
                                                 ├─ new violation  ──> ALERT_LOG (OPEN) ──> email / Slack
                                                 ├─ violation gone ──> ALERT_LOG (RESOLVED)
                                                 └─ run summary    ──> WATCH_STATE (shown in the Alerts tab)
```

- The watcher reads **live** `SHOW` output, not `ACCOUNT_USAGE`, so detection does not wait for the up-to-two-hour
  `ACCOUNT_USAGE` latency. Expect an alert within one to two minutes of the `GRANT`.
- Detection logic lives in `modules/watch_kinds.py`. The app imports it for rule previews, and the procedure
  imports the same file from `@RBAC_EXPLORER_DB.ALERTS.CODE`, so a preview and the real check always agree.
  `deploy/deploy.sh` and `setup/alerts.sql` both upload it.
- Revoking the offending grant marks the alert **RESOLVED** on the next run. You can also **Ack** an alert in the app.

### Who made the grant

`SHOW GRANTS` reports the **role** that made a grant, not the user. The alert names that role and the users who
currently hold it straight away. The exact user and SQL statement are filled in later from
`SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY`, once it catches up (typically within an hour; see
[ACCOUNT_USAGE latency](https://docs.snowflake.com/en/sql-reference/account-usage#data-latency)).

## Notifications

| Channel | Set up | Notes |
|---|---|---|
| Email | `setup/setup.sql` creates `RBAC_EXPLORER_EMAIL_INT` | Recipients must be in the integration's `ALLOWED_RECIPIENTS` and be verified emails of users in the account. See [Adding alert recipients](INSTALL.md#adding-alert-recipients). |
| Slack | `setup/slack.sql` creates `RBAC_EXPLORER_SLACK_INT` | Posts a formatted message to an incoming-webhook channel; falls back to plain text if the webhook rejects blocks. |

The result of each delivery (`email`, `slack`, or the error) is stored in `ALERT_LOG.NOTIFIED` and shown in the
app, so a misconfigured channel is visible rather than silent.

## Auto-revoke

A protected-role rule can opt into **auto-revoke**. The watcher then runs `REVOKE ROLE <role> FROM ...` for each
violation within a minute and records `REVOKED` or `REVOKE_FAILED` in `ALERT_LOG.ACTION`. It is off by default.
Make sure the allowlist is complete before turning it on: a missing entry revokes access from a legitimate user.

## Tables

All in `RBAC_EXPLORER_DB.ALERTS`:

| Table | Contents |
|---|---|
| `PROTECTED_ROLES` | One row per protected-role rule. |
| `WATCH_RULES` | Custom alert rules (kind, spec, baseline). |
| `ALERT_LOG` | Every alert: grantee, reason, grantor, statement, delivery result, action, status. |
| `WATCH_STATE` | One row per watcher run: rules checked, new and open alerts, duration, error. |

You can query them directly, for example to forward alerts to a SIEM:

```sql
SELECT DETECTED_AT, KIND, ROLE_NAME, GRANTEE, REASON, GRANTED_BY_USER, STATUS
FROM RBAC_EXPLORER_DB.ALERTS.ALERT_LOG
ORDER BY DETECTED_AT DESC LIMIT 50;
```

## Cost and schedule

The watcher is a [serverless task](https://docs.snowflake.com/en/user-guide/tasks-intro) that runs every minute,
so it consumes serverless compute credits continuously while it is resumed. Check its actual usage with:

```sql
SELECT DATE_TRUNC('day', START_TIME) AS DAY, SUM(CREDITS_USED) AS CREDITS
FROM SNOWFLAKE.ACCOUNT_USAGE.SERVERLESS_TASK_HISTORY
WHERE TASK_NAME = 'PROTECTED_ROLE_WATCH'
GROUP BY 1 ORDER BY 1 DESC;
```

To trade detection speed for cost, change the schedule, or suspend the task when you don't need alerts:

```sql
USE ROLE RBAC_EXPLORER_ROLE;
ALTER TASK RBAC_EXPLORER_DB.ALERTS.PROTECTED_ROLE_WATCH SUSPEND;
ALTER TASK RBAC_EXPLORER_DB.ALERTS.PROTECTED_ROLE_WATCH SET SCHEDULE = '15 MINUTE';
ALTER TASK RBAC_EXPLORER_DB.ALERTS.PROTECTED_ROLE_WATCH RESUME;
```

Re-running `setup/alerts.sql` resets the schedule to one minute.

## Testing a rule

- Run a check by hand without sending anything or changing state:
  `CALL RBAC_EXPLORER_DB.ALERTS.CHECK_PROTECTED_ROLES(TRUE);`
- Install the [demo scenario](INSTALL.md#optional-demo-scenario) and use **Try it: demo violation** in the
  Alerts tab to watch an alert arrive and resolve.
