"""Protected-role alerting: rule CRUD, alert log, watcher task control and the demo scenario.

Detection itself runs in RBAC_EXPLORER_DB.ALERTS.CHECK_PROTECTED_ROLES (setup/alerts.sql),
called every minute by the PROTECTED_ROLE_WATCH serverless task.
"""
from __future__ import annotations

import json
import re

from modules import watch_kinds as wk

DRAFT_MODEL = "claude-sonnet-4-5"
DRAFT_SQL = "SELECT AI_COMPLETE(?, ?, {'temperature': 0, 'max_tokens': 700}) AS A"
MAX_WATCHES = 50

SCHEMA = "RBAC_EXPLORER_DB.ALERTS"
TASK = f"{SCHEMA}.PROTECTED_ROLE_WATCH"
USER_TYPES = {"SERVICE", "PERSON", "LEGACY_SERVICE"}
EMAIL = re.compile(r"^[^@\s,;'\"]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$")
UUID = re.compile(r"^[0-9a-fA-F-]{36}$")
# The demo scenario only ever touches these objects (created by setup/demo_seed.sql).
DEMO = {"role": "DEMO_PIPELINE_SVC_ROLE", "svc_user": "DEMO_PIPELINE_SVC", "person_user": "DEMO_ANALYST_JANE"}


def _q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else v


def _rows(session, sql: str, params=None) -> list[dict]:
    return [{k.lower(): _iso(v) for k, v in r.as_dict().items()} for r in session.sql(sql, params=params).collect()]


def _arr(v):
    if v is None:
        return None
    return json.loads(v) if isinstance(v, str) else list(v)


def overview(session) -> dict:
    rules = _rows(session, f"SELECT * FROM {SCHEMA}.PROTECTED_ROLES ORDER BY ROLE_NAME")
    for r in rules:
        for k in ("allowed_users", "allowed_parent_roles"):
            r[k] = _arr(r.get(k))
    log = _rows(session, f"""SELECT ID, DETECTED_AT, KIND, RULE_ID, DETAIL, ROLE_NAME, GRANTEE_TYPE, GRANTEE, GRANTEE_USER_TYPE, REASON, GRANTED_AT,
                                    GRANTED_BY_ROLE, GRANTED_BY_USER, GRANTED_BY_CANDIDATES, QUERY_ID, QUERY_TEXT, NOTIFIED, ACTION, STATUS, RESOLVED_AT, ACK_BY, ACK_AT
                             FROM {SCHEMA}.ALERT_LOG ORDER BY DETECTED_AT DESC LIMIT 200""")
    for x in log:
        x["kind"] = x.get("kind") or "protected_role"
        x["detail"] = json.loads(x["detail"]) if isinstance(x.get("detail"), str) else x.get("detail")
    watches = []
    for w in _rows(session, f"SELECT ID, KIND, NAME, SPEC, ARRAY_SIZE(BASELINE) AS NBASE, NOTIFY_EMAIL, NOTIFY_SLACK, ENABLED, NOTE, "
                            f"CREATED_BY, UPDATED_AT FROM {SCHEMA}.WATCH_RULES ORDER BY CREATED_AT"):
        spec = json.loads(w["spec"]) if isinstance(w["spec"], str) else w["spec"]
        watches.append({"id": w["id"], "kind": w["kind"], "name": w["name"], "spec": spec, "summary": wk.describe(w["kind"], spec),
                        "baseline": w["nbase"] or 0, "email": w["notify_email"], "slack": bool(w["notify_slack"]),
                        "enabled": bool(w["enabled"]), "note": w["note"], "created_by": w["created_by"], "updated_at": w["updated_at"]})
    state = _rows(session, f"SELECT * FROM {SCHEMA}.WATCH_STATE WHERE ID = 1")
    task = _rows(session, f"SHOW TASKS LIKE 'PROTECTED_ROLE_WATCH' IN SCHEMA {SCHEMA}")
    demo_role = _rows(session, f"SHOW ROLES LIKE '{DEMO['role']}'")
    holders = []
    if demo_role:
        holders = [g.get("grantee_name") for g in _rows(session, f"SHOW GRANTS OF ROLE {_q(DEMO['role'])}") if g.get("granted_to") == "USER"]
    return {
        "rules": [{"role": r["role_name"], "allowed_users": r["allowed_users"], "allowed_type": r.get("allowed_user_type"),
                   "allowed_parents": r["allowed_parent_roles"], "email": r.get("notify_email"), "slack": bool(r.get("notify_slack")),
                   "auto_revoke": bool(r.get("auto_revoke")), "enabled": bool(r.get("enabled")), "note": r.get("note"),
                   "updated_at": r.get("updated_at"), "created_by": r.get("created_by")} for r in rules],
        "log": log,
        "watches": watches,
        "state": state[0] if state else None,
        "task": {"state": task[0].get("state"), "schedule": task[0].get("schedule")} if task else None,
        "demo": {**DEMO, "exists": bool(demo_role), "holders": holders},
    }


