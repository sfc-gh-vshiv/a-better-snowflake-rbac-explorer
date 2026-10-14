# AI asset access

Someone builds a Cortex Agent, a semantic view or a Cortex Code skill. It works for them. A teammate tries it
and gets an error, or worse, an answer that is missing half its data. The **AI assets** tab answers three
questions for an admin:

1. **What does this asset need?** Every grant, found by walking the asset down to its data.
2. **Who can use it right now?** For a person, a team role, or an AI tool signing in with a token.
3. **What's the smallest change that fixes it?** One least-privilege access role, shown as SQL. You can also
   apply it from the app, with a log and an undo.

Setup: [Installation, step 4](INSTALL.md#step-4-ai-asset-access). Platform behaviour this relies on, with
sources: [V2_FACTS.md](V2_FACTS.md).

## Discovery

Pick an asset. Role Explorer reads its definition with live `DESCRIBE` and `SHOW` commands and builds a
tree, layer by layer:

| Layer | What it reads | What it adds |
|---|---|---|
| Agent | `DESCRIBE AGENT` spec: `tool_resources`, skills, MCP servers | `USAGE` on the agent, `CORTEX_USER` or `CORTEX_AGENT_USER`, each tool's warehouse, and one child per tool |
| Semantic view | `DESCRIBE SEMANTIC VIEW` base tables | `SELECT` on the view. Its base tables are added only when an agent uses it: querying a semantic view directly needs `SELECT` on the view alone, but an agent's generated SQL reads the tables. |
| Custom tool | `DESCRIBE PROCEDURE` or `FUNCTION`: `execute as`, body | `USAGE` with the exact signature. For caller's-rights procedures, every table or view named in the body. |
| Search service | the service name | `USAGE` on it |
| Skill | the pasted `SKILL.md`, optionally the author's `ACCESS_HISTORY` | Every fully qualified name and warehouse in the text, resolved to its real type. Objects the author touched but the skill doesn't mention are marked **suggested** and stay off until you tick them. |

Every object then gets `USAGE` on its database and schema. Each item carries its current grantees, read
live with `SHOW GRANTS ON`. That matters because `ACCOUNT_USAGE.GRANTS_TO_ROLES` has no rows for semantic
view or agent grants, and lags up to two hours for everything else.

Untick anything you don't want in the bundle, then **Save bundle**. The server reruns discovery before saving,
so stored bundles only ever contain what discovery found; your ticks only switch items on or off.

## Can they use it?

- **A person or AI tool.** Pick a user. The app walks their roles live (`SHOW GRANTS TO USER`, then down
  through each role) and checks the bundle the way the asset will actually run:
  - **Default role.** Cortex Agents run with the caller's default role and default warehouse, not the role
    active in the session. A user can open an agent as one role and still be blocked when they ask it a
    question.
  - **All roles.** What a worksheet session with secondary roles can do.
  - **PAT.** A programmatic access token with a role restriction authenticates as that role only, so an AI
    tool using it may be blocked even when its owner isn't.
- **A whole team.** Pick a role and every holder is checked (from `ACCOUNT_USAGE`).

**Partly works** means the asset itself is reachable but something underneath isn't. An agent with a missing
tool privilege still answers, without that tool, by default (`tool_not_accessible: accept`). That is the usual
"it works for me" bug.

## The fix

The SQL creates one access role per asset, `AR_<asset>`, grants it exactly the bundle, rolls it up to
`SYSADMIN`, and grants it to the functional role your team already uses. Revoking that last grant undoes the
whole change. The server generates the SQL from the saved bundle, never from text sent by the browser.

**Apply** is off by default (**AI assets > Settings**). When it's on:

- the server regenerates the SQL and runs it only if it matches, byte for byte, what you reviewed;
- every statement must match an allowlist: `CREATE ROLE AR_*`, `GRANT SELECT | USAGE | READ ... TO ROLE AR_*`,
  `GRANT DATABASE ROLE SNOWFLAKE.CORTEX_[AGENT_]USER TO ROLE AR_*`, `GRANT ROLE AR_* TO ROLE ...`;
- the target can't be a system role, a protected role from the Alerts tab, `RBAC_EXPLORER_ROLE` or another
  `AR_*` role;
- each run is written to `RBAC_EXPLORER_DB.ACCESS.APPLY_LOG` with its result;
- **Revert** revokes the access role from the target, but only if that apply granted it. The access role
  itself is kept, so nothing else that depends on it breaks.

## Requests

Users ask for access without needing to know what to ask for:

- in the app, **AI assets > Access requests**;
- from SQL, or from Cortex Code with the bundled [request-access skill](../skills/request-access/SKILL.md):

  ```sql
  SELECT ID, FQN, NEEDS FROM RBAC_EXPLORER_DB.ACCESS.BUNDLE_CATALOG;
  CALL RBAC_EXPLORER_DB.ACCESS.FILE_REQUEST('<bundle id>', '<role>', '<why>');
  ```

`FILE_REQUEST` runs with owner's rights and can only insert a `PENDING` request for the caller, one per asset.
`BUNDLE_CATALOG` lists what each asset needs, never who holds it. Admins **Review SQL**, then apply,
**Approve** (and run the SQL themselves), or **Reject**. Requests don't send email yet, so check the queue.

## Keeping it working

From a saved bundle, add either alert. Both run in the existing one-minute watcher and are listed under
**Alerts**.

| Alert | Fires when | Example |
|---|---|---|
| AI asset drift | discovery finds a dependency the bundle didn't have | a procedure now also reads `REGION_TARGETS` |
| Access role broken | `AR_<asset>` no longer holds a grant from the bundle | someone revoked `SELECT` on `ORDERS`, or the agent was recreated without `COPY GRANTS` |

## What the app needs

- `CREATE ROLE` on the account, granted by `setup/access.sql`, for the access roles. `MANAGE GRANTS`, which
  the role already holds, covers the grants.
- `MONITOR` on each agent and `REFERENCES` (or `MONITOR`) on each semantic view you want to analyse, so that
  `DESCRIBE` works. The asset lists show only what `RBAC_EXPLORER_ROLE` can see.
- Enterprise edition for *learn from the author* (`ACCOUNT_USAGE.ACCESS_HISTORY`).

## Limitations

- MCP server tools, semantic model files on stages and objects that functions read aren't walked. The tree
  shows a warning for each.
- Overloaded procedures without a signature in the agent spec resolve to the first match.
- Team checks use `ACCOUNT_USAGE` (up to two hours behind). Person checks are live.
- Requests aren't emailed to admins yet.
