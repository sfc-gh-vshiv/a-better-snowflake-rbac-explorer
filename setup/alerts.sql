-- Role Explorer: protected-role alerting (idempotent). Run after setup.sql.
--   snow sql -c <connection> -f setup/alerts.sql -D warehouse=<WAREHOUSE>
--
-- A protected role may only be held by allowlisted users (and/or users of one
-- TYPE, e.g. SERVICE) and may only be granted to allowlisted parent roles.
-- ACCOUNT_USAGE lags up to ~2h, so the watcher reads live SHOW GRANTS OF ROLE
-- every minute and attributes each grant via INFORMATION_SCHEMA.QUERY_HISTORY.
USE ROLE RBAC_EXPLORER_ROLE;
USE WAREHOUSE IDENTIFIER('<% warehouse %>');
USE SCHEMA RBAC_EXPLORER_DB.ALERTS;

CREATE TABLE IF NOT EXISTS PROTECTED_ROLES (
  ROLE_NAME            STRING NOT NULL PRIMARY KEY,
  ALLOWED_USERS        ARRAY,            -- NULL = any user name (type rule still applies)
  ALLOWED_USER_TYPE    STRING,           -- SERVICE | PERSON | LEGACY_SERVICE | NULL = any
  ALLOWED_PARENT_ROLES ARRAY,            -- NULL = not checked, [] = no role may inherit it
  NOTIFY_EMAIL         STRING,
  NOTIFY_SLACK         BOOLEAN DEFAULT FALSE,
  AUTO_REVOKE          BOOLEAN DEFAULT FALSE,
  ENABLED              BOOLEAN DEFAULT TRUE,
  NOTE                 STRING,
  CREATED_BY           STRING,
  CREATED_AT           TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
  UPDATED_AT           TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP()
);

CREATE TABLE IF NOT EXISTS ALERT_LOG (
  ID              STRING DEFAULT UUID_STRING(),
  DETECTED_AT     TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
  ROLE_NAME       STRING,
  GRANTEE_TYPE    STRING,              -- USER | ROLE
  GRANTEE         STRING,
  GRANTEE_USER_TYPE STRING,
  REASON          STRING,
  GRANTED_AT      TIMESTAMP_LTZ,
  GRANTED_BY_ROLE STRING,
  GRANTED_BY_USER STRING,
  QUERY_ID        STRING,
  QUERY_TEXT      STRING,
  NOTIFIED        STRING,
  ACTION          STRING,              -- ALERTED | REVOKED | REVOKE_FAILED
  STATUS          STRING DEFAULT 'OPEN', -- OPEN | ACKED | RESOLVED
  RESOLVED_AT     TIMESTAMP_LTZ,
  ACK_BY          STRING,
  ACK_AT          TIMESTAMP_LTZ
);

CREATE TABLE IF NOT EXISTS WATCH_STATE (
  ID INT, LAST_RUN TIMESTAMP_LTZ, RULES INT, NEW_ALERTS INT, OPEN_ALERTS INT, MS INT, ERROR STRING
);
ALTER TABLE ALERT_LOG ADD COLUMN IF NOT EXISTS GRANTED_BY_CANDIDATES STRING;  -- users holding the granting role
ALTER TABLE ALERT_LOG ADD COLUMN IF NOT EXISTS ATTRIB_TRIED_AT TIMESTAMP_LTZ;
-- IF NOT EXISTS with a DEFAULT errors ("ambiguous column name") once the column exists, so tolerate that.
EXECUTE IMMEDIATE $$
BEGIN
  ALTER TABLE ALERT_LOG ADD COLUMN IF NOT EXISTS KIND STRING DEFAULT 'protected_role';
EXCEPTION WHEN OTHER THEN NULL;
END;
$$;
ALTER TABLE ALERT_LOG ADD COLUMN IF NOT EXISTS RULE_ID STRING;
ALTER TABLE ALERT_LOG ADD COLUMN IF NOT EXISTS DETAIL VARIANT;

