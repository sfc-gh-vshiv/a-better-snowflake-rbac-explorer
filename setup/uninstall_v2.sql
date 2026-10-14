-- Roll Role Explorer back to v1: drop the v2 app, schema and alert rules, and restore the v1 watcher procedure.
--   snow sql -c <connection> -f setup/uninstall_v2.sql
-- AR_* access roles created by Apply are listed, not dropped: users may depend on them now. Drop them by hand.
USE ROLE RBAC_EXPLORER_ROLE;

SHOW ROLES LIKE 'AR\\_%';

DELETE FROM RBAC_EXPLORER_DB.ALERTS.WATCH_RULES WHERE KIND IN ('bundle_drift', 'bundle_broken');

-- Restore the v1 CHECK_PROTECTED_ROLES saved by setup/access.sql.
EXECUTE IMMEDIATE (SELECT DDL FROM RBAC_EXPLORER_DB.ACCESS.PROC_BACKUPS
                   WHERE NAME = 'CHECK_PROTECTED_ROLES' ORDER BY SAVED_AT LIMIT 1);
REMOVE @RBAC_EXPLORER_DB.ALERTS.CODE/asset_kinds.py;

DROP STREAMLIT IF EXISTS RBAC_EXPLORER_DB.APP.ROLE_EXPLORER_V2;
DROP SCHEMA IF EXISTS RBAC_EXPLORER_DB.ACCESS;

USE ROLE ACCOUNTADMIN;
REVOKE CREATE ROLE ON ACCOUNT FROM ROLE RBAC_EXPLORER_ROLE;