def _clean_list(values, allowed: set[str], what: str) -> list[str]:
    out = []
    for v in values or []:
        v = str(v).strip()
        if not v:
            continue
        match = next((a for a in allowed if a.upper() == v.upper()), None)
        if match is None:
            raise ValueError(f"unknown {what}: {v}")
        out.append(match)
    return sorted(set(out))


def save(session, pl: dict, known_roles, known_users) -> dict:
    roles, users = known_roles(), known_users()
    role = str(pl.get("role") or "")
    if role not in roles:
        raise ValueError(f"unknown role {role}")
    allowed_users = None if pl.get("allowed_users") is None else _clean_list(pl["allowed_users"], users, "user")
    parents = None if pl.get("allowed_parents") is None else _clean_list(pl["allowed_parents"], roles, "role")
    utype = (pl.get("allowed_type") or "").upper() or None
    if utype and utype not in USER_TYPES:
        raise ValueError("user type must be SERVICE, PERSON or LEGACY_SERVICE")
    if allowed_users is None and utype is None and parents is None:
        raise ValueError("a rule needs at least one condition: allowed users, a user type or allowed parent roles")
    email = (pl.get("email") or "").strip() or None
    if email and not EMAIL.match(email):
        raise ValueError("invalid email")
    note = (pl.get("note") or "")[:500] or None
    session.sql(f"""
        MERGE INTO {SCHEMA}.PROTECTED_ROLES t
        USING (SELECT ? AS ROLE_NAME, PARSE_JSON(?) AS AU, ? AS UT, PARSE_JSON(?) AS AP, ? AS EM, ? AS SL, ? AS AR, ? AS EN, ? AS NT) s
        ON t.ROLE_NAME = s.ROLE_NAME
        WHEN MATCHED THEN UPDATE SET ALLOWED_USERS = s.AU, ALLOWED_USER_TYPE = s.UT, ALLOWED_PARENT_ROLES = s.AP,
             NOTIFY_EMAIL = s.EM, NOTIFY_SLACK = s.SL, AUTO_REVOKE = s.AR, ENABLED = s.EN, NOTE = s.NT, UPDATED_AT = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN INSERT (ROLE_NAME, ALLOWED_USERS, ALLOWED_USER_TYPE, ALLOWED_PARENT_ROLES, NOTIFY_EMAIL, NOTIFY_SLACK,
             AUTO_REVOKE, ENABLED, NOTE, CREATED_BY)
             VALUES (s.ROLE_NAME, s.AU, s.UT, s.AP, s.EM, s.SL, s.AR, s.EN, s.NT, CURRENT_USER())""",
                params=[role, json.dumps(allowed_users), utype, json.dumps(parents), email,
                        bool(pl.get("slack", False)), bool(pl.get("auto_revoke")), bool(pl.get("enabled", True)), note]).collect()
    return {"saved": role}


