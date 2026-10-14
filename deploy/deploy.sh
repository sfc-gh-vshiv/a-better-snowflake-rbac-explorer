#!/usr/bin/env bash
# Create (first time) or update the Role Explorer Streamlit app, then byte-verify what Snowflake serves.
#
# Usage:  deploy/deploy.sh [CONNECTION] [--rebuild]
#   CONNECTION  Snowflake CLI connection name (default: $SNOWFLAKE_CONNECTION or "default")
#   --rebuild   restart the container so it reinstalls pyproject.toml (only after changing dependencies)
#
# Settings (environment variables, all optional):
#   RX_WAREHOUSE     query warehouse for the app            (default COMPUTE_WH)
#   RX_COMPUTE_POOL  compute pool for the container runtime (default SYSTEM_COMPUTE_POOL_CPU)
#   RX_EAIS          external access integrations           (default RBAC_EXPLORER_PYPI_EAI)
#   RX_APP           fully-qualified app name               (default RBAC_EXPLORER_DB.APP.ROLE_EXPLORER)
#   RX_ARTIFACT_REPOS artifact repositories for packages, e.g. snowflake.snowpark.pypi_shared_repository
#                    (when set, no external access integration is attached)
set -euo pipefail
CONN=${1:-${SNOWFLAKE_CONNECTION:-default}}
WH=${RX_WAREHOUSE:-COMPUTE_WH}
POOL=${RX_COMPUTE_POOL:-SYSTEM_COMPUTE_POOL_CPU}
EAIS=${RX_EAIS:-RBAC_EXPLORER_PYPI_EAI}
APP=${RX_APP:-RBAC_EXPLORER_DB.APP.ROLE_EXPLORER}
REPOS=${RX_ARTIFACT_REPOS:-}
if [ -n "$REPOS" ]; then PKGS="ARTIFACT_REPOSITORIES = ($REPOS)"; else PKGS="EXTERNAL_ACCESS_INTEGRATIONS = ($EAIS)"; fi
STAGE=@RBAC_EXPLORER_DB.APP.ROLE_EXPLORER_STAGE/${APP##*.}
DIR="$(cd "$(dirname "$0")/.." && pwd)"
FILES=(streamlit_app.py react_bridge.py pyproject.toml modules/__init__.py modules/connection.py
       modules/model.py modules/alerts.py modules/ask.py modules/watch_kinds.py modules/asset_kinds.py modules/access.py
       ui/sl_ui.js .streamlit/config.toml)
sql() { snow sql -c "$CONN" -q "USE ROLE RBAC_EXPLORER_ROLE; $1" "${@:2}"; }

cd "$DIR"
# Rebuild the UI bundle when the frontend toolchain is installed; otherwise ship the committed ui/sl_ui.js.
if [ -d frontend/node_modules ]; then ( cd frontend && npm run -s build >/dev/null ); fi
for f in "${FILES[@]}"; do
  case "$f" in *secrets.toml*) echo "refusing to upload $f" >&2; exit 1;; esac
  d=$(dirname "$f"); [ "$d" = "." ] && d=""
  snow stage copy "$f" "$STAGE/$d" --overwrite -c "$CONN" >/dev/null
done
sql "CREATE STREAMLIT IF NOT EXISTS $APP FROM '$STAGE' MAIN_FILE = 'streamlit_app.py'
  QUERY_WAREHOUSE = $WH RUNTIME_NAME = 'SYSTEM\$ST_CONTAINER_RUNTIME_PY3_11' COMPUTE_POOL = $POOL
  $PKGS
  TITLE = 'Role Explorer' COMMENT = 'RBAC graph, access analysis and protected-role alerts';" >/dev/null
sql "ALTER STREAMLIT $APP ADD LIVE VERSION FROM LAST;" >/dev/null 2>&1 || true
sql "ALTER STREAMLIT $APP SET $PKGS;" >/dev/null
# The watcher procedure imports the same detection code the app uses for previews.
snow stage copy modules/watch_kinds.py @RBAC_EXPLORER_DB.ALERTS.CODE --overwrite -c "$CONN" >/dev/null
snow stage copy modules/asset_kinds.py @RBAC_EXPLORER_DB.ALERTS.CODE --overwrite -c "$CONN" >/dev/null

LIVE="snow://streamlit/$APP/versions/live"
for f in "${FILES[@]}"; do
  d=$(dirname "$f"); [ "$d" = "." ] && d=""
  snow stage copy "$f" "$LIVE/$d" --overwrite -c "$CONN" >/dev/null
done
sql "ALTER STREAMLIT $APP COMMIT;" >/dev/null
# Keep a live copy for the next deploy (fails harmlessly if one already exists).
sql "ALTER STREAMLIT $APP ADD LIVE VERSION FROM LAST;" >/dev/null 2>&1 || true

SERVED=$(sql "DESCRIBE STREAMLIT $APP;" --format json |
  python3 -c 'import json,sys; d=json.load(sys.stdin); d=d[-1] if isinstance(d[0],list) else d; print(d[0]["default_version_name"], d[0]["default_version_location_uri"])')
echo "serving ${SERVED%% *}"
# Code changes go live on the next rerun, but the container only reinstalls pyproject.toml when it is
# rebuilt ("End session" restarts just the process). Pass --rebuild after changing dependencies.
if [ "${2:-}" = "--rebuild" ]; then
  sql "ALTER STREAMLIT $APP SET RUNTIME_NAME = 'SYSTEM\$WAREHOUSE_RUNTIME';" >/dev/null
  sql "ALTER STREAMLIT $APP SET RUNTIME_NAME = 'SYSTEM\$ST_CONTAINER_RUNTIME_PY3_11' COMPUTE_POOL = $POOL
  $PKGS;" >/dev/null
  echo "container rebuild requested (takes a few minutes on next view)"
fi
TMP=$(mktemp -d)
snow stage copy "${SERVED#* }" "$TMP" --recursive -c "$CONN" >/dev/null
rc=0
for f in "${FILES[@]}"; do
  if cmp -s "$TMP/$f" "$f"; then echo "match $f"; else echo "DIFF  $f"; rc=1; fi
done
rm -rf "$TMP"
echo "open: Snowsight > Projects > Streamlit > Role Explorer (role RBAC_EXPLORER_ROLE)"
exit $rc