-- Custom alert kinds (admin_holders | sensitive_privilege | new_principal), see
-- modules/watch_kinds.py. BASELINE = keys already present, so only changes alert.
CREATE TABLE IF NOT EXISTS WATCH_RULES (
  ID           STRING DEFAULT UUID_STRING(),
  KIND         STRING NOT NULL,
  NAME         STRING,
  SPEC         VARIANT,
  BASELINE     ARRAY,
  NOTIFY_EMAIL STRING,
  NOTIFY_SLACK BOOLEAN DEFAULT FALSE,
  ENABLED      BOOLEAN DEFAULT TRUE,
  NOTE         STRING,
  CREATED_BY   STRING,
  CREATED_AT   TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
  UPDATED_AT   TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP()
);

-- Shared detection code; deploy/deploy.sh uploads modules/watch_kinds.py here.
CREATE STAGE IF NOT EXISTS CODE;
PUT 'file://modules/watch_kinds.py' @CODE AUTO_COMPRESS = FALSE OVERWRITE = TRUE;
PUT 'file://modules/asset_kinds.py' @CODE AUTO_COMPRESS = FALSE OVERWRITE = TRUE;

CREATE OR REPLACE PROCEDURE CHECK_PROTECTED_ROLES(DRY_RUN BOOLEAN DEFAULT FALSE)
  RETURNS VARIANT
  LANGUAGE PYTHON
  RUNTIME_VERSION = '3.11'
  PACKAGES = ('snowflake-snowpark-python')
  IMPORTS = ('@RBAC_EXPLORER_DB.ALERTS.CODE/watch_kinds.py', '@RBAC_EXPLORER_DB.ALERTS.CODE/asset_kinds.py')
  HANDLER = 'main'
  COMMENT = 'Role Explorer: protected roles + custom alert kinds; notify and optionally revoke'
  EXECUTE AS CALLER
AS
$$
import datetime
import html
import json
import re
import time

import watch_kinds as wk

DB = "RBAC_EXPLORER_DB.ALERTS"
EMAIL_INT = "RBAC_EXPLORER_EMAIL_INT"
SLACK_INT = "RBAC_EXPLORER_SLACK_INT"  # optional: setup/slack.sql


def q(name):
    return '"' + str(name).replace('"', '""') + '"'


def lit(s):
    return "'" + str(s).replace("\\", "\\\\").replace("'", "''") + "'"


def show(session, cmd):
    return [{k.lower(): v for k, v in r.as_dict().items()} for r in session.sql(cmd).collect()]


def arr(v):
    if v is None:
        return None
    return [str(x).upper() for x in (json.loads(v) if isinstance(v, str) else v)]


def attribute(session, role, grantee, granted_at):
    """Best-effort: the GRANT statement behind this grant (user, role, query id)."""
    if not granted_at:
        return {}
    ts = f"TO_TIMESTAMP_LTZ(TO_TIMESTAMP_TZ({lit(granted_at.isoformat())}))"
    sql = f"""
      SELECT USER_NAME, ROLE_NAME, QUERY_ID, LEFT(QUERY_TEXT, 400) AS QUERY_TEXT
      FROM TABLE(SNOWFLAKE.INFORMATION_SCHEMA.QUERY_HISTORY(
             END_TIME_RANGE_START => DATEADD('minute', -3, {ts}),
             END_TIME_RANGE_END   => DATEADD('minute',  3, {ts}),
             RESULT_LIMIT => 10000))
      WHERE QUERY_TYPE = 'GRANT' AND EXECUTION_STATUS = 'SUCCESS'
        AND QUERY_TEXT ILIKE ? AND QUERY_TEXT ILIKE ?
      ORDER BY ABS(DATEDIFF('millisecond', START_TIME, {ts}))
      LIMIT 1"""
    try:
        rows = session.sql(sql, params=[f"%{role}%", f"%{grantee}%"]).collect()
    except Exception as e:
        return {"error": str(e)[:200]}
    if not rows:
        return {}
    r = rows[0]
    return {"user": r["USER_NAME"], "role": r["ROLE_NAME"], "query_id": r["QUERY_ID"], "text": r["QUERY_TEXT"]}


