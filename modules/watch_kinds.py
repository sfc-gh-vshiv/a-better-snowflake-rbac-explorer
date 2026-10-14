"""Custom alert kinds: spec validation and live detection, shared by the app and the watcher.

The app imports this module for previews and saving; the CHECK_PROTECTED_ROLES procedure
imports the same file from @RBAC_EXPLORER_DB.ALERTS.CODE, so a preview and the
every-minute check never disagree. Detection uses live SHOW commands only (no
ACCOUNT_USAGE lag). Every rule keeps a baseline of keys; a key that appears later
is an alert, a key that disappears is resolved.
"""
from __future__ import annotations

import json
import re

try:  # the watcher procedure imports both files flat from the CODE stage
    import asset_kinds as ak
except ImportError:
    try:  # the app imports them as a package
        from modules import asset_kinds as ak
    except ImportError:  # a v1 watcher that only imports watch_kinds.py: bundle kinds are unavailable there
        ak = None

KINDS = ("admin_holders", "sensitive_privilege", "new_principal", "bundle_drift", "bundle_broken")
BUNDLES = "RBAC_EXPLORER_DB.ACCESS.BUNDLES"
_UUID = re.compile(r"^[0-9a-fA-F-]{36}$")
PRIVILEGES = (
    "MANAGE GRANTS", "CREATE USER", "CREATE ROLE", "CREATE INTEGRATION", "CREATE DATABASE", "CREATE WAREHOUSE",
    "CREATE SHARE", "CREATE NETWORK POLICY", "CREATE ACCOUNT", "EXECUTE TASK", "EXECUTE MANAGED TASK", "MONITOR USAGE",
    "MONITOR EXECUTION", "IMPORT SHARE", "APPLY MASKING POLICY", "APPLY ROW ACCESS POLICY", "APPLY TAG",
    "MANAGE ACCOUNT SUPPORT CASES", "OVERRIDE SHARE RESTRICTIONS", "OWNERSHIP", "ALL PRIVILEGES",
    "USAGE", "MODIFY", "MONITOR", "CREATE SCHEMA", "APPLYBUDGET",
)
USER_TYPES = ("PERSON", "SERVICE", "LEGACY_SERVICE")
_PAT = re.compile(r"^[A-Za-z0-9_*?$.\-]{1,100}$")
MAX_ROLES_WALKED = 200
MAX_DATABASES = 20


