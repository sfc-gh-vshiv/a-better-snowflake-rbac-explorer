-- Role Explorer: OPTIONAL Slack notifications (idempotent). Run as ACCOUNTADMIN after setup.sql.
--
--   snow sql -c <connection> -f setup/slack.sql -D slack_webhook_path=<T000/B000/XXXX>
--
-- slack_webhook_path is everything after https://hooks.slack.com/services/ in an
-- incoming-webhook URL created in your Slack workspace (Slack app > Incoming Webhooks).
-- Treat it as a password: it is stored in a Snowflake SECRET, never in this repo.
-- After running this, tick "Post to Slack" on any rule in the app's Alerts tab.
USE ROLE ACCOUNTADMIN;

CREATE SCHEMA IF NOT EXISTS RBAC_EXPLORER_DB.ALERTS;
CREATE OR REPLACE SECRET RBAC_EXPLORER_DB.ALERTS.SLACK_WEBHOOK_SECRET
  TYPE = GENERIC_STRING
  SECRET_STRING = '<% slack_webhook_path %>'
  COMMENT = 'Role Explorer: Slack incoming-webhook path';

CREATE NOTIFICATION INTEGRATION IF NOT EXISTS RBAC_EXPLORER_SLACK_INT
  TYPE = WEBHOOK
  ENABLED = TRUE
  WEBHOOK_URL = 'https://hooks.slack.com/services/SNOWFLAKE_WEBHOOK_SECRET'
  WEBHOOK_SECRET = RBAC_EXPLORER_DB.ALERTS.SLACK_WEBHOOK_SECRET
  WEBHOOK_HEADERS = ('Content-Type' = 'application/json')
  COMMENT = 'Role Explorer Slack alerts';

GRANT USAGE ON INTEGRATION RBAC_EXPLORER_SLACK_INT TO ROLE RBAC_EXPLORER_ROLE;
GRANT USAGE ON SECRET RBAC_EXPLORER_DB.ALERTS.SLACK_WEBHOOK_SECRET TO ROLE RBAC_EXPLORER_ROLE;
GRANT READ ON SECRET RBAC_EXPLORER_DB.ALERTS.SLACK_WEBHOOK_SECRET TO ROLE RBAC_EXPLORER_ROLE;