def role_holders(session, role):
    """Users who hold the granting role directly: the likely granters, known instantly."""
    if not role:
        return None
    try:
        names = [g.get("grantee_name") for g in show(session, f"SHOW GRANTS OF ROLE {q(role)}") if g.get("granted_to") == "USER"]
    except Exception:
        return None
    return ", ".join(sorted(names)[:10]) + (" …" if len(names) > 10 else "") if names else None


def backfill(session):
    """Name the exact user and statement from ACCOUNT_USAGE.QUERY_HISTORY (lags ~45 min).
    INFORMATION_SCHEMA.QUERY_HISTORY only shows the caller's own GRANTs (they use no
    warehouse), so a task can't see them there. Each row is retried at most every 10 min."""
    rows = session.sql(f"""SELECT ID, ROLE_NAME, GRANTEE, GRANTED_AT FROM {DB}.ALERT_LOG
        WHERE GRANTED_BY_USER IS NULL AND GRANTED_AT IS NOT NULL AND DETECTED_AT > DATEADD('day', -2, CURRENT_TIMESTAMP())
          AND (ATTRIB_TRIED_AT IS NULL OR ATTRIB_TRIED_AT < DATEADD('minute', -10, CURRENT_TIMESTAMP())) LIMIT 20""").collect()
    done = 0
    for r in rows:
        hit = session.sql("""SELECT USER_NAME, ROLE_NAME, QUERY_ID, LEFT(QUERY_TEXT, 400) FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
            WHERE START_TIME BETWEEN DATEADD('minute', -3, TO_TIMESTAMP_LTZ(TO_TIMESTAMP_TZ(?))) AND DATEADD('minute', 3, TO_TIMESTAMP_LTZ(TO_TIMESTAMP_TZ(?)))
              AND QUERY_TYPE = 'GRANT' AND EXECUTION_STATUS = 'SUCCESS' AND QUERY_TEXT ILIKE ? AND QUERY_TEXT ILIKE ?
            ORDER BY ABS(DATEDIFF('millisecond', START_TIME, TO_TIMESTAMP_LTZ(TO_TIMESTAMP_TZ(?)))) LIMIT 1""",
            params=[r["GRANTED_AT"].isoformat(), r["GRANTED_AT"].isoformat(), f"%{r['ROLE_NAME']}%", f"%{r['GRANTEE']}%", r["GRANTED_AT"].isoformat()]).collect()
        if hit:
            h = hit[0]
            session.sql(f"""UPDATE {DB}.ALERT_LOG SET GRANTED_BY_USER = ?, GRANTED_BY_ROLE = ?, QUERY_ID = ?, QUERY_TEXT = ?,
                ATTRIB_TRIED_AT = CURRENT_TIMESTAMP() WHERE ID = ?""", params=[h[0], h[1], h[2], h[3], r["ID"]]).collect()
            done += 1
        else:
            session.sql(f"UPDATE {DB}.ALERT_LOG SET ATTRIB_TRIED_AT = CURRENT_TIMESTAMP() WHERE ID = ?", params=[r["ID"]]).collect()
    return done


# Notification look: the app's palette (Snowflake blue + slate), compact and scannable.
INK, MUTE, LINE, SF, SF_D = "#0f172a", "#64748b", "#e2e8f0", "#29B5E8", "#0b76a8"
SEV = {"critical": ("#dc2626", "#fef2f2", "Critical"), "high": ("#F59E0B", "#fffbeb", "High"),
       "info": (SF_D, "#f0f9ff", "Info")}


