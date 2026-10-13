-- Role Explorer: remove everything setup/*.sql created. Run as ACCOUNTADMIN.
--
--   snow sql -c <connection> -f setup/uninstall.sql
--
-- Dropping the database removes the app, the alert tables, the alert log, the watcher task
-- and procedure, and the Slack secret. Account-level objects are dropped separately below.
USE ROLE ACCOUNTADMIN;

ALTER TASK IF EXISTS RBAC_EXPLORER_DB.ALERTS.PROTECTED_ROLE_WATCH SUSPEND;
DROP DATABASE IF EXISTS RBAC_EXPLORER_DB;

DROP INTEGRATION IF EXISTS RBAC_EXPLORER_EMAIL_INT;
DROP INTEGRATION IF EXISTS RBAC_EXPLORER_SLACK_INT;
DROP INTEGRATION IF EXISTS RBAC_EXPLORER_PYPI_EAI;
DROP ROLE IF EXISTS RBAC_EXPLORER_ROLE;

-- Optional demo objects (setup/demo_seed.sql)
DROP USER IF EXISTS DEMO_ANALYST_JANE;
DROP USER IF EXISTS DEMO_PIPELINE_SVC;
DROP ROLE IF EXISTS DEMO_PIPELINE_SVC_ROLE;
