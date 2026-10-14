"""RBAC model: the queries behind the explorer and the compact payload sent to React.

Account roles and users come from live SHOW commands. Role edges, user grants and
object privileges come from ACCOUNT_USAGE (up to ~2h behind, ~60s to scan), so
they run as parallel async queries and are cached per refresh.
"""
from __future__ import annotations

import datetime as dt

AU = "SNOWFLAKE.ACCOUNT_USAGE"

# Grantee id: account roles by name, database roles as DB.ROLE.
_GRANTEE = "IFF(GRANTED_TO = 'ROLE', GRANTEE_NAME, TABLE_CATALOG || '.' || GRANTEE_NAME)"
_LIVE = "DELETED_ON IS NULL AND GRANTED_TO IN ('ROLE', 'DATABASE_ROLE')"
_ROLE_KINDS = "('ROLE', 'DATABASE_ROLE', 'APPLICATION_ROLE')"

QUERIES = {
    # child role granted to parent role: parent inherits everything child has
    "edges": f"""
        SELECT IFF(GRANTED_ON = 'ROLE', NAME, TABLE_CATALOG || '.' || NAME) AS CHILD,
               GRANTED_ON AS CHILD_KIND, {_GRANTEE} AS PARENT, GRANTED_TO AS PARENT_KIND,
               CREATED_ON, GRANTED_BY
        FROM {AU}.GRANTS_TO_ROLES
        WHERE {_LIVE} AND GRANTED_ON IN {_ROLE_KINDS} AND PRIVILEGE = 'USAGE'""",
    "ugrants": f"""
        SELECT ROLE, GRANTEE_NAME AS USER_NAME, CREATED_ON, GRANTED_BY
        FROM {AU}.GRANTS_TO_USERS WHERE DELETED_ON IS NULL AND GRANTED_TO = 'USER'""",
    "grants": f"""
        SELECT {_GRANTEE} AS GRANTEE, GRANTED_ON AS OTYPE,
               CASE WHEN GRANTED_ON IN ('ACCOUNT', 'DATABASE') OR TABLE_CATALOG IS NULL THEN NAME
                    WHEN GRANTED_ON = 'SCHEMA' OR TABLE_SCHEMA IS NULL THEN TABLE_CATALOG || '.' || NAME
                    ELSE TABLE_CATALOG || '.' || TABLE_SCHEMA || '.' || NAME END AS OBJ,
               PRIVILEGE, GRANT_OPTION
        FROM {AU}.GRANTS_TO_ROLES
        WHERE {_LIVE} AND NOT (GRANTED_ON IN {_ROLE_KINDS} AND PRIVILEGE = 'USAGE')""",
}

SYSTEM_ROLES = ("ACCOUNTADMIN", "SECURITYADMIN", "USERADMIN", "SYSADMIN", "ORGADMIN", "PUBLIC")


def _iso(v):
    return v.isoformat() if isinstance(v, (dt.date, dt.datetime)) else (str(v) if v is not None else None)


def show(session, cmd: str) -> list[dict]:
    """SHOW ... as a list of dicts with lower-case keys."""
    return [{k.lower(): v for k, v in r.as_dict().items()} for r in session.sql(cmd).collect()]


def live_roles(session) -> list[dict]:
    return show(session, "SHOW ROLES")


def live_users(session) -> list[dict]:
    return show(session, "SHOW USERS")


def live_system_grants(session) -> list[list]:
    """Live user grants of the system roles. ACCOUNT_USAGE can miss grants made at
    account creation (e.g. the first ACCOUNTADMIN), and these matter most."""
    out = []
    for role in SYSTEM_ROLES[:5]:
        try:
            for g in show(session, f"SHOW GRANTS OF ROLE {role}"):
                if g.get("granted_to") == "USER":
                    out.append([g.get("grantee_name"), role, _iso(g.get("created_on")), g.get("granted_by") or None])
        except Exception:
            pass  # e.g. ORGADMIN not enabled on this account
    return out