def role_context(session, role):
    """Blast radius in one line: users holding the role, its privilege count, admin lineage."""
    if not role:
        return None
    facts = []
    try:
        users = sum(1 for g in show(session, f"SHOW GRANTS OF ROLE {q(role)}") if (g.get("granted_to") or "").upper() == "USER")
        facts.append(f"{users} direct user{'s' if users != 1 else ''}")
    except Exception:
        pass
    try:
        privs = show(session, f"SHOW GRANTS TO ROLE {q(role)}")
        facts.append(f"{len(privs)} privileges")
        kids = [g.get("name") for g in privs if (g.get("granted_on") or "").upper() == "ROLE"]
        if kids:
            facts.append("inherits " + ", ".join(sorted(kids)[:3]) + (" …" if len(kids) > 3 else ""))
    except Exception:
        pass
    return " · ".join(facts) or None


def render(sev, title, headline, rows, fix=None, note=None):
    """(html, slack_payload). rows: [(label, value, mono?)] with empty values dropped."""
    col, tint, label = SEV[sev]
    rows = [r for r in rows if r[1]]
    e = html.escape
    cell = ("<tr><td style='width:104px;padding:6px 12px 6px 0;color:{m};font-size:11px;text-transform:uppercase;letter-spacing:.06em;"
            "white-space:nowrap;vertical-align:top'>{k}</td><td style='padding:6px 0;color:{i};font-size:13.5px;{f}'>{v}</td></tr>")
    trs = "".join(cell.format(m=MUTE, i=INK, k=e(k), v=e(str(v)),
                              f="font-family:Menlo,Consolas,monospace;font-size:12.5px" if mono else "") for k, v, mono in rows)
    body = (
        f"<div style='background:#f8fafc;padding:20px 0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif'>"
        f"<table role='presentation' cellpadding='0' cellspacing='0' style='max-width:600px;width:100%;margin:0 auto;"
        f"background:#fff;border:1px solid {LINE};border-radius:12px;overflow:hidden'>"
        f"<tr><td style='height:5px;background:linear-gradient(90deg,{SF},{SF_D});background-color:{SF}'></td></tr>"
        f"<tr><td style='padding:18px 22px 4px'>"
        f"<div style='font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:{SF_D};font-weight:700'>Role Explorer"
        f"<span style='margin-left:8px;background:{tint};color:{col};border:1px solid {col};border-radius:999px;"
        f"padding:1px 8px;letter-spacing:.04em'>{label}</span></div>"
        f"<div style='font-size:19px;font-weight:700;color:{INK};margin:6px 0 2px'>{e(title)}</div>"
        f"<div style='font-size:14.5px;color:{INK};border-left:3px solid {col};background:{tint};padding:8px 12px;"
        f"border-radius:0 8px 8px 0;margin:10px 0 6px'>{headline}</div></td></tr>"
        f"<tr><td style='padding:4px 22px 6px'><table cellpadding='0' cellspacing='0' style='width:100%;border-collapse:collapse'>{trs}</table></td></tr>"
        + (f"<tr><td style='padding:6px 22px 4px'><div style='font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:{MUTE};"
           f"margin-bottom:5px'>Fix</div><div style='background:#0f172a;color:#e0f2fe;border-radius:8px;padding:10px 12px;"
           f"font-family:Menlo,Consolas,monospace;font-size:12.5px'>{e(fix)}</div></td></tr>" if fix else "")
        + (f"<tr><td style='padding:8px 22px 0'><div style='font-size:13px;color:#047857;background:#ecfdf5;border-radius:8px;"
           f"padding:7px 11px'>{e(note)}</div></td></tr>" if note else "")
        + f"<tr><td style='padding:14px 22px 16px;font-size:11.5px;color:{MUTE}'>Open Role Explorer › Alerts to acknowledge or review.</td></tr>"
        "</table></div>")
    plain = re.sub(r"<[^>]+>", "", headline)
    emoji = {"critical": ":rotating_light:", "high": ":warning:", "info": ":large_blue_circle:"}[sev]
    fields = [{"type": "mrkdwn", "text": f"*{k}*\n{('`' + str(v) + '`') if mono else v}"} for k, v, mono in rows[:10]]
    blocks = [
        {"type": "header", "text": {"type": "plain_text", "text": f"{title}"[:150], "emoji": True}},
        {"type": "section", "text": {"type": "mrkdwn", "text": f"{emoji} *{label}* · {plain}"}},
        {"type": "section", "fields": fields},
    ]
    if fix:
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": f"*Fix*\n```{fix}```"}})
    if note:
        blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": f":white_check_mark: {note}"}]})
    blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": "Role Explorer · acknowledge in the Alerts tab"}]})
    text = f"{emoji} {title}: {plain}"  # notification preview / fallback
    return body, {"text": text, "blocks": blocks}


