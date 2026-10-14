"""Access bundles in the app: discover, save, explain who's missing what, and grant it (gated).

Bridge actions (all prefixed access_):
  assets       agents, semantic views and search services the app can see, plus saved bundles
  discover     build a bundle for an asset (live DESCRIBE + SHOW GRANTS ON), without saving
  save         rebuild server-side, apply the admin's include/exclude choices, store in ACCESS.BUNDLES
  bundle       one saved bundle
  delete       drop a saved bundle (and its bundle_* alert rules)
  principal    a user's live roles (SHOW GRANTS TO USER, walked down), default role/warehouse and PATs
  fix          the least-privilege SQL for a bundle and target role, generated here, never in the browser
  apply        run exactly that SQL, if APPLY_ENABLED and the client confirms its hash; logged
  revert       undo an apply: revoke the access role from the target role if the apply granted it
  settings     read or set APPLY_ENABLED
  requests     list requests; file one; decide one (reject / approve / approve and apply)
  log          recent applies
"""
from __future__ import annotations

import hashlib
import json
import re

from modules import asset_kinds as ak

S = "RBAC_EXPLORER_DB.ACCESS"
UUID = re.compile(r"^[0-9a-fA-F-]{36}$")
KINDS = ("agent", "semantic_view", "search_service", "procedure", "function", "skill")
MAX_WALK = 150


def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else v


def _rows(session, sql: str, params=None) -> list[dict]:
    return [{k.lower(): _iso(v) for k, v in r.as_dict().items()} for r in session.sql(sql, params=params).collect()]


def _json(v, default=None):
    if v is None:
        return default
    return json.loads(v) if isinstance(v, str) else v


def _uuid(v) -> str:
    v = str(v or "")
    if not UUID.match(v):
        raise ValueError("invalid id")
    return v


def _hash(stmts: list[str]) -> str:
    return hashlib.sha1("\n".join(stmts).encode()).hexdigest()[:16]


def apply_enabled(session) -> bool:
    r = session.sql(f"SELECT V FROM {S}.SETTINGS WHERE K = 'APPLY_ENABLED' ORDER BY UPDATED_AT DESC LIMIT 1").collect()
    return bool(r) and str(r[0][0]).strip().lower() == "true"


# ------------------------------------------------------------------ discovery
def list_assets(session) -> dict:
    out = []
    for cmd, kind in (("SHOW AGENTS IN ACCOUNT", "agent"), ("SHOW SEMANTIC VIEWS IN ACCOUNT", "semantic_view"),
                      ("SHOW CORTEX SEARCH SERVICES IN ACCOUNT", "search_service")):
        try:
            for r in ak._show(session, cmd):
                fq = ".".join(ak._quote(str(r[k])) for k in ("database_name", "schema_name", "name"))
                out.append({"kind": kind, "fqn": ak.norm(fq), "owner": r.get("owner"), "comment": r.get("comment"),
                            "created": _iso(r.get("created_on"))})
        except Exception:
            pass
    saved = _rows(session, f"""SELECT ID, KIND, FQN, AR_ROLE, HASH, ARRAY_SIZE(ITEMS) AS N, CREATED_BY, UPDATED_AT
                               FROM {S}.BUNDLES ORDER BY UPDATED_AT DESC""")
    return {"assets": out, "bundles": saved}


def _source(pl: dict) -> dict:
    kind = str(pl.get("kind") or "")
    if kind not in KINDS:
        raise ValueError("unknown asset kind")
    src = {"kind": kind, "fqn": str(pl.get("fqn") or "")[:600], "text": str(pl.get("text") or "")[:200_000]}
    lr = pl.get("learn") or {}
    if lr.get("user"):
        src["learn"] = {"user": str(lr["user"])[:255], "days": int(lr.get("days") or 14), "cli": bool(lr.get("cli"))}
    return src


def build(session, src: dict, known_users=None) -> dict:
    learned = None
    if src.get("learn"):
        if known_users and src["learn"]["user"] not in known_users():
            raise ValueError("unknown user")
        try:
            learned = ak.learn(session, src["learn"]["user"], src["learn"]["days"], src["learn"]["cli"])
        except Exception as e:
            raise ValueError(f"Couldn't read ACCESS_HISTORY ({str(e)[:160]}). It needs Enterprise edition.")
    b = ak.build(session, src["kind"], src["fqn"], src.get("text") or "", learned)
    b["source"] = src
    return b


