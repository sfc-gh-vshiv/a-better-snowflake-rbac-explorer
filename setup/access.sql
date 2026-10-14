-- Role Explorer v2: access bundles, gated apply, access requests (idempotent). Run after setup.sql and alerts.sql.
--   snow sql -c <connection> -f setup/access.sql -D warehouse=<WAREHOUSE> -D requester_role=PUBLIC
-- Then re-run setup/alerts.sql so the watcher picks up the bundle_drift / bundle_broken alert kinds.
-- Roll back with setup/uninstall_v2.sql (v1 keeps working throughout).
USE ROLE ACCOUNTADMIN;

-- Apply creates AR_<asset> access roles. MANAGE GRANTS (already held) covers the GRANT statements.
GRANT CREATE ROLE ON ACCOUNT TO ROLE RBAC_EXPLORER_ROLE;

USE ROLE RBAC_EXPLORER_ROLE;
USE WAREHOUSE IDENTIFIER('<% warehouse %>');
CREATE SCHEMA IF NOT EXISTS RBAC_EXPLORER_DB.ACCESS COMMENT = 'Role Explorer v2: access bundles and requests';
USE SCHEMA RBAC_EXPLORER_DB.ACCESS;

-- Rollback point: the v1 watcher procedure, saved once before alerts.sql replaces it with the v2 version.
CREATE TABLE IF NOT EXISTS PROC_BACKUPS (NAME STRING, DDL STRING, SAVED_AT TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP());
INSERT INTO PROC_BACKUPS (NAME, DDL)
  SELECT 'CHECK_PROTECTED_ROLES', GET_DDL('PROCEDURE', 'RBAC_EXPLORER_DB.ALERTS.CHECK_PROTECTED_ROLES(BOOLEAN)')
  WHERE NOT EXISTS (SELECT 1 FROM PROC_BACKUPS WHERE NAME = 'CHECK_PROTECTED_ROLES');

-- One row per saved bundle. ITEMS is always produced by the app's own discovery (modules/asset_kinds.py);
-- SOURCE keeps the discovery inputs so the bundle can be rebuilt and checked for drift.
CREATE TABLE IF NOT EXISTS BUNDLES (
  ID         STRING DEFAULT UUID_STRING(),
  KIND       STRING NOT NULL,
  FQN        STRING NOT NULL,
  SOURCE     VARIANT,
  ITEMS      VARIANT,
  TREE       VARIANT,
  HASH       STRING,
  AR_ROLE    STRING,
  CREATED_BY STRING,
  CREATED_AT TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
  UPDATED_AT TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP()
);

CREATE TABLE IF NOT EXISTS SETTINGS (K STRING, V VARIANT, UPDATED_BY STRING, UPDATED_AT TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP());
INSERT INTO SETTINGS (K, V, UPDATED_BY)
  SELECT 'APPLY_ENABLED', FALSE::VARIANT, CURRENT_USER() WHERE NOT EXISTS (SELECT 1 FROM SETTINGS WHERE K = 'APPLY_ENABLED');

-- Every statement the app runs on someone's behalf, with its result. Revert reads PRE to undo only what changed.
CREATE TABLE IF NOT EXISTS APPLY_LOG (
  ID           STRING DEFAULT UUID_STRING(),
  BUNDLE_ID    STRING,
  REQUEST_ID   STRING,
  AR_ROLE      STRING,
  TARGET_ROLE  STRING,
  STATEMENTS   ARRAY,
  RESULTS      VARIANT,
  PRE          VARIANT,
  STATUS       STRING,
  APPLIED_BY   STRING,
  APPLIED_AT   TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
  REVERTED_BY  STRING,
  REVERTED_AT  TIMESTAMP_LTZ
);

CREATE TABLE IF NOT EXISTS REQUESTS (
  ID            STRING DEFAULT UUID_STRING(),
  BUNDLE_ID     STRING NOT NULL,
  REQUESTER     STRING,
  TARGET_ROLE   STRING,
  JUSTIFICATION STRING,
  STATUS        STRING DEFAULT 'PENDING',
  DECIDED_BY    STRING,
  DECIDED_AT    TIMESTAMP_LTZ,
  NOTE          STRING,
  APPLY_LOG_ID  STRING,
  CREATED_AT    TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP()
);

-- What requesters can see: asset names and what they need, never who else holds them.
CREATE OR REPLACE SECURE VIEW BUNDLE_CATALOG AS
  SELECT b.ID, b.KIND, b.FQN, b.AR_ROLE, b.UPDATED_AT,
         ARRAY_AGG(OBJECT_CONSTRUCT('type', i.value:otype, 'name', i.value:fqn, 'privilege', i.value:priv)) AS NEEDS
  FROM BUNDLES b, LATERAL FLATTEN(b.ITEMS) i
  WHERE COALESCE(i.value:suggested::BOOLEAN, FALSE) = FALSE OR COALESCE(i.value:on::BOOLEAN, FALSE)
  GROUP BY 1, 2, 3, 4, 5;

-- The only write a requester can make: a PENDING request for themselves. Owner's rights, so callers need
-- no privileges on the table. CURRENT_USER() is the caller, not the owner.
CREATE OR REPLACE PROCEDURE FILE_REQUEST(BUNDLE_ID STRING, TARGET_ROLE STRING, JUSTIFICATION STRING)
  RETURNS STRING LANGUAGE SQL EXECUTE AS OWNER
AS
$$
DECLARE n INT; rid STRING;
BEGIN
  SELECT COUNT(*) INTO :n FROM RBAC_EXPLORER_DB.ACCESS.BUNDLES WHERE ID = :BUNDLE_ID;
  IF (n = 0) THEN RETURN 'Unknown bundle. Ask an admin to save it in Role Explorer first.'; END IF;
  SELECT COUNT(*) INTO :n FROM RBAC_EXPLORER_DB.ACCESS.REQUESTS
    WHERE BUNDLE_ID = :BUNDLE_ID AND REQUESTER = CURRENT_USER() AND STATUS = 'PENDING';
  IF (n > 0) THEN RETURN 'You already have a pending request for this asset.'; END IF;
  rid := UUID_STRING();
  INSERT INTO RBAC_EXPLORER_DB.ACCESS.REQUESTS (ID, BUNDLE_ID, REQUESTER, TARGET_ROLE, JUSTIFICATION)
    VALUES (:rid, :BUNDLE_ID, CURRENT_USER(), LEFT(:TARGET_ROLE, 255), LEFT(:JUSTIFICATION, 2000));
  RETURN 'Request ' || rid || ' filed. An admin will review it in Role Explorer.';
END;
$$;

GRANT USAGE ON DATABASE RBAC_EXPLORER_DB TO ROLE IDENTIFIER('<% requester_role %>');
GRANT USAGE ON SCHEMA RBAC_EXPLORER_DB.ACCESS TO ROLE IDENTIFIER('<% requester_role %>');
GRANT SELECT ON VIEW RBAC_EXPLORER_DB.ACCESS.BUNDLE_CATALOG TO ROLE IDENTIFIER('<% requester_role %>');
GRANT USAGE ON PROCEDURE RBAC_EXPLORER_DB.ACCESS.FILE_REQUEST(STRING, STRING, STRING) TO ROLE IDENTIFIER('<% requester_role %>');