def deliver(session, email, slack, subject, body, payload):
    sent = []
    if email:
        try:
            session.sql("CALL SYSTEM$SEND_EMAIL(?, ?, ?, ?, 'text/html')", params=[EMAIL_INT, email, subject, body]).collect()
            sent.append("email")
        except Exception as e:
            sent.append("email failed: " + str(e)[:120])
    if slack:
        call = ("CALL SYSTEM$SEND_SNOWFLAKE_NOTIFICATION(SNOWFLAKE.NOTIFICATION.APPLICATION_JSON(?), "
                "SNOWFLAKE.NOTIFICATION.INTEGRATION(?))")
        try:
            session.sql(call, params=[json.dumps(payload), SLACK_INT]).collect()
            sent.append("slack")
        except Exception as e:
            try:  # some webhooks reject blocks: fall back to text only
                session.sql(call, params=[json.dumps({"text": payload["text"]}), SLACK_INT]).collect()
                sent.append("slack (text)")
            except Exception:
                sent.append("slack failed: " + str(e)[:120])
    return ", ".join(sent) or "none"


def who_of(v, fallback="unknown user"):
    if v.get("by_user"):
        return v["by_user"] + (f" (as {v['by_role']})" if v.get("by_role") else "")
    if v.get("candidates"):
        return f"a holder of {v.get('by_role')}: {v['candidates']}"
    return (f"unknown user (as {v['by_role']})" if v.get("by_role") else fallback)


def when_of(v):
    return v["granted_at"].strftime("%Y-%m-%d %H:%M %Z").strip() if hasattr(v.get("granted_at"), "strftime") else None


def notify(session, rule, v):
    revoke = f"REVOKE ROLE {v['role']} FROM {v['gtype']} {v['grantee']};"
    gt = v["gtype"].title() + (f" · {v['utype'].lower()}" if v.get("utype") else "")
    e = html.escape
    headline = f"<b>{e(v['grantee'])}</b> now holds protected role <b>{e(v['role'])}</b>."
    note = {"REVOKED": "Auto-revoke is on: the grant was already removed.",
            "REVOKE_FAILED": None}.get(v.get("action"))
    rows = [("Grantee", f"{v['grantee']} ({gt})", False), ("Role", v["role"], True),
            ("Why", v["reason"], False), ("Granted by", who_of(v), False), ("When", when_of(v), False),
            ("Role reach", role_context(session, v["role"]), False),
            ("Statement", v.get("text"), True)]
    if v.get("action") == "REVOKE_FAILED":
        rows.append(("Auto-revoke", "failed: revoke it manually", False))
    body, payload = render("critical", "Protected role violation", headline, rows,
                           None if v.get("action") == "REVOKED" else revoke, note)
    subject = f"[Role Explorer] Critical: {v['grantee']} was granted protected role {v['role']}"
    return deliver(session, rule.get("NOTIFY_EMAIL"), rule.get("NOTIFY_SLACK"), subject, body, payload)


def send(session, email, slack, subject, title, headline, rows, fix, sev="high"):
    """Email + Slack for the custom alert kinds."""
    body, payload = render(sev, title, headline, rows, fix)
    return deliver(session, email, slack, subject, body, payload)


TITLES = {"admin_holders": "New holder of a watched role", "sensitive_privilege": "Sensitive privilege granted",
          "new_principal": "New user or role matching an alert",
          "bundle_drift": "An AI asset needs access its bundle doesn't cover",
          "bundle_broken": "An access role lost a grant its asset needs"}


