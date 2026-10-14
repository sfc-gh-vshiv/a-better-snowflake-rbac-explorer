---
name: request-access
description: Request access to an AI asset (Cortex Agent, semantic view, custom tool or skill) that Role Explorer has mapped. Use when a Snowflake query or agent call fails with insufficient privileges, an agent answers without one of its tools, or someone asks "how do I get access to X". Triggers: request access, I can't use this agent, insufficient privileges on agent, missing access, access denied semantic view.
---

# Request access through Role Explorer

Role Explorer keeps a catalog of AI assets and every grant each one needs. Admins review requests in the
app (Assets > Access requests) and can grant a least-privilege access role in one step.

## 1. Find the asset

```sql
SELECT ID, KIND, FQN, ARRAY_SIZE(NEEDS) AS GRANTS
FROM RBAC_EXPLORER_DB.ACCESS.BUNDLE_CATALOG
WHERE FQN ILIKE '%<name the user mentioned>%';
```

If nothing matches, tell the user the asset hasn't been mapped yet and to ask their Snowflake admin to
open it in Role Explorer > AI assets and save it. Stop there.

## 2. Show what's needed, and what the user is missing

List `NEEDS` for the chosen row. Then check the user's default role, because agents run with the
default role and default warehouse, not the session role:

```sql
SELECT CURRENT_USER(), CURRENT_ROLE();
SHOW GRANTS TO ROLE <the user's default role>;
```

Compare the two and name the missing grants in plain language. Don't run any GRANT yourself.

## 3. File the request

Ask which role the access should go to (usually their team's functional role) and why they need it.
Then:

```sql
CALL RBAC_EXPLORER_DB.ACCESS.FILE_REQUEST('<bundle id>', '<target role>', '<one-line justification>');
```

Tell the user the procedure's reply verbatim, and that an admin will review it in Role Explorer.

## Rules

- Never run GRANT, REVOKE or CREATE ROLE. Only `SELECT` from BUNDLE_CATALOG and `CALL FILE_REQUEST`.
- File one request per asset. The procedure rejects duplicates while one is pending.
- Don't guess object names. Only use IDs returned by BUNDLE_CATALOG.