def build_model(frames: dict, roles: list[dict], users: list[dict], account: str, extra_ugrants: list | None = None) -> dict:
    """Combine query results into index-based arrays (keeps the payload ~1 MB)."""
    idx: dict[str, int] = {}
    nodes: list[list] = []

    def node(rid: str, kind: str, owner=None, comment=None, created=None) -> int:
        if rid not in idx:
            idx[rid] = len(nodes)
            nodes.append([rid, kind, owner, comment, created])
        return idx[rid]

    for r in roles:
        node(r["name"], "sys" if r["name"] in SYSTEM_ROLES else "role",
             r.get("owner") or None, r.get("comment") or None, _iso(r.get("created_on")))

    kind_of = {"ROLE": "role", "DATABASE_ROLE": "db", "APPLICATION_ROLE": "app"}
    edges = []
    for e in frames["edges"].itertuples(index=False):
        # ACCOUNT_USAGE can still list a dropped account role briefly: skip those.
        if e.CHILD_KIND == "ROLE" and e.CHILD not in idx:
            continue
        if e.PARENT_KIND == "ROLE" and e.PARENT not in idx:
            continue
        c = node(e.CHILD, kind_of.get(e.CHILD_KIND, "app"))
        p = node(e.PARENT, kind_of.get(e.PARENT_KIND, "db"))
        edges.append([c, p, _iso(e.CREATED_ON), e.GRANTED_BY])

    uidx = {}
    ulist = []
    for u in users:
        uidx[u["name"]] = len(ulist)
        ulist.append({
            "name": u["name"], "type": (u.get("type") or "").upper() or None,
            "disabled": str(u.get("disabled")).lower() == "true",
            "default_role": u.get("default_role") or None,
            "default_warehouse": u.get("default_warehouse") or None,
            "secondary": u.get("default_secondary_roles") or None,
            "last_login": _iso(u.get("last_success_login")),
            "created": _iso(u.get("created_on")), "email": u.get("email") or None,
            "comment": u.get("comment") or None, "owner": u.get("owner") or None,
            "has_password": str(u.get("has_password")).lower() == "true",
            "has_rsa": str(u.get("has_rsa_public_key")).lower() == "true",
            "has_mfa": str(u.get("has_mfa")).lower() == "true",
            "has_pat": str(u.get("has_pat")).lower() == "true",
            "locked": str(u.get("snowflake_lock")).lower() == "true",
        })
    ugrants = [[uidx[g.USER_NAME], idx[g.ROLE], _iso(g.CREATED_ON), g.GRANTED_BY]
               for g in frames["ugrants"].itertuples(index=False)
               if g.USER_NAME in uidx and g.ROLE in idx]
    have = {(u, r) for u, r, _, _ in ugrants}
    for name, role, created, by in extra_ugrants or []:
        if name in uidx and role in idx and (uidx[name], idx[role]) not in have:
            ugrants.append([uidx[name], idx[role], created, by])

    oidx: dict[tuple, int] = {}
    objs: list[list] = []
    tidx: dict[str, int] = {}
    pidx: dict[str, int] = {}
    flat: list[int] = []
    for g in frames["grants"].itertuples(index=False):
        r = idx.get(g.GRANTEE)
        if r is None:      # grantee role is unreachable from any account role
            continue
        t = tidx.setdefault(g.OTYPE, len(tidx))
        name = g.OBJ if isinstance(g.OBJ, str) and g.OBJ else f"({g.OTYPE.lower()})"
        key = (t, name)
        o = oidx.get(key)
        if o is None:
            o = oidx[key] = len(objs)
            objs.append([t, name])
        p = pidx.setdefault(g.PRIVILEGE, len(pidx))
        flat += [r, o, p, 1 if str(g.GRANT_OPTION).lower() == "true" else 0]

    return {
        "asof": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "account": account,
        "nodes": nodes, "edges": edges, "users": ulist, "ugrants": ugrants,
        "otypes": list(tidx), "privs": list(pidx), "objs": objs, "grants": flat,
    }


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def live_role_detail(session, role: str) -> dict:
    """Current grantees and inherited roles of one account role, straight from SHOW."""
    q = quote_ident(role)
    of = show(session, f"SHOW GRANTS OF ROLE {q}")
    to = show(session, f"SHOW GRANTS TO ROLE {q}")
    return {
        "role": role,
        "asof": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "grantees": [{"type": g.get("granted_to"), "name": g.get("grantee_name"),
                      "granted_by": g.get("granted_by"), "created": _iso(g.get("created_on"))} for g in of],
        "privileges": len(to),
        "roles": sorted({g.get("name") for g in to if g.get("granted_on") in ("ROLE", "DATABASE_ROLE")}),
    }
