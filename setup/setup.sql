-- Role Explorer: account setup (idempotent). Run as ACCOUNTADMIN.
--
--   snow sql -c <connection> -f setup/setup.sql \
--     -D admin_user=<YOUR_USER> -D warehouse=<WAREHOUSE> -D alert_email=<you@company.com>
--
--   admin_user   Snowflake user who gets RBAC_EXPLORER_ROLE (to deploy and use the app)
--   warehouse    existing warehouse the app and the watcher task use for queries
--   alert_email  verified email of a user in this account; alert emails may only go to
--                addresses listed in the email integration's ALLOWED_RECIPIENTS
--
-- RBAC_EXPLORER_ROLE holds MANAGE GRANTS so the protected-role watcher can run
-- SHOW GRANTS OF ROLE on any role (and, only if a rule opts in, revoke). Grant this
-- role to security administrators only.
USE ROLE ACCOUNTADMIN;

CREATE ROLE IF NOT EXISTS RBAC_EXPLORER_ROLE
  COMMENT = 'Role Explorer app owner: reads RBAC metadata and runs protected-role alerts';
GRANT ROLE RBAC_EXPLORER_ROLE TO ROLE ACCOUNTADMIN;
GRANT ROLE RBAC_EXPLORER_ROLE TO USER IDENTIFIER('<% admin_user %>');

-- Metadata access (SNOWFLAKE.ACCOUNT_USAGE views and live SHOW GRANTS)
GRANT DATABASE ROLE SNOWFLAKE.SECURITY_VIEWER   TO ROLE RBAC_EXPLORER_ROLE;
GRANT DATABASE ROLE SNOWFLAKE.GOVERNANCE_VIEWER TO ROLE RBAC_EXPLORER_ROLE;
GRANT MANAGE GRANTS ON ACCOUNT TO ROLE RBAC_EXPLORER_ROLE;

-- Cortex AI functions for the Ask assistant and alert drafting
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE RBAC_EXPLORER_ROLE;

-- Compute and tasks
GRANT USAGE ON WAREHOUSE IDENTIFIER('<% warehouse %>') TO ROLE RBAC_EXPLORER_ROLE;
GRANT EXECUTE TASK ON ACCOUNT TO ROLE RBAC_EXPLORER_ROLE;
GRANT EXECUTE MANAGED TASK ON ACCOUNT TO ROLE RBAC_EXPLORER_ROLE;
-- Streamlit container runtime
GRANT USAGE ON COMPUTE POOL SYSTEM_COMPUTE_POOL_CPU TO ROLE RBAC_EXPLORER_ROLE;

-- Email notifications
CREATE NOTIFICATION INTEGRATION IF NOT EXISTS RBAC_EXPLORER_EMAIL_INT
  TYPE = EMAIL ENABLED = TRUE
  ALLOWED_RECIPIENTS = ('<% alert_email %>')
  COMMENT = 'Role Explorer alert emails';
GRANT USAGE ON INTEGRATION RBAC_EXPLORER_EMAIL_INT TO ROLE RBAC_EXPLORER_ROLE;

-- The container runtime installs pyproject.toml dependencies from PyPI, so it needs egress.
CREATE EXTERNAL ACCESS INTEGRATION IF NOT EXISTS RBAC_EXPLORER_PYPI_EAI
  ALLOWED_NETWORK_RULES = (SNOWFLAKE.EXTERNAL_ACCESS.PYPI_RULE)
  ENABLED = TRUE
  COMMENT = 'Role Explorer: PyPI access for the Streamlit container runtime';
GRANT USAGE ON INTEGRATION RBAC_EXPLORER_PYPI_EAI TO ROLE RBAC_EXPLORER_ROLE;

-- App database
CREATE DATABASE IF NOT EXISTS RBAC_EXPLORER_DB COMMENT = 'Role Explorer app + alerts';
GRANT OWNERSHIP ON DATABASE RBAC_EXPLORER_DB TO ROLE RBAC_EXPLORER_ROLE COPY CURRENT GRANTS;

USE ROLE RBAC_EXPLORER_ROLE;
USE WAREHOUSE IDENTIFIER('<% warehouse %>');
CREATE SCHEMA IF NOT EXISTS RBAC_EXPLORER_DB.APP;
CREATE SCHEMA IF NOT EXISTS RBAC_EXPLORER_DB.ALERTS;
CREATE STAGE IF NOT EXISTS RBAC_EXPLORER_DB.APP.ROLE_EXPLORER_STAGE
  DIRECTORY = (ENABLE = TRUE) COMMENT = 'Role Explorer source';
