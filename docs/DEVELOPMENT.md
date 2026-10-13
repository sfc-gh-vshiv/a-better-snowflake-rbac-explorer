# Development

## Project layout

```
streamlit_app.py          entry point: request router, async query runner, result cache
react_bridge.py           renders the React bundle inline with st.html and carries requests/responses
modules/
  connection.py           Snowpark session (Streamlit connection in Snowflake, named connection locally)
  model.py                RBAC model queries and payload builder
  ask.py                  Ask assistant prompt and AI_COMPLETE call
  alerts.py               alert rules, alert log, watcher status, demo scenario
  watch_kinds.py          custom alert kinds; also imported by the watcher procedure
frontend/src/
  index.tsx               app shell, tabs, version
  graph.ts                RBAC engine: closure, paths, effective privileges, access, what-if, hygiene
  tabs/*.tsx              one file per tab
  ask.tsx                 Ask panel
  kit.ts, ui.tsx, theme.ts  bridge client, shared components, colours
ui/sl_ui.js               built bundle (committed, so deploying needs no Node toolchain)
setup/*.sql               account setup, alerting objects, Slack, demo data, uninstall
deploy/deploy.sh          deploy and byte-verify the app
tests/                    unit, backend and browser smoke tests
.cortex/skills/           Cortex Code install skill
```

## Run locally

Running locally talks to your real Snowflake account with `RBAC_EXPLORER_ROLE`, so complete
[Steps 1 and 2 of the install](INSTALL.md) first.

```bash
# Python 3.11 environment with the same packages the container runtime uses
uv venv -p 3.11 .venv
uv pip install -p .venv/bin/python -r pyproject.toml pytest

# Build the UI
(cd frontend && npm install && npm run build)

# Start the app on http://localhost:8507
RBAC_CONNECTION=<connection> RBAC_WAREHOUSE=<WAREHOUSE> .venv/bin/streamlit run streamlit_app.py --server.port 8507
```

| Variable | Default | Meaning |
|---|---|---|
| `RBAC_CONNECTION` | `default` | Snowflake CLI connection name. |
| `RBAC_ROLE` | `RBAC_EXPLORER_ROLE` | Role the local session switches to, matching the deployed app. |
| `RBAC_WAREHOUSE` | `COMPUTE_WH` | Warehouse for local queries. |

After editing anything under `frontend/src`, run `npm run build` again; the running app picks up the new bundle
on the next page load. Python changes are picked up on the next rerun.

## Tests

```bash
(cd frontend && npm run typecheck)         # TypeScript
node tests/test_graph.mjs                  # RBAC engine on a synthetic account (no Snowflake needed)
.venv/bin/python -m pytest -q tests        # backend checks (no Snowflake needed)
```

The browser smoke tests drive the locally running app with Playwright. Point `CHROME` at a Chrome or Chromium
binary if Playwright cannot find one:

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node tests/smoke.mjs
node tests/smoke_layout.mjs     # panel collapse, full-screen graph
node tests/smoke_snap.mjs       # clicking a role pill pans the graph to that role
node tests/smoke_ask.mjs        # Ask assistant and a bot-drafted alert (calls AI_COMPLETE; creates and deletes one rule)
node tests/smoke_askexpand.mjs  # Ask panel expand / shrink
```

`APP_URL` overrides the default `http://localhost:8507`.

## Deploying changes

```bash
RX_WAREHOUSE=<WAREHOUSE> bash deploy/deploy.sh <connection>             # code and UI changes
RX_WAREHOUSE=<WAREHOUSE> bash deploy/deploy.sh <connection> --rebuild   # after changing pyproject.toml
```

If you change `setup/alerts.sql` or `modules/watch_kinds.py`, re-run `setup/alerts.sql` too; the deploy script
uploads `watch_kinds.py`, but the procedure body lives in `alerts.sql`.

Bump `VERSION` in `frontend/src/index.tsx` when you ship a UI change, so you can confirm which bundle is served
(`window.SnowUI.version` in the browser console).