def check_watches(session, dry_run, out):
    """Custom kinds: diff the live state against each rule's baseline."""
    rules = [r.as_dict() for r in session.sql(f"SELECT * FROM {DB}.WATCH_RULES WHERE ENABLED").collect()]
    out["watches"] = len(rules)
    for r in rules:
        try:
            spec = json.loads(r["SPEC"]) if isinstance(r["SPEC"], str) else r["SPEC"]
            base = json.loads(r["BASELINE"]) if isinstance(r["BASELINE"], str) else (r["BASELINE"] or [])
            cur = wk.state(session, r["KIND"], spec)
            new, gone = wk.diff(cur, base)
            for k in new:
                v = dict(cur[k], key=k)
                if r["KIND"] != "new_principal" and v.get("role") and v.get("granted_at"):
                    a = attribute(session, v.get("direct_role") or v["role"], v["grantee"], v["granted_at"])
                    v.update(by_user=a.get("user"), by_role=a.get("role") or v.get("by_role"), query_id=a.get("query_id"), text=a.get("text"))
                    if not v.get("by_user"):
                        v["candidates"] = role_holders(session, v.get("by_role"))
                why = wk.reason(r["KIND"], spec, v)
                fix = wk.fix_sql(r["KIND"], v)
                e = html.escape
                headline = f"<b>{e(v['grantee'])}</b> {e(why)}."
                rows = [("Rule", r["NAME"] or wk.describe(r["KIND"], spec), False),
                        (v["gtype"].title(), v["grantee"] + (f" ({v['user_type'].lower()})" if v.get("user_type") else ""), False),
                        ("Role", v.get("role"), True), ("By", who_of(v, v.get("by_role") or "unknown"), False),
                        ("When", when_of(v), False),
                        ("Role reach", role_context(session, v.get("role")) if v.get("role") else None, False),
                        ("Statement", v.get("text"), True)]
                sev = {"admin_holders": "critical", "sensitive_privilege": "high"}.get(r["KIND"], "info")
                notified = "dry run"
                if not dry_run:
                    notified = send(session, r["NOTIFY_EMAIL"], r["NOTIFY_SLACK"], f"[Role Explorer] {v['grantee']}: {why}"[:200],
                                    TITLES[r["KIND"]], headline, rows, fix, sev)
                    detail = {kk: (str(x) if isinstance(x, datetime.datetime) else x) for kk, x in v.items()}
                    detail.update(fix=fix, rule=r["NAME"])
                    session.sql(f"""INSERT INTO {DB}.ALERT_LOG (KIND, RULE_ID, DETAIL, ROLE_NAME, GRANTEE_TYPE, GRANTEE, GRANTEE_USER_TYPE, REASON,
                            GRANTED_AT, GRANTED_BY_ROLE, GRANTED_BY_USER, GRANTED_BY_CANDIDATES, QUERY_ID, QUERY_TEXT, NOTIFIED, ACTION, STATUS)
                        SELECT ?, ?, PARSE_JSON(?), ?, ?, ?, ?, ?, TRY_TO_TIMESTAMP_LTZ(?), ?, ?, ?, ?, ?, ?, 'ALERTED', 'OPEN'""",
                                params=[r["KIND"], r["ID"], json.dumps(detail), v.get("role") or v["grantee"], v["gtype"], v["grantee"],
                                        v.get("user_type"), why, v["granted_at"].isoformat() if hasattr(v.get("granted_at"), "isoformat") else None,
                                        v.get("by_role"), v.get("by_user"), v.get("candidates"), v.get("query_id"), v.get("text"),
                                        notified]).collect()
                out["new"].append({"kind": r["KIND"], "rule": r["NAME"], "grantee": v["grantee"], "reason": why})
            if not dry_run and (new or gone):
                session.sql(f"UPDATE {DB}.WATCH_RULES SET BASELINE = PARSE_JSON(?) WHERE ID = ?",
                            params=[json.dumps(sorted(cur)), r["ID"]]).collect()
                if gone:
                    session.sql(f"""UPDATE {DB}.ALERT_LOG SET STATUS = 'RESOLVED', RESOLVED_AT = CURRENT_TIMESTAMP()
                        WHERE RULE_ID = ? AND STATUS IN ('OPEN','ACKED') AND ARRAY_CONTAINS(DETAIL:key::VARIANT, PARSE_JSON(?))""",
                                params=[r["ID"], json.dumps(gone)]).collect()
                    out["resolved"] += len(gone)
        except Exception as e:
            out["errors"].append(f"{r.get('NAME') or r['KIND']}: {str(e)[:200]}")