def handle(session, action: str, pl: dict, known_roles, known_users, run_jobs=None, run_py=None):
    if action == "alert_rules":
        return overview(session)
    if action == "alert_draft":
        text = str(pl.get("text") or "")[:1500]
        if not text.strip():
            raise ValueError("describe the alert you want")
        prompt = draft_prompt(text, str(pl.get("answer") or "")[:3000], sorted(known_roles()), sorted(known_users()))
        nonce = str(pl.get("nonce") or "")[:20]
        return run_jobs(f"draft{abs(hash((text, nonce))) % 10**12}", {"a": (DRAFT_SQL, [DRAFT_MODEL, prompt])},
                        lambda f: parse_draft(f["a"].iloc[0, 0], known_roles(), known_users()))
    if action == "alert_preview":
        kind = str(pl.get("kind") or "")
        spec = wk.clean_spec(kind, pl.get("spec"), known_roles(), known_users())
        return run_py(lambda: _preview(session, kind, spec))
    if action == "watch_save":
        kind = str(pl.get("kind") or "")
        spec = wk.clean_spec(kind, pl.get("spec"), known_roles(), known_users())
        email = (pl.get("email") or "").strip() or None
        if email and not EMAIL.match(email):
            raise ValueError("invalid email")
        wid = str(pl.get("id") or "")
        if wid and not UUID.match(wid):
            raise ValueError("invalid rule id")
        return run_py(lambda: _save_watch(session, wid, kind, spec, email, pl))
    if action == "watch_delete":
        wid = str(pl.get("id") or "")
        if not UUID.match(wid):
            raise ValueError("invalid rule id")
        session.sql(f"DELETE FROM {SCHEMA}.WATCH_RULES WHERE ID = ?", params=[wid]).collect()
        return {"deleted": wid}
    if action == "watch_toggle":
        wid = str(pl.get("id") or "")
        if not UUID.match(wid):
            raise ValueError("invalid rule id")
        session.sql(f"UPDATE {SCHEMA}.WATCH_RULES SET ENABLED = ?, UPDATED_AT = CURRENT_TIMESTAMP() WHERE ID = ?",
                    params=[bool(pl.get("enabled")), wid]).collect()
        return {"toggled": wid}
    if action == "alert_save":
        return save(session, pl, known_roles, known_users)
    if action == "alert_delete":
        session.sql(f"DELETE FROM {SCHEMA}.PROTECTED_ROLES WHERE ROLE_NAME = ?", params=[str(pl.get("role"))]).collect()
        return {"deleted": pl.get("role")}
    if action == "alert_ack":
        aid = str(pl.get("id") or "")
        if not UUID.match(aid):
            raise ValueError("invalid alert id")
        session.sql(f"""UPDATE {SCHEMA}.ALERT_LOG SET STATUS = IFF(STATUS = 'OPEN', 'ACKED', STATUS),
                        ACK_BY = CURRENT_USER(), ACK_AT = CURRENT_TIMESTAMP() WHERE ID = ?""", params=[aid]).collect()
        return {"acked": aid}
    if action == "alert_task":
        verb = "RESUME" if pl.get("resume") else "SUSPEND"
        session.sql(f"ALTER TASK {TASK} {verb}").collect()
        return {"task": verb}
    if action == "alert_test":
        if run_jobs is None:
            raise ValueError("test needs the job runner")
        nonce = int(pl.get("nonce") or 0)

        def post(frames):
            raw = frames["call"].iloc[0, 0]
            return json.loads(raw) if isinstance(raw, str) else raw
        return run_jobs(f"alerttest{nonce}", {"call": f"CALL {SCHEMA}.CHECK_PROTECTED_ROLES(FALSE)"}, post)
    if action == "alert_demo":
        # Only the seeded demo role and users, never anything else.
        step = pl.get("step")
        if step == "violate":
            session.sql(f"GRANT ROLE {_q(DEMO['role'])} TO USER {_q(DEMO['person_user'])}").collect()
        elif step == "undo":
            session.sql(f"REVOKE ROLE {_q(DEMO['role'])} FROM USER {_q(DEMO['person_user'])}").collect()
        else:
            raise ValueError("unknown demo step")
        return {"demo": step}
    raise ValueError(f"unknown action {action}")


# ------------------------------------------------------------ bot-drafted alerts
def draft_prompt(text: str, answer: str, roles: list[str], users: list[str]) -> str:
    return f"""Turn the user's request into ONE Role Explorer alert rule. Reply with JSON only, no prose.

Supported kinds and their JSON:
1. protected_role: a role may only be held by certain users / user types / parent roles.
   {{"kind":"protected_role","name":"...","spec":{{"role":"ROLE","allowed_users":["USER",...] or null,
     "allowed_type":"SERVICE"|"PERSON"|"LEGACY_SERVICE"|null,"allowed_parents":["ROLE",...] or null}}}}
   (null = not checked; allowed_parents [] = no role may inherit it; at least one condition must be set)
2. admin_holders: anyone NEW can use one of these roles (directly, or also through parent roles when inherited=true).
   {{"kind":"admin_holders","name":"...","spec":{{"roles":["ACCOUNTADMIN"],"inherited":true,"allowed_users":[]}}}}
3. sensitive_privilege: a role is newly granted one of these privileges on the account or on named databases.
   {{"kind":"sensitive_privilege","name":"...","spec":{{"privileges":["MANAGE GRANTS"],"scope":"ACCOUNT" or {{"databases":["DB"]}},"except_roles":[]}}}}
   privileges must come from: {", ".join(wk.PRIVILEGES)}
4. new_principal: a new user or role is created matching a pattern (glob with * and ?), user type and/or owner role.
   {{"kind":"new_principal","name":"...","spec":{{"object":"USER"|"ROLE","name_pattern":"*_SVC" or null,"user_type":"PERSON"|"SERVICE"|"LEGACY_SERVICE"|null,"owner_in":[]}}}}

If the request can't be expressed by these kinds, reply {{"ok":false,"reason":"<one sentence, say which kinds exist>"}}.
Otherwise reply {{"ok":true, "kind":..., "name":"<short title>", "spec":{{...}}}}.
Use exact names from these lists (case matters for matching, pick the closest real name):
<roles>{", ".join(roles)[:12000]}</roles>
<users>{", ".join(users)[:4000]}</users>
<request>{text}</request>
<context_answer>{answer}</context_answer>
JSON:"""