def _q(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def _show(session, cmd: str) -> list[dict]:
    return [{k.lower(): v for k, v in r.as_dict().items()} for r in session.sql(cmd).collect()]


def glob_re(pattern: str) -> re.Pattern:
    """Glob with only * and ?; everything else literal. Case-insensitive, whole name."""
    if not _PAT.match(pattern or ""):
        raise ValueError("name pattern may use letters, digits, _ $ . - and the wildcards * and ?")
    out = "".join(".*" if c == "*" else "." if c == "?" else re.escape(c) for c in pattern)
    return re.compile(f"^{out}$", re.I)


def _names(values, allowed: set, what: str, limit: int = 200) -> list[str]:
    out = []
    for v in (values or [])[:limit]:
        v = str(v).strip()
        if not v:
            continue
        hit = next((a for a in allowed if a.upper() == v.upper()), None)
        if hit is None:
            raise ValueError(f"unknown {what}: {v}")
        out.append(hit)
    return sorted(set(out))


def clean_spec(kind: str, spec: dict, roles: set, users: set) -> dict:
    """Whitelist every field. Raises ValueError with a message the UI shows as is."""
    spec = spec or {}
    if kind == "admin_holders":
        rs = _names(spec.get("roles"), roles, "role", 20)
        if not rs:
            raise ValueError("pick at least one role to watch")
        return {"roles": rs, "inherited": bool(spec.get("inherited", True)),
                "allowed_users": _names(spec.get("allowed_users"), users, "user")}
    if kind == "sensitive_privilege":
        privs = []
        for p in spec.get("privileges") or []:
            p = " ".join(str(p).upper().split())
            if p not in PRIVILEGES:
                raise ValueError(f"unsupported privilege: {p}")
            privs.append(p)
        if not privs:
            raise ValueError("pick at least one privilege")
        scope = spec.get("scope") or "ACCOUNT"
        if isinstance(scope, dict):
            dbs = [str(d).strip().upper() for d in (scope.get("databases") or []) if str(d).strip()]
            if not dbs or len(dbs) > MAX_DATABASES:
                raise ValueError(f"list 1 to {MAX_DATABASES} databases")
            for d in dbs:
                if not re.match(r"^[A-Z0-9_$]{1,255}$", d):
                    raise ValueError(f"invalid database name: {d}")
            scope = {"databases": sorted(set(dbs))}
        elif str(scope).upper() != "ACCOUNT":
            raise ValueError("scope must be ACCOUNT or a list of databases")
        else:
            scope = "ACCOUNT"
        return {"privileges": sorted(set(privs)), "scope": scope, "except_roles": _names(spec.get("except_roles"), roles, "role")}
    if kind == "new_principal":
        obj = str(spec.get("object") or "USER").upper()
        if obj not in ("USER", "ROLE"):
            raise ValueError("object must be USER or ROLE")
        pat = (spec.get("name_pattern") or "").strip() or None
        if pat:
            glob_re(pat)
        ut = (spec.get("user_type") or "").upper() or None
        if ut and (obj != "USER" or ut not in USER_TYPES):
            raise ValueError("user type applies to users only: PERSON, SERVICE or LEGACY_SERVICE")
        owners = _names(spec.get("owner_in"), roles, "owner role")
        return {"object": obj, "name_pattern": pat, "user_type": ut, "owner_in": owners}
    if kind in ("bundle_drift", "bundle_broken"):
        bid = str(spec.get("bundle_id") or "")
        if not _UUID.match(bid):
            raise ValueError("pick a saved access bundle")
        return {"bundle_id": bid, "asset": str(spec.get("asset") or "")[:300]}
    raise ValueError(f"unknown alert kind {kind}")


def describe(kind: str, spec: dict) -> str:
    if kind == "admin_holders":
        how = "directly or through another role" if spec.get("inherited") else "directly"
        ok = f" (except {', '.join(spec['allowed_users'])})" if spec.get("allowed_users") else ""
        return f"Anyone new gets {', '.join(spec['roles'])} {how}{ok}"
    if kind == "sensitive_privilege":
        where = "the account" if spec["scope"] == "ACCOUNT" else "database " + ", ".join(spec["scope"]["databases"])
        ex = f", except {', '.join(spec['except_roles'])}" if spec.get("except_roles") else ""
        return f"A role is granted {', '.join(spec['privileges'])} on {where}{ex}"
    if kind == "bundle_drift":
        return f"{spec.get('asset') or 'An asset'} gains a dependency that its access bundle doesn't cover"
    if kind == "bundle_broken":
        return f"A grant in the access role for {spec.get('asset') or 'an asset'} goes missing"
    bits = [f"A new {spec['object'].lower()} is created"]
    if spec.get("name_pattern"):
        bits.append(f"named like {spec['name_pattern']}")
    if spec.get("user_type"):
        bits.append(f"of type {spec['user_type']}")
    if spec.get("owner_in"):
        bits.append(f"owned by {', '.join(spec['owner_in'])}")
    return " ".join(bits)


# ------------------------------------------------------------ live state
def _admin_state(session, spec) -> dict:
    """Effective users of each role: SHOW GRANTS OF ROLE upward through parent roles."""
    allowed = {u.upper() for u in spec.get("allowed_users") or []}
    items = {}
    for target in spec["roles"]:
        seen, queue = {target.upper()}, [(target, [target], None)]
        walked = 0
        while queue and walked < MAX_ROLES_WALKED:
            role, chain, _ = queue.pop(0)
            walked += 1
            for g in _show(session, f"SHOW GRANTS OF ROLE {_q(role)}"):
                to, name = (g.get("granted_to") or "").upper(), g.get("grantee_name")
                if to == "USER" and name.upper() not in allowed:
                    key = f"{target}|{name}"
                    if key not in items:
                        items[key] = {"role": target, "gtype": "USER", "grantee": name,
                                      "path": " -> ".join([name] + list(reversed(chain))),
                                      "granted_at": g.get("created_on"), "by_role": g.get("granted_by"),
                                      "direct_role": role}
                elif to == "ROLE" and spec.get("inherited") and name.upper() not in seen:
                    seen.add(name.upper())
                    queue.append((name, chain + [name], role))
    return items


def _priv_state(session, spec) -> dict:
    want, skip = set(spec["privileges"]), {r.upper() for r in spec.get("except_roles") or []}
    cmds = ["SHOW GRANTS ON ACCOUNT"] if spec["scope"] == "ACCOUNT" else \
        [f"SHOW GRANTS ON DATABASE {_q(d)}" for d in spec["scope"]["databases"]]
    items = {}
    for cmd in cmds:
        for g in _show(session, cmd):
            p, to, who = (g.get("privilege") or "").upper(), (g.get("granted_to") or "").upper(), g.get("grantee_name") or ""
            if p not in want or to not in ("ROLE", "DATABASE_ROLE", "APPLICATION_ROLE") or who.upper() in skip:
                continue
            on = f"{(g.get('granted_on') or '').lower()} {g.get('name') or ''}".strip()
            items[f"{p}|{on}|{who}"] = {"role": who, "gtype": to, "grantee": who, "privilege": p, "on": on,
                                       "granted_at": g.get("created_on"), "by_role": g.get("granted_by")}
    return items


def _new_state(session, spec) -> dict:
    rx = glob_re(spec["name_pattern"]) if spec.get("name_pattern") else None
    owners = {o.upper() for o in spec.get("owner_in") or []}
    items = {}
    for x in _show(session, "SHOW USERS" if spec["object"] == "USER" else "SHOW ROLES"):
        name = x.get("name") or ""
        if rx and not rx.match(name):
            continue
        if spec.get("user_type") and (x.get("type") or "PERSON").upper() != spec["user_type"]:
            continue
        if owners and (x.get("owner") or "").upper() not in owners:
            continue
        items[name] = {"role": name if spec["object"] == "ROLE" else None, "gtype": spec["object"], "grantee": name,
                       "user_type": x.get("type") if spec["object"] == "USER" else None, "owner": x.get("owner"),
                       "granted_at": x.get("created_on"), "by_role": x.get("owner")}
    return items


def _bundle(session, bid: str) -> dict:
    rows = session.sql(f"SELECT KIND, FQN, SOURCE, ITEMS, AR_ROLE FROM {BUNDLES} WHERE ID = ?", params=[bid]).collect()
    if not rows:
        raise ValueError("the access bundle was deleted")
    r = rows[0].as_dict()
    load = lambda v: json.loads(v) if isinstance(v, str) else (v or {})  # noqa: E731
    return {"kind": r["KIND"], "fqn": r["FQN"], "source": load(r["SOURCE"]), "items": load(r["ITEMS"]) or [],
            "ar": r["AR_ROLE"]}


def _drift_state(session, spec) -> dict:
    """Dependencies the asset has right now. Baseline = the saved bundle, so a new key is a new dependency."""
    b = _bundle(session, spec["bundle_id"])
    src = b["source"]
    tree = ak.discover(session, b["kind"], b["fqn"], src.get("text") or "")
    return {i["key"]: {"asset": b["fqn"], "otype": i["otype"], "fqn": i["fqn"], "priv": i["priv"], "via": i["via"],
                       "ar": b["ar"] or ak.ar_name(b["kind"], b["fqn"]), "sig": i.get("sig"),
                       "grantee": b["fqn"], "gtype": "AI asset"}
            for i in ak.expand(tree) if not i.get("suggested")}


def _broken_state(session, spec) -> dict:
    """Grants the bundle's access role should hold but doesn't. Empty until the role exists."""
    b = _bundle(session, spec["bundle_id"])
    ar = b["ar"]
    if not ar:
        return {}
    try:
        have = {(g["privilege"], ak.norm(str(g["name"]))) for g in _show(session, f"SHOW GRANTS TO ROLE {_q(ar)}")}
    except Exception:
        return {}  # role not created yet, or dropped (a dropped role shows up as every grant missing below)
    out = {}
    for i in b["items"]:
        if i["otype"] == "DATABASE ROLE" or i.get("on") is False or (i.get("suggested") and not i.get("on")):
            continue
        if (i["priv"], i["fqn"]) not in have:
            out[i["key"]] = {"asset": b["fqn"], "otype": i["otype"], "fqn": i["fqn"], "priv": i["priv"], "ar": ar,
                             "sig": i.get("sig"), "grantee": ar, "gtype": "access role"}
    return out


def state(session, kind: str, spec: dict) -> dict:
    return {"admin_holders": _admin_state, "sensitive_privilege": _priv_state, "new_principal": _new_state,
            "bundle_drift": _drift_state, "bundle_broken": _broken_state}[kind](session, spec)


def reason(kind: str, spec: dict, v: dict) -> str:
    if kind == "bundle_drift":
        return f"now needs {v['priv']} on {v['otype'].lower()} {v['fqn']} (via {v['via']}), which {v['ar']} doesn't grant yet"
    if kind == "bundle_broken":
        return f"no longer holds {v['priv']} on {v['otype'].lower()} {v['fqn']}, so {v['asset']} is partly broken for its users"
    if kind == "admin_holders":
        return f"can now use {v['role']} ({v['path']})"
    if kind == "sensitive_privilege":
        return f"was granted {v['privilege']} on {v['on']}"
    return describe(kind, spec).replace("A new", "new", 1) + (f"; owner {v['owner']}" if v.get("owner") else "")


def fix_sql(kind: str, v: dict) -> str | None:
    if kind in ("bundle_drift", "bundle_broken") and v.get("otype") in ak.KW:
        return f"GRANT {v['priv']} ON {ak.KW[v['otype']]} {ak.from_norm(v['fqn'])}{v.get('sig') or ''} TO ROLE {_q(v['ar'])};"
    if kind == "admin_holders":
        return f"REVOKE ROLE {_q(v['direct_role'])} FROM USER {_q(v['grantee'])};"
    if kind == "sensitive_privilege":
        on = v["on"].split(" ", 1)
        target = "ACCOUNT" if on[0] == "account" else f"{on[0].upper()} {_q(on[1])}"
        return f"REVOKE {v['privilege']} ON {target} FROM {v['gtype'].replace('_', ' ')} {_q(v['grantee'])};"
    return None


def diff(current: dict, baseline: list | None) -> tuple[list[str], list[str]]:
    """Keys that are new since the baseline, and baseline keys that are gone."""
    base = set(baseline or [])
    return sorted(k for k in current if k not in base), sorted(k for k in base if k not in current)