def check_rule(session, rule, user_types, dry_run):
    role = rule["ROLE_NAME"]
    allowed_users = arr(rule["ALLOWED_USERS"])
    allowed_type = (rule["ALLOWED_USER_TYPE"] or "").upper() or None
    allowed_parents = arr(rule["ALLOWED_PARENT_ROLES"])
    found = []
    for g in show(session, f"SHOW GRANTS OF ROLE {q(role)}"):
        gtype, name = (g.get("granted_to") or "").upper(), g.get("grantee_name")
        reasons, utype = [], None
        if gtype == "USER":
            utype = user_types.get(name) or "PERSON"     # NULL TYPE behaves as PERSON
            if allowed_users is not None and name.upper() not in allowed_users:
                reasons.append("user is not on the allowlist")
            if allowed_type and utype != allowed_type:
                reasons.append(f"user type is {utype}, rule requires {allowed_type}")
        elif gtype == "ROLE":
            if allowed_parents is not None and name.upper() not in allowed_parents:
                reasons.append("role was granted to a parent role that is not allowed, so every holder of that role inherits it")
        if reasons:
            found.append({"role": role, "gtype": gtype, "grantee": name, "utype": utype,
                          "reason": "; ".join(reasons), "granted_at": g.get("created_on"),
                          "by_role": g.get("granted_by")})
    # Dedupe on epoch ms: a re-grant later gets a new created_on, so it alerts again.
    known = {(r["GRANTEE_TYPE"], r["GRANTEE"], int(r["GMS"] or 0)): r["ID"] for r in session.sql(
        f"""SELECT ID, GRANTEE_TYPE, GRANTEE, DATE_PART(EPOCH_MILLISECOND, GRANTED_AT) AS GMS
            FROM {DB}.ALERT_LOG WHERE ROLE_NAME = ? AND STATUS IN ('OPEN','ACKED')""", params=[role]).collect()}
    current = set()
    new = []
    for v in found:
        key = (v["gtype"], v["grantee"], int(v["granted_at"].timestamp() * 1000) if v["granted_at"] else 0)
        current.add(key)
        if key in known:
            continue
        a = attribute(session, role, v["grantee"], v["granted_at"])
        v.update(by_user=a.get("user"), by_role=a.get("role") or v["by_role"], query_id=a.get("query_id"), text=a.get("text"))
        if not v["by_user"]:
            v["candidates"] = role_holders(session, v["by_role"])
        v["action"] = "ALERTED"
        if rule["AUTO_REVOKE"] and not dry_run:
            try:
                session.sql(f"REVOKE ROLE {q(role)} FROM {v['gtype']} {q(v['grantee'])}").collect()
                v["action"] = "REVOKED"
            except Exception:
                v["action"] = "REVOKE_FAILED"
        if not dry_run:
            v["notified"] = notify(session, rule, v)
            session.sql(
                f"""INSERT INTO {DB}.ALERT_LOG (ROLE_NAME, GRANTEE_TYPE, GRANTEE, GRANTEE_USER_TYPE, REASON, GRANTED_AT,
                       GRANTED_BY_ROLE, GRANTED_BY_USER, GRANTED_BY_CANDIDATES, QUERY_ID, QUERY_TEXT, NOTIFIED, ACTION, STATUS, RESOLVED_AT)
                    SELECT ?,?,?, NULLIF(?, 'None'),?, TO_TIMESTAMP_LTZ(TO_TIMESTAMP_TZ(NULLIF(?, 'None'))), NULLIF(?, 'None'), NULLIF(?, 'None'),
                           NULLIF(?, 'None'), NULLIF(?, 'None'), NULLIF(?, 'None'), ?,?,?, IFF(? = 'RESOLVED', CURRENT_TIMESTAMP(), NULL)""",
                params=[role, v["gtype"], v["grantee"], v["utype"], v["reason"],
                        v["granted_at"].isoformat() if v["granted_at"] else None, v["by_role"],
                        v.get("by_user"), v.get("candidates"), v.get("query_id"), v.get("text"), v["notified"], v["action"],
                        "RESOLVED" if v["action"] == "REVOKED" else "OPEN",
                        "RESOLVED" if v["action"] == "REVOKED" else "OPEN"]).collect()
        new.append(v)
    gone = [i for k, i in known.items() if k not in current]
    if gone and not dry_run:
        session.sql(f"UPDATE {DB}.ALERT_LOG SET STATUS = 'RESOLVED', RESOLVED_AT = CURRENT_TIMESTAMP() "
                    f"WHERE ID IN ({','.join(lit(i) for i in gone)})").collect()
    return new, len(gone)