def parse_draft(raw, roles: set, users: set) -> dict:
    s = raw if isinstance(raw, str) else json.dumps(raw)
    try:
        v = json.loads(s)
        s = v if isinstance(v, str) else json.dumps(v)
    except ValueError:
        pass
    m = re.search(r"\{.*\}", s, re.S)
    if not m:
        return {"ok": False, "reason": "The assistant didn't return a rule. Try rephrasing, or use + New alert."}
    try:
        d = json.loads(m.group(0))
    except ValueError:
        return {"ok": False, "reason": "The assistant returned an invalid rule. Try rephrasing."}
    if not d.get("ok", True) or not d.get("kind"):
        return {"ok": False, "reason": str(d.get("reason") or "That can't be expressed as an alert rule.")[:400]}
    kind, spec, name = str(d["kind"]), d.get("spec") or {}, str(d.get("name") or "")[:120]
    try:
        if kind == "protected_role":
            role = next((r for r in roles if r.upper() == str(spec.get("role") or "").upper()), None)
            if not role:
                raise ValueError(f"unknown role {spec.get('role')}")
            spec = {"role": role,
                    "allowed_users": None if spec.get("allowed_users") is None else _clean_list(spec["allowed_users"], users, "user"),
                    "allowed_type": (spec.get("allowed_type") or "").upper() or None,
                    "allowed_parents": None if spec.get("allowed_parents") is None else _clean_list(spec["allowed_parents"], roles, "role")}
            if spec["allowed_type"] and spec["allowed_type"] not in USER_TYPES:
                raise ValueError("bad user type")
            summary = f"Protect {role}"
        else:
            spec = wk.clean_spec(kind, spec, roles, users)
            summary = wk.describe(kind, spec)
    except ValueError as e:
        return {"ok": False, "reason": f"The drafted rule didn't validate ({e}). Try naming the role or user exactly."}
    return {"ok": True, "kind": kind, "name": name or summary, "spec": spec, "summary": summary}


def _jsonable(v: dict) -> dict:
    return {k: _iso(x) for k, x in v.items()}


def _preview(session, kind: str, spec: dict) -> dict:
    cur = wk.state(session, kind, spec)
    items = [dict(_jsonable(v), key=k) for k, v in sorted(cur.items())]
    return {"kind": kind, "summary": wk.describe(kind, spec), "count": len(items), "items": items[:300]}


def _save_watch(session, wid: str, kind: str, spec: dict, email, pl: dict) -> dict:
    enabled = bool(pl.get("enabled", True))
    if enabled:
        n = session.sql(f"SELECT COUNT(*) FROM {SCHEMA}.WATCH_RULES WHERE ENABLED AND ID <> ?", params=[wid]).collect()[0][0]
        if n >= MAX_WATCHES:
            raise ValueError(f"at most {MAX_WATCHES} enabled custom alerts")
    # Baseline = what exists right now, so only changes from here on alert.
    base = sorted(wk.state(session, kind, spec))
    name = (str(pl.get("name") or "").strip() or wk.describe(kind, spec))[:120]
    note = (pl.get("note") or "")[:500] or None
    params = [wid or None, kind, name, json.dumps(spec), json.dumps(base), email, bool(pl.get("slack", False)), enabled, note]
    session.sql(f"""
        MERGE INTO {SCHEMA}.WATCH_RULES t
        USING (SELECT COALESCE(?, UUID_STRING()) AS ID, ? AS KIND, ? AS NAME, PARSE_JSON(?) AS SPEC, PARSE_JSON(?) AS BASELINE,
                      ? AS EM, ? AS SL, ? AS EN, ? AS NT) s
        ON t.ID = s.ID
        WHEN MATCHED THEN UPDATE SET KIND = s.KIND, NAME = s.NAME, SPEC = s.SPEC, BASELINE = s.BASELINE, NOTIFY_EMAIL = s.EM,
             NOTIFY_SLACK = s.SL, ENABLED = s.EN, NOTE = s.NT, UPDATED_AT = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN INSERT (ID, KIND, NAME, SPEC, BASELINE, NOTIFY_EMAIL, NOTIFY_SLACK, ENABLED, NOTE, CREATED_BY)
             VALUES (s.ID, s.KIND, s.NAME, s.SPEC, s.BASELINE, s.EM, s.SL, s.EN, s.NT, CURRENT_USER())""", params=params).collect()
    return {"saved": name, "baseline": len(base)}