def save(session, pl: dict, known_users) -> dict:
    """Rebuild from the source (so stored items always come from discovery), then apply the admin's choices."""
    src = _source(pl)
    b = build(session, src, known_users)
    keep_off = set(pl.get("exclude") or [])
    keep_on = set(pl.get("include") or [])
    for i in b["items"]:
        if i["key"] in keep_off and not i.get("root"):
            i["on"] = False
        elif i.get("suggested"):
            i["on"] = i["key"] in keep_on
    items = b["items"]
    bid = pl.get("id")
    ar = ak.ar_name(b["kind"], b["fqn"])
    if bid:
        bid = _uuid(bid)
        session.sql(f"""UPDATE {S}.BUNDLES SET SOURCE = PARSE_JSON(?), ITEMS = PARSE_JSON(?), TREE = PARSE_JSON(?),
                        HASH = ?, AR_ROLE = ?, UPDATED_AT = CURRENT_TIMESTAMP() WHERE ID = ?""",
                    params=[json.dumps(src), json.dumps(items), json.dumps(b["tree"]), b["hash"], ar, bid]).collect()
    else:
        hit = session.sql(f"SELECT ID FROM {S}.BUNDLES WHERE KIND = ? AND FQN = ?", params=[b["kind"], b["fqn"]]).collect()
        if hit:
            return save(session, dict(pl, id=hit[0][0]), known_users)
        bid = session.sql("SELECT UUID_STRING()").collect()[0][0]
        session.sql(f"""INSERT INTO {S}.BUNDLES (ID, KIND, FQN, SOURCE, ITEMS, TREE, HASH, AR_ROLE, CREATED_BY)
                        SELECT ?, ?, ?, PARSE_JSON(?), PARSE_JSON(?), PARSE_JSON(?), ?, ?, CURRENT_USER()""",
                    params=[bid, b["kind"], b["fqn"], json.dumps(src), json.dumps(items), json.dumps(b["tree"]),
                            b["hash"], ar]).collect()
    return dict(get(session, bid), saved=True)


def get(session, bid: str) -> dict:
    rows = _rows(session, f"SELECT * FROM {S}.BUNDLES WHERE ID = ?", [_uuid(bid)])
    if not rows:
        raise ValueError("bundle not found")
    r = rows[0]
    return {"id": r["id"], "kind": r["kind"], "fqn": r["fqn"], "source": _json(r["source"], {}),
            "items": _json(r["items"], []), "tree": _json(r["tree"], {}), "hash": r["hash"], "ar": r["ar_role"],
            "created_by": r["created_by"], "updated": r["updated_at"]}


def refresh_live(session, b: dict) -> dict:
    """Live grantees for a stored bundle's items (they change after an apply)."""
    ak.live_grants(session, b["items"])
    return b


# ------------------------------------------------------------------ principals (live, no ACCOUNT_USAGE lag)
def principal(session, user: str) -> dict:
    q = ak._quote(user) if user != user.upper() else user
    u = ak._show(session, f"SHOW USERS LIKE {ak.lit(user)}")
    u = next((x for x in u if x["name"] == user), {})
    roots = [g["role"] for g in ak._show(session, f"SHOW GRANTS TO USER {q}") if g.get("granted_on") == "ROLE"]
    edges, seen, todo = [], set(), list(dict.fromkeys(roots + ["PUBLIC"]))
    while todo and len(seen) < MAX_WALK:
        r = todo.pop()
        if r in seen:
            continue
        seen.add(r)
        try:
            for g in ak._show(session, f"SHOW GRANTS TO ROLE {ak._quote(r) if '.' not in r else r}"):
                if g.get("privilege") == "USAGE" and g.get("granted_on") in ("ROLE", "DATABASE_ROLE"):
                    child = str(g["name"])
                    edges.append([child, r])
                    if child not in seen and g.get("granted_on") == "ROLE":
                        todo.append(child)
        except Exception:
            pass
    pats = []
    if str(u.get("has_pat")).lower() == "true":
        try:
            pats = [{"name": p["name"], "role": p.get("role_restriction") or None, "expires": _iso(p.get("expires_at")),
                     "status": p.get("status")}
                    for p in ak._show(session, f"SHOW USER PROGRAMMATIC ACCESS TOKENS FOR USER {q}")]
        except Exception as e:
            pats = [{"error": str(e)[:160]}]
    return {"user": user, "roots": roots, "edges": edges, "truncated": len(seen) >= MAX_WALK,
            "default_role": u.get("default_role") or None, "default_warehouse": u.get("default_warehouse") or None,
            "secondary": u.get("default_secondary_roles") or None, "type": u.get("type"), "pats": pats}