def main(session, dry_run):
    t0 = time.time()
    out = {"rules": 0, "new": [], "resolved": 0, "errors": []}
    try:
        rules = [r.as_dict() for r in session.sql(f"SELECT * FROM {DB}.PROTECTED_ROLES WHERE ENABLED").collect()]
        out["rules"] = len(rules)
        if rules:
            user_types = {u["name"]: (u.get("type") or "").upper() or None for u in show(session, "SHOW USERS")}
            for rule in rules:
                try:
                    new, resolved = check_rule(session, rule, user_types, dry_run)
                    out["resolved"] += resolved
                    out["new"] += [{k: (str(x) if isinstance(x, datetime.datetime) else x) for k, x in v.items()} for v in new]
                except Exception as e:
                    out["errors"].append(f"{rule['ROLE_NAME']}: {str(e)[:200]}")
    except Exception as e:
        out["errors"].append(str(e)[:300])
    try:
        check_watches(session, dry_run, out)
    except Exception as e:
        out["errors"].append("custom alerts: " + str(e)[:300])
    if not dry_run:
        try:
            out["attributed"] = backfill(session)
        except Exception as e:
            out["errors"].append("attribution backfill: " + str(e)[:200])
    out["ms"] = int((time.time() - t0) * 1000)
    if not dry_run:
        n_open = session.sql(f"SELECT COUNT(*) FROM {DB}.ALERT_LOG WHERE STATUS = 'OPEN'").collect()[0][0]
        session.sql(f"""MERGE INTO {DB}.WATCH_STATE t USING (SELECT 1 AS ID) s ON t.ID = s.ID
            WHEN MATCHED THEN UPDATE SET LAST_RUN = CURRENT_TIMESTAMP(), RULES = ?, NEW_ALERTS = ?, OPEN_ALERTS = ?, MS = ?, ERROR = NULLIF(?, 'None')
            WHEN NOT MATCHED THEN INSERT (ID, LAST_RUN, RULES, NEW_ALERTS, OPEN_ALERTS, MS, ERROR)
                 VALUES (1, CURRENT_TIMESTAMP(), ?, ?, ?, ?, NULLIF(?, 'None'))""",
                    params=[out["rules"], len(out["new"]), n_open, out["ms"], "; ".join(out["errors"]) or None] * 2).collect()
    return out
$$;

-- Serverless, every minute: worst-case detection latency is about one minute.
CREATE OR REPLACE TASK PROTECTED_ROLE_WATCH
  SCHEDULE = '1 MINUTE'
  USER_TASK_MANAGED_INITIAL_WAREHOUSE_SIZE = 'XSMALL'
  COMMENT = 'Role Explorer: protected-role watcher'
AS
  CALL RBAC_EXPLORER_DB.ALERTS.CHECK_PROTECTED_ROLES(FALSE);

ALTER TASK PROTECTED_ROLE_WATCH RESUME;
