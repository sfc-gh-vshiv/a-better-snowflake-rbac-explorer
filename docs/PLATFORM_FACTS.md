# Platform facts (verified before building)

Each fact below was checked against the docs or a live account. The AI asset features rely on these and
nothing else.

## Cortex Agents

- **Agents run as the user's default role, not the session role.** Every caller needs a default role and a
  default warehouse with `USAGE`. If either is missing the call fails even when the current role has the
  privileges. ([Access control](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents-setup#user-requirements))
- Minimum for the default role: `USAGE` on the agent, its database and schema, and the default warehouse, plus
  `SNOWFLAKE.CORTEX_USER` or `SNOWFLAKE.CORTEX_AGENT_USER` (granted to `PUBLIC` by default).
- Tools need their own privileges on that same role:
  - Cortex Search: `USAGE` on the service and its containers.
  - Analyst: `USAGE` on the database and schema, plus the objects referenced by the semantic view. The agent
    generates SQL against the physical tables.
  - Custom tools: `USAGE` on the function or procedure. A procedure keeps owner's or caller's rights as defined.
  - Agent toolsets: `USAGE` on the referenced agent. If it's missing, the tool is silently skipped.
- With the default `tool_not_accessible: accept`, a missing tool privilege doesn't fail the run. The agent
  continues without the tool and reports a warning, so "it works for me" bugs show up as degraded answers.
- REST callers can override the role with the `X-Snowflake-Role` header.
- `DESCRIBE AGENT` returns `agent_spec` JSON. Tool resources live under `tool_resources.<tool>`:
  - Analyst: `semantic_view` (a fully qualified name)
  - Search: `search_service`
  - Custom tools: `identifier` plus `type` (`procedure` or `function`) and a `name` carrying the signature
  - All tools: `execution_environment.warehouse`, which can be empty
  - Agents can also reference `skills` (stage paths) and `mcp_servers`. (Verified live.)

## Semantic views

- Querying a semantic view directly needs only `SELECT` on the semantic view, not on its tables.
  ([Querying](https://docs.snowflake.com/en/user-guide/views-semantic/querying#privileges-required-to-query-a-semantic-view))
- Agents generate SQL against the physical tables, so an agent's Analyst tool needs privileges on the base
  tables too. ([Overview](https://docs.snowflake.com/en/user-guide/views-semantic/overview))
  - **Rule the app applies:** an SV reached directly needs `SELECT` on the SV only; an SV reached through an agent tool needs
    `SELECT` on the SV and its base tables.
- `DESCRIBE SEMANTIC VIEW` returns `BASE_TABLE_DATABASE_NAME`, `BASE_TABLE_SCHEMA_NAME` and `BASE_TABLE_NAME`
  rows per logical table. (Verified live.)

## ACCOUNT_USAGE gap for AI objects

- `ACCOUNT_USAGE.GRANTS_TO_ROLES` has no rows for `SEMANTIC_VIEW` or `CORTEX_AGENT` grants, even for objects
  that are a year old. Procedure and function grants are present. (Verified live.)
  - `SHOW GRANTS ON SEMANTIC VIEW` and `SHOW GRANTS ON AGENT` do return them, with `granted_on` values
    `SEMANTIC_VIEW` and `CORTEX_AGENT`.
  - So asset discovery reads these grants live and merges them into the browser model. Without that, every
    agent would look unusable.
- `ACCOUNT_USAGE.SEMANTIC_TABLES` maps each semantic view to its base tables account-wide, so it can be read
  without `DESCRIBE`.
- `DESCRIBE AGENT` works with `MONITOR` on the agent. `DESCRIBE PROCEDURE` shows `execute as` (`OWNER` or
  `CALLER`).

## Programmatic access tokens

- `SHOW USER PROGRAMMATIC ACCESS TOKENS FOR USER <u>` returns `name`, `role_restriction` (empty means no
  restriction), `expires_at` and `status`. (Verified live.)
- A PAT with a role restriction authenticates as that role only. The access gap must be evaluated against that
  role, not the user's full set of roles.

## Skills

- `SHOW CORTEX EXTENSIONS IN ACCOUNT` returned nothing in the test account, so the app can't rely on a skill catalog.
  - Instead, SKILL.md is read from a pasted text, a stage file or the app's Git repository stage.
- Cortex Code CLI tags its queries with `QUERY_TAG = {"app":"cortex_code_cli",...}`. Desktop and other clients
  don't tag theirs.
  - "Learn from the author" therefore filters `ACCESS_HISTORY` by user and time window, and optionally by that
    tag.
- `ACCOUNT_USAGE.ACCESS_HISTORY` is populated on Enterprise edition. If the view isn't available, the app
  turns the learned mode off.

## Procedures and functions

- Owner's-rights procedures run as the owner, so the caller needs only `USAGE` on the procedure (plus the
  warehouse).
- Caller's-rights procedures run as the caller, so the caller also needs every object the body touches.