# ------------------------------------------------------------------ fix SQL, apply, revert
def _target(session, role: str, known_roles) -> str:
    role = str(role or "")
    if role not in known_roles():
        raise ValueError(f"unknown role {role}")
    prot = {r[0] for r in session.sql("SELECT ROLE_NAME FROM RBAC_EXPLORER_DB.ALERTS.PROTECTED_ROLES WHERE ENABLED").collect()}
    if role in prot or role.upper() in ak._PROTECTED or role.startswith("AR_"):
        raise ValueError(f"{role} is a protected, system or access role. Pick the functional role your users hold.")
    return role


def fix(session, pl: dict, known_roles) -> dict:
    b = get(session, pl.get("id"))
    target = _target(session, pl.get("target_role"), known_roles) if pl.get("target_role") else None
    stmts = ak.fix_sql(b, target, bool(pl.get("cortex")))
    return {"statements": stmts, "hash": _hash(stmts), "apply_enabled": apply_enabled(session), "ar": b["ar"]}


def apply(session, pl: dict, known_roles) -> dict:
    if not apply_enabled(session):
        raise ValueError("Apply is turned off. An admin can turn it on in Assets > Settings.")
    b = get(session, pl.get("id"))
    target = _target(session, pl.get("target_role"), known_roles)
    stmts = ak.fix_sql(b, target, bool(pl.get("cortex")))
    if _hash(stmts) != str(pl.get("confirm") or ""):
        raise ValueError("The bundle changed since you reviewed the SQL. Review it again before applying.")
    bad = [s for s in stmts if not ak.allowed(s)]
    if bad:
        raise ValueError(f"refusing a statement outside the allowlist: {bad[0][:120]}")
    ar = b["ar"]
    pre = {"ar_existed": any(r["name"] == ar for r in ak._show(session, f"SHOW ROLES LIKE {ak.lit(ar)}")),
           "target_had": False}
    if pre["ar_existed"]:
        pre["target_had"] = any(g.get("granted_to") == "ROLE" and g.get("grantee_name") == target
                                for g in ak._show(session, f"SHOW GRANTS OF ROLE {ar}"))
    results, ok = [], True
    for s in stmts:
        try:
            session.sql(s).collect()
            results.append({"sql": s, "ok": True})
        except Exception as e:
            ok = False
            results.append({"sql": s, "ok": False, "error": str(e)[:300]})
    lid = session.sql("SELECT UUID_STRING()").collect()[0][0]
    rid = _uuid(pl["request_id"]) if pl.get("request_id") else None
    session.sql(f"""INSERT INTO {S}.APPLY_LOG (ID, BUNDLE_ID, REQUEST_ID, AR_ROLE, TARGET_ROLE, STATEMENTS, RESULTS, PRE,
                    STATUS, APPLIED_BY)
                    SELECT ?, ?, ?, ?, ?, PARSE_JSON(?), PARSE_JSON(?), PARSE_JSON(?), ?, CURRENT_USER()""",
                params=[lid, b["id"], rid, ar, target, json.dumps(stmts), json.dumps(results), json.dumps(pre),
                        "APPLIED" if ok else "PARTIAL"]).collect()
    return {"log_id": lid, "ok": ok, "results": results, "ar": ar, "target": target}


def revert(session, pl: dict) -> dict:
    lid = _uuid(pl.get("log_id"))
    rows = _rows(session, f"SELECT * FROM {S}.APPLY_LOG WHERE ID = ?", [lid])
    if not rows:
        raise ValueError("apply not found")
    r = rows[0]
    if r["status"] == "REVERTED":
        raise ValueError("already reverted")
    pre = _json(r["pre"], {})
    done = []
    if not pre.get("target_had"):
        s = f"REVOKE ROLE {r['ar_role']} FROM ROLE {ak._quote(r['target_role']) if r['target_role'] != r['target_role'].upper() else r['target_role']}"
        session.sql(s).collect()
        done.append(s)
    session.sql(f"UPDATE {S}.APPLY_LOG SET STATUS = 'REVERTED', REVERTED_BY = CURRENT_USER(), REVERTED_AT = CURRENT_TIMESTAMP() WHERE ID = ?",
                params=[lid]).collect()
    note = None if pre.get("ar_existed") else f"{r['ar_role']} was created by this apply and is kept, with its grants, so nothing else breaks. Drop it when unused."
    return {"reverted": done, "note": note}


def log(session) -> list[dict]:
    return _rows(session, f"""SELECT l.ID, l.BUNDLE_ID, b.FQN, l.REQUEST_ID, l.AR_ROLE, l.TARGET_ROLE, l.STATUS,
                                     ARRAY_SIZE(l.STATEMENTS) AS N, l.APPLIED_BY, l.APPLIED_AT, l.REVERTED_BY, l.REVERTED_AT
                              FROM {S}.APPLY_LOG l LEFT JOIN {S}.BUNDLES b ON b.ID = l.BUNDLE_ID
                              ORDER BY l.APPLIED_AT DESC LIMIT 100""")


# ------------------------------------------------------------------ requests
def requests(session) -> list[dict]:
    return _rows(session, f"""SELECT r.*, b.KIND, b.FQN FROM {S}.REQUESTS r LEFT JOIN {S}.BUNDLES b ON b.ID = r.BUNDLE_ID
                              ORDER BY (r.STATUS = 'PENDING') DESC, r.CREATED_AT DESC LIMIT 200""")


def file_request(session, pl: dict) -> str:
    return session.call(f"{S}.FILE_REQUEST", _uuid(pl.get("bundle_id")), str(pl.get("target_role") or "")[:255],
                        str(pl.get("justification") or "")[:2000])


def decide(session, pl: dict, known_roles) -> dict:
    rid = _uuid(pl.get("id"))
    rows = _rows(session, f"SELECT * FROM {S}.REQUESTS WHERE ID = ?", [rid])
    if not rows or rows[0]["status"] != "PENDING":
        raise ValueError("request not found or already decided")
    r = rows[0]
    decision = str(pl.get("decision"))
    if decision not in ("reject", "approve", "apply"):
        raise ValueError("decision must be reject, approve or apply")
    out = {}
    lid = None
    if decision == "apply":
        out = apply(session, {"id": r["bundle_id"], "target_role": pl.get("target_role") or r["target_role"],
                              "cortex": pl.get("cortex"), "confirm": pl.get("confirm"), "request_id": rid}, known_roles)
        lid = out["log_id"]
    status = {"reject": "REJECTED", "approve": "APPROVED", "apply": "APPLIED" if out.get("ok") else "PARTIAL"}[decision]
    session.sql(f"""UPDATE {S}.REQUESTS SET STATUS = ?, DECIDED_BY = CURRENT_USER(), DECIDED_AT = CURRENT_TIMESTAMP(),
                    NOTE = ?, APPLY_LOG_ID = ? WHERE ID = ?""",
                params=[status, str(pl.get("note") or "")[:1000] or None, lid, rid]).collect()
    return dict(out, status=status)


# ------------------------------------------------------------------ router
def handle(session, action: str, pl: dict, known_roles, known_users, run_py) -> object:
    a = action[len("access_"):]
    if a == "assets":
        return run_py(lambda: list_assets(session))
    if a == "discover":
        src = _source(pl)
        return run_py(lambda: build(session, src, known_users))
    if a == "save":
        return run_py(lambda: save(session, pl, known_users))
    if a == "bundle":
        bid = _uuid(pl.get("id"))
        return run_py(lambda: refresh_live(session, get(session, bid)))
    if a == "delete":
        bid = _uuid(pl.get("id"))
        session.sql(f"DELETE FROM {S}.BUNDLES WHERE ID = ?", params=[bid]).collect()
        session.sql("DELETE FROM RBAC_EXPLORER_DB.ALERTS.WATCH_RULES WHERE KIND LIKE 'bundle_%' AND SPEC:bundle_id::STRING = ?",
                    params=[bid]).collect()
        return True
    if a == "principal":
        user = str(pl.get("user") or "")
        if user not in known_users():
            raise ValueError("unknown user")
        return run_py(lambda: principal(session, user))
    if a == "fix":
        return fix(session, pl, known_roles)
    if a == "apply":
        return run_py(lambda: apply(session, pl, known_roles))
    if a == "revert":
        return revert(session, pl)
    if a == "settings":
        if "apply_enabled" in pl:
            session.sql(f"INSERT INTO {S}.SETTINGS (K, V, UPDATED_BY) SELECT 'APPLY_ENABLED', ?::VARIANT, CURRENT_USER()",
                        params=[bool(pl["apply_enabled"])]).collect()
        return {"apply_enabled": apply_enabled(session)}
    if a == "requests":
        return requests(session)
    if a == "request_file":
        return file_request(session, pl)
    if a == "request_decide":
        return run_py(lambda: decide(session, pl, known_roles))
    if a == "log":
        return log(session)
    raise ValueError(f"unknown action {action}")
