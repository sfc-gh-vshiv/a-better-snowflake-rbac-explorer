"""Access bundles: everything an AI asset needs before a person (or their AI tool) can use it.

An asset is a semantic view, custom tool (procedure or function), Cortex Search service, Cortex Agent
or Cortex Code skill. Discovery walks the stack from the asset down to the data, using live DESCRIBE
and SHOW commands, and returns a tree. `expand` flattens the tree into bundle items with the database
and schema USAGE each object implies. Every item also carries its live grantees (SHOW GRANTS ON),
because ACCOUNT_USAGE.GRANTS_TO_ROLES has no rows for semantic views or agents and lags up to 2h for
everything else (see docs/V2_FACTS.md).

The app imports this module directly. The watcher procedure imports the same file from
@RBAC_EXPLORER_DB.ALERTS.CODE, so drift checks discover bundles exactly the way the app does.
"""
from __future__ import annotations

import hashlib
import json
import re

# object type -> keyword used in SHOW GRANTS ON / GRANT ... ON
KW = {
    "DATABASE": "DATABASE", "SCHEMA": "SCHEMA", "TABLE": "TABLE", "VIEW": "VIEW",
    "MATERIALIZED VIEW": "MATERIALIZED VIEW", "DYNAMIC TABLE": "DYNAMIC TABLE", "EXTERNAL TABLE": "EXTERNAL TABLE",
    "SEMANTIC VIEW": "SEMANTIC VIEW", "AGENT": "AGENT", "CORTEX SEARCH SERVICE": "CORTEX SEARCH SERVICE",
    "PROCEDURE": "PROCEDURE", "FUNCTION": "FUNCTION", "WAREHOUSE": "WAREHOUSE", "STAGE": "STAGE",
}
DATA_TYPES = ("TABLE", "VIEW", "MATERIALIZED VIEW", "DYNAMIC TABLE", "EXTERNAL TABLE", "SEMANTIC VIEW")
CORTEX_ROLE = "SNOWFLAKE.CORTEX_USER"
CORTEX_AGENT_ROLE = "SNOWFLAKE.CORTEX_AGENT_USER"
MAX_ITEMS = 120
MAX_DEPTH = 4

_PART = re.compile(r'^(?:[A-Za-z_][A-Za-z0-9_$]*|"(?:[^"]|"")+")$')
_FQN3 = re.compile(r'(?<![A-Za-z0-9_$."])((?:[A-Za-z_][A-Za-z0-9_$]*|"[^"]+")\.(?:[A-Za-z_][A-Za-z0-9_$]*|"[^"]+")'
                   r'\.(?:[A-Za-z_][A-Za-z0-9_$]*|"[^"]+"))(?![A-Za-z0-9_$"])')
_SIG = re.compile(r"^\(\s*[A-Za-z0-9_ ,()]*\)$")
_WH = re.compile(r'\bwarehouse\b\s*[:=]?\s*[`"]?([A-Za-z_][A-Za-z0-9_$]*)', re.I)
_DOMAIN = {"Table": "TABLE", "View": "VIEW", "Materialized view": "MATERIALIZED VIEW", "Dynamic table": "DYNAMIC TABLE",
           "External table": "EXTERNAL TABLE", "Stage": "STAGE", "Procedure": "PROCEDURE", "Function": "FUNCTION",
           "Semantic view": "SEMANTIC VIEW", "Cortex Search Service": "CORTEX SEARCH SERVICE"}


def priv_for(otype: str) -> str:
    return "SELECT" if otype in DATA_TYPES else "READ" if otype == "STAGE" else "USAGE"


def lit(s: str) -> str:
    """SQL string literal for SHOW ... LIKE (which takes no bind parameters). Callers filter for the exact name,
    since _ and % still act as wildcards."""
    return "'" + str(s).replace("\\", "\\\\").replace("'", "''") + "'"


def _show(session, cmd: str, params=None) -> list[dict]:
    return [{k.lower(): v for k, v in r.as_dict().items()} for r in session.sql(cmd, params=params).collect()]


def split(fqn: str) -> list[str]:
    """DB.SCHEMA."My Name" -> parts, keeping quoted parts as written."""
    out, cur, q = [], "", False
    for c in fqn.strip():
        if c == '"':
            q = not q
        if c == "." and not q:
            out.append(cur)
            cur = ""
        else:
            cur += c
    out.append(cur)
    return out


def norm(fqn: str) -> str:
    """Canonical key: unquoted parts upper-cased, quoted parts kept as is, signature dropped."""
    base = fqn.split("(", 1)[0] if "(" in fqn and not fqn.startswith('"') else fqn
    return ".".join(p[1:-1].replace('""', '"') if p.startswith('"') else p.upper() for p in split(base))


def ident(fqn: str) -> str:
    """Identifier safe to splice into SQL. Raises on anything that isn't a plain or quoted name."""
    parts = split(fqn)
    if not parts or len(parts) > 3 or not all(_PART.match(p) for p in parts):
        raise ValueError(f"not a valid object name: {fqn[:80]}")
    return ".".join(parts)


def _quote(name: str) -> str:
    """Canonical (norm) part -> identifier part."""
    return name if re.match(r"^[A-Z_][A-Z0-9_$]*$", name) else '"' + name.replace('"', '""') + '"'


def from_norm(key: str) -> str:
    return ".".join(_quote(p) for p in key.split("."))


def item(otype: str, fqn: str, via: str, source: str, priv: str | None = None, **kw) -> dict:
    return {"otype": otype, "fqn": norm(fqn), "priv": priv or priv_for(otype), "via": via, "source": [source], **kw}


def node(kind: str, fqn: str, **kw) -> dict:
    return {"kind": kind, "fqn": norm(fqn) if kind != "skill" else fqn, "items": [], "children": [], "warnings": [], **kw}


# ------------------------------------------------------------------ schema catalog (one SHOW per kind per schema)
class Catalog:
    """Resolves bare db.schema.name references to an object type, caching SHOW per schema."""

    def __init__(self, session):
        self.s = session
        self.cache: dict[str, dict[str, tuple[str, str | None]]] = {}

    def schema(self, db_schema: str) -> dict[str, tuple[str, str | None]]:
        if db_schema in self.cache:
            return self.cache[db_schema]
        found: dict[str, tuple[str, str | None]] = {}
        q = from_norm(db_schema)
        # Specific kinds first: SHOW OBJECTS also lists semantic views (as views), and setdefault keeps the first hit.
        probes = [("SHOW SEMANTIC VIEWS IN SCHEMA", "SEMANTIC VIEW"),
                  ("SHOW AGENTS IN SCHEMA", "AGENT"), ("SHOW CORTEX SEARCH SERVICES IN SCHEMA", "CORTEX SEARCH SERVICE"),
                  ("SHOW PROCEDURES IN SCHEMA", "PROCEDURE"), ("SHOW USER FUNCTIONS IN SCHEMA", "FUNCTION"),
                  ("SHOW STAGES IN SCHEMA", "STAGE"), ("SHOW OBJECTS IN SCHEMA", None)]
        for cmd, t in probes:
            try:
                for r in _show(self.s, f"{cmd} {q}"):
                    kind = t or {"TABLE": "TABLE", "VIEW": "VIEW", "MATERIALIZED_VIEW": "MATERIALIZED VIEW",
                                 "MATERIALIZED VIEW": "MATERIALIZED VIEW", "EXTERNAL_TABLE": "EXTERNAL TABLE",
                                 "DYNAMIC_TABLE": "DYNAMIC TABLE"}.get(str(r.get("kind", "")).upper().replace(" ", "_"),
                                                                      str(r.get("kind", "TABLE")).upper())
                    sig = None
                    if t in ("PROCEDURE", "FUNCTION"):
                        m = re.match(r"^[^(]*(\([^)]*\))", str(r.get("arguments") or ""))
                        sig = m.group(1) if m else None
                    found.setdefault(str(r["name"]), (kind, sig))
            except Exception:
                pass  # kind not available in this account, or no privileges
        self.cache[db_schema] = found
        return found

    def kind(self, fqn_key: str) -> tuple[str, str | None] | None:
        parts = fqn_key.split(".")
        if len(parts) != 3:
            return None
        return self.schema(parts[0] + "." + parts[1]).get(parts[2])


# ------------------------------------------------------------------ discovery per layer
def semantic_view(session, fqn: str, via_agent: bool, via: str | None = None) -> dict:
    n = node("semantic_view", fqn)
    key = n["fqn"]
    n["items"].append(item("SEMANTIC VIEW", key, via or key, "ddl", root=True))
    tables: dict[str, dict] = {}
    try:
        for r in _show(session, f"DESCRIBE SEMANTIC VIEW {from_norm(key)}"):
            prop = str(r.get("property") or "")
            if prop.startswith("BASE_TABLE_"):
                t = tables.setdefault(str(r.get("object_name")), {})
                t[prop] = r.get("property_value")
    except Exception as e:
        n["warnings"].append(f"Couldn't describe the semantic view ({str(e)[:160]}). Grant MONITOR or REFERENCES on it to RBAC_EXPLORER_ROLE.")
        return n
    cat = Catalog(session)
    base = []
    for t in tables.values():
        fq = norm(".".join(_quote(str(t.get(k, ""))) for k in
                           ("BASE_TABLE_DATABASE_NAME", "BASE_TABLE_SCHEMA_NAME", "BASE_TABLE_NAME")))
        k = cat.kind(fq)
        base.append((k[0] if k else "TABLE", fq))
    n["base_tables"] = [fq for _, fq in base]
    if via_agent:
        for otype, fq in base:
            n["items"].append(item(otype, fq, key, "ddl", note="read by the SQL the agent generates"))
    return n


def tool(session, fqn: str, otype: str, sig: str | None, via: str | None = None) -> dict:
    n = node("procedure" if otype == "PROCEDURE" else "function", fqn)
    key = n["fqn"]
    parts = key.split(".")
    if not sig and len(parts) == 3:
        hit = Catalog(session).kind(key)
        sig = hit[1] if hit else None
    if sig and not _SIG.match(sig):
        sig = None
    if not sig:
        n["warnings"].append("Couldn't find the argument types, so the tool's signature is unknown.")
        sig = "()"
    n["sig"] = sig
    n["items"].append(item(otype, key, via or key, "ddl", root=True, sig=sig))
    try:
        desc = {str(r.get("property")).lower(): r.get("value") for r in
                _show(session, f"DESCRIBE {otype} {from_norm(key)}{sig}")}
    except Exception as e:
        n["warnings"].append(f"Couldn't describe the {otype.lower()} ({str(e)[:160]}).")
        return n
    rights = str(desc.get("execute as") or ("OWNER" if otype == "FUNCTION" else "")).upper()
    n["rights"] = rights or None
    if otype == "FUNCTION":
        n["warnings"].append("Objects a function reads aren't added. Check whether callers need them.")
    elif "CALLER" in rights:
        body = str(desc.get("body") or "")
        cat = Catalog(session)
        for ref in sorted({norm(x) for x in _FQN3.findall(body)}):
            if ref == key:
                continue
            k = cat.kind(ref)
            if k and k[0] in DATA_TYPES + ("STAGE",):
                n["items"].append(item(k[0], ref, key, "ddl", note="read by the procedure, which runs with caller's rights"))
    return n


def search_service(session, fqn: str, via: str | None = None) -> dict:
    n = node("search_service", fqn)
    n["items"].append(item("CORTEX SEARCH SERVICE", n["fqn"], via or n["fqn"], "spec", root=True))
    return n


def agent(session, fqn: str, depth: int = 0, via: str | None = None) -> dict:
    n = node("agent", fqn)
    key = n["fqn"]
    n["items"].append(item("AGENT", key, via or key, "spec", root=True))
    n["items"].append(item("DATABASE ROLE", CORTEX_AGENT_ROLE, key, "spec", alt=[CORTEX_ROLE, CORTEX_AGENT_ROLE],
                           note="CORTEX_USER or CORTEX_AGENT_USER (often granted through PUBLIC)"))
    n["needs_default_wh"] = True
    try:
        r = _show(session, f"DESCRIBE AGENT {from_norm(key)}")[0]
        spec = json.loads(r.get("agent_spec") or "{}")
    except Exception as e:
        n["warnings"].append(f"Couldn't describe the agent ({str(e)[:160]}). Grant MONITOR on it to RBAC_EXPLORER_ROLE.")
        return n
    n["spec_hash"] = hashlib.sha1(json.dumps(spec.get("tool_resources") or {}, sort_keys=True).encode()).hexdigest()[:12]
    res_all = spec.get("tool_resources") or {}
    for t in spec.get("tools") or []:
        ts = t.get("tool_spec") or {}
        name, typ = ts.get("name"), ts.get("type")
        res = res_all.get(name) or {}
        wh = ((res.get("execution_environment") or {}).get("warehouse") or "").strip()
        try:
            if res.get("semantic_view"):
                n["children"].append(dict(semantic_view(session, res["semantic_view"], True, key), tool=name))
            elif res.get("search_service"):
                n["children"].append(dict(search_service(session, res["search_service"], key), tool=name))
            elif res.get("identifier") and str(res.get("type", "")).lower() in ("procedure", "function"):
                m = re.search(r"(\([^)]*\))", str(res.get("name") or ""))
                otype = str(res["type"]).upper()
                n["children"].append(dict(tool(session, res["identifier"], otype, m.group(1) if m else None, key), tool=name))
            elif res.get("semantic_model_file"):
                n["warnings"].append(f"Tool {name} uses a semantic model file on a stage; add READ on that stage manually.")
            elif typ == "agent_toolset" and res.get("agent") and depth < MAX_DEPTH:
                n["children"].append(dict(agent(session, res["agent"], depth + 1, key), tool=name))
        except Exception as e:
            n["warnings"].append(f"Tool {name}: {str(e)[:160]}")
        if wh:
            n["items"].append(item("WAREHOUSE", wh, key, "spec", note=f"warehouse for tool {name}"))
    for sk in spec.get("skills") or []:
        path = str((sk.get("source") or {}).get("path") or "")
        m = re.match(r"^@([^/]+)", path)
        if m:
            n["items"].append(item("STAGE", m.group(1), key, "spec", note=f"skill {sk.get('name')}"))
    for ms in spec.get("mcp_servers") or []:
        n["warnings"].append(f"MCP server {((ms.get('server_spec') or {}).get('name'))}: its grants aren't modelled.")
    return n


def skill(session, text: str, learned: list[dict] | None = None) -> dict:
    """SKILL.md -> referenced assets (resolved against live SHOW) plus objects the author actually used."""
    m = re.search(r"^name:\s*(.+)$", text or "", re.M)
    n = node("skill", (m.group(1).strip() if m else "skill")[:120])
    cat = Catalog(session)
    seen = set()
    for raw in _FQN3.findall(text or ""):
        ref = norm(raw)
        if ref in seen:
            continue
        seen.add(ref)
        k = cat.kind(ref)
        if not k:
            n["warnings"].append(f"{ref}: not found, or not visible to RBAC_EXPLORER_ROLE.")
            continue
        _attach(session, n, k[0], ref, k[1], "skill_md")
    for w in sorted({x.upper() for x in _WH.findall(text or "")}):
        try:
            if any(r["name"] == w for r in _show(session, f"SHOW WAREHOUSES LIKE {lit(w)}")):
                n["items"].append(item("WAREHOUSE", w, n["fqn"], "skill_md"))
        except Exception:
            pass
    for x in learned or []:
        ref, otype = norm(x["fqn"]), x["otype"]
        hit = [i for i in _all_items(n) if i["fqn"] == ref]
        if hit:
            for i in hit:
                i["source"] = sorted(set(i["source"]) | {"access_history"})
                i["uses"] = x.get("n")
            continue
        _attach(session, n, otype, ref, None, "access_history", suggested=True, uses=x.get("n"))
    return n


def _attach(session, n: dict, otype: str, ref: str, sig, source: str, **kw) -> None:
    if otype == "AGENT":
        c = agent(session, ref, 1, n["fqn"])
    elif otype == "SEMANTIC VIEW":
        c = semantic_view(session, ref, False, n["fqn"])
    elif otype == "CORTEX SEARCH SERVICE":
        c = search_service(session, ref, n["fqn"])
    elif otype in ("PROCEDURE", "FUNCTION"):
        c = tool(session, ref, otype, sig, n["fqn"])
    else:
        n["items"].append(item(otype, ref, n["fqn"], source, **kw))
        return
    for i in _all_items(c):
        i["source"] = [source]
        i.update(kw)
    n["children"].append(dict(c, source=source, **{k: v for k, v in kw.items() if k == "suggested"}))


def learn(session, user: str, days: int, cli_only: bool) -> list[dict]:
    """Objects a user touched directly in the last `days` (ACCOUNT_USAGE.ACCESS_HISTORY, Enterprise edition)."""
    days = max(1, min(int(days or 14), 90))
    tag = "AND qh.QUERY_TAG ILIKE '%cortex_code%'" if cli_only else ""
    join = "JOIN SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY qh ON qh.QUERY_ID = ah.QUERY_ID" if cli_only else ""
    rows = session.sql(f"""
        SELECT o.value:"objectName"::STRING AS FQN, o.value:"objectDomain"::STRING AS DOMAIN, COUNT(*) AS N
        FROM SNOWFLAKE.ACCOUNT_USAGE.ACCESS_HISTORY ah {join},
             LATERAL FLATTEN(ah.DIRECT_OBJECTS_ACCESSED) o
        WHERE ah.USER_NAME = ? AND ah.QUERY_START_TIME > DATEADD(day, -{days}, CURRENT_TIMESTAMP()) {tag}
          AND o.value:"objectName"::STRING NOT ILIKE 'SNOWFLAKE.%'
          AND o.value:"objectName"::STRING NOT ILIKE 'USER$%'
        GROUP BY 1, 2 ORDER BY N DESC LIMIT 200""", params=[user]).collect()
    out = []
    for r in rows:
        otype = _DOMAIN.get(str(r["DOMAIN"]))
        if otype and r["FQN"] and len(split(r["FQN"])) == 3:
            out.append({"fqn": r["FQN"], "otype": otype, "n": int(r["N"])})
    return out


def discover(session, kind: str, fqn: str = "", text: str = "", learned: list[dict] | None = None) -> dict:
    if kind == "agent":
        return agent(session, ident(fqn))
    if kind == "semantic_view":
        return semantic_view(session, ident(fqn), False)
    if kind == "search_service":
        return search_service(session, ident(fqn))
    if kind in ("procedure", "function"):
        base, _, rest = fqn.partition("(")
        return tool(session, ident(base), kind.upper(), "(" + rest if rest else None)
    if kind == "skill":
        return skill(session, text[:200_000], learned)
    raise ValueError(f"unknown asset kind {kind}")


# ------------------------------------------------------------------ bundle = flattened, expanded tree
def _all_items(n: dict) -> list[dict]:
    out = list(n["items"])
    for c in n["children"]:
        out += _all_items(c)
    return out


def expand(tree: dict) -> list[dict]:
    """Flatten and add the database/schema USAGE each schema object needs. Dedupe by (type, name)."""
    out: dict[tuple, dict] = {}

    def add(i: dict) -> None:
        k = (i["otype"], i["fqn"])
        cur = out.get(k)
        if cur is None:
            out[k] = dict(i, source=list(i["source"]))
            return
        cur["source"] = sorted(set(cur["source"]) | set(i["source"]))
        cur["root"] = cur.get("root") or i.get("root")
        cur["suggested"] = bool(cur.get("suggested")) and bool(i.get("suggested"))

    top = {id(i) for i in tree["items"]}
    for i in _all_items(tree):
        add(dict(i, root=bool(i.get("root")) and id(i) in top))  # only the asset itself is root, not its tools
        parts = i["fqn"].split(".")
        if i["otype"] not in ("DATABASE ROLE", "WAREHOUSE", "DATABASE", "SCHEMA") and len(parts) == 3:
            add(dict(item("DATABASE", parts[0], i["fqn"], i["source"][0]), suggested=i.get("suggested", False)))
            add(dict(item("SCHEMA", parts[0] + "." + parts[1], i["fqn"], i["source"][0]), suggested=i.get("suggested", False)))
    order = {"AGENT": 0, "SEMANTIC VIEW": 1, "CORTEX SEARCH SERVICE": 1, "PROCEDURE": 2, "FUNCTION": 2,
             "DATABASE ROLE": 3, "WAREHOUSE": 4, "DATABASE": 5, "SCHEMA": 6, "STAGE": 7}
    items = sorted(out.values(), key=lambda i: (not i.get("root"), order.get(i["otype"], 8), i["fqn"]))
    for i in items:
        i["key"] = i["otype"] + "|" + i["fqn"]
    return items[:MAX_ITEMS]


def live_grants(session, items: list[dict]) -> None:
    """Attach the current grantees of each item (role id, privilege). Database roles are DB.ROLE."""
    for i in items:
        try:
            if i["otype"] == "DATABASE ROLE":
                rows = _show(session, f"SHOW GRANTS OF DATABASE ROLE {from_norm(i['fqn'])}")
                i["live"] = sorted({(r["grantee_name"], "USAGE") for r in rows if r.get("granted_to") == "ROLE"})
                if any(a != i["fqn"] for a in i.get("alt") or []):
                    for a in i["alt"]:
                        if a != i["fqn"]:
                            rows = _show(session, f"SHOW GRANTS OF DATABASE ROLE {from_norm(a)}")
                            i["live"] = sorted(set(i["live"]) | {(r["grantee_name"], "USAGE") for r in rows
                                                                 if r.get("granted_to") == "ROLE"})
                i["live"] = [list(x) for x in i["live"]]
                continue
            target = from_norm(i["fqn"]) + (i.get("sig") or "")
            rows = _show(session, f"SHOW GRANTS ON {KW[i['otype']]} {target}")
            db = i["fqn"].split(".")[0]
            live = set()
            for r in rows:
                to, name = r.get("granted_to"), str(r.get("grantee_name") or "")
                if to == "ROLE":
                    live.add((name, r.get("privilege")))
                elif to == "DATABASE_ROLE":
                    live.add((name if "." in name else f"{db}.{name}", r.get("privilege")))
            i["live"] = [list(x) for x in sorted(live)]
        except Exception as e:
            i["live"] = None
            i["error"] = str(e)[:160]


def build(session, kind: str, fqn: str = "", text: str = "", learned: list[dict] | None = None) -> dict:
    tree = discover(session, kind, fqn, text, learned)
    items = expand(tree)
    live_grants(session, items)
    return {"kind": kind, "fqn": tree["fqn"], "tree": tree, "items": items, "hash": bundle_hash(items),
            "needs_default_wh": any(c.get("needs_default_wh") for c in _walk(tree))}


def _walk(n: dict):
    yield n
    for c in n["children"]:
        yield from _walk(c)


def bundle_hash(items: list[dict]) -> str:
    return hashlib.sha1("\n".join(sorted(i["key"] for i in items if not i.get("suggested"))).encode()).hexdigest()[:16]


# ------------------------------------------------------------------ least-privilege access role
_PROTECTED = {"ACCOUNTADMIN", "SECURITYADMIN", "USERADMIN", "ORGADMIN", "GLOBALORGADMIN", "SYSADMIN", "PUBLIC",
              "RBAC_EXPLORER_ROLE"}


def ar_name(kind: str, fqn: str) -> str:
    base = re.sub(r"[^A-Z0-9_]", "_", fqn.split(".")[-1].upper())[:120] or "ASSET"
    return "AR_" + base


def fix_sql(bundle: dict, target_role: str | None, include_cortex: bool) -> list[str]:
    """Statements that make AR_<asset> hold the whole bundle, then grant it to the target role.

    Generated only from the stored bundle (never from client text), so apply can re-derive and
    compare. Every statement is a CREATE ROLE AR_*, a GRANT ... TO ROLE AR_*, or a GRANT ROLE AR_* TO ROLE.
    """
    ar = ar_name(bundle["kind"], bundle["fqn"])
    out = [f"CREATE ROLE IF NOT EXISTS {ar} COMMENT = 'Role Explorer access role for {bundle['kind']} "
           f"{bundle['fqn'].replace(chr(39), '')[:200]}'",
           f"GRANT ROLE {ar} TO ROLE SYSADMIN"]
    for i in bundle["items"]:
        if i.get("suggested") and not i.get("on"):
            continue
        if i.get("on") is False:
            continue
        if i["otype"] == "DATABASE ROLE":
            if include_cortex:
                out.append(f"GRANT DATABASE ROLE {from_norm(i['fqn'])} TO ROLE {ar}")
            continue
        out.append(f"GRANT {i['priv']} ON {KW[i['otype']]} {from_norm(i['fqn'])}{i.get('sig') or ''} TO ROLE {ar}")
    if target_role:
        if target_role.upper() in _PROTECTED:
            raise ValueError(f"won't grant an access role to {target_role}")
        out.append(f"GRANT ROLE {ar} TO ROLE {_quote(target_role) if target_role != target_role.upper() else target_role}")
    return out


_ALLOWED = [
    re.compile(r"^CREATE ROLE IF NOT EXISTS AR_[A-Z0-9_]+ COMMENT = '[^']*'$"),
    re.compile(r"^GRANT ROLE AR_[A-Z0-9_]+ TO ROLE [A-Za-z0-9_$\"]+$"),
    re.compile(r"^GRANT DATABASE ROLE SNOWFLAKE\.CORTEX_(AGENT_)?USER TO ROLE AR_[A-Z0-9_]+$"),
    re.compile(r"^GRANT (SELECT|USAGE|READ) ON (" + "|".join(KW.values()) + r") [A-Za-z0-9_$.\"]+(\([A-Za-z0-9_ ,()]*\))? TO ROLE AR_[A-Z0-9_]+$"),
]


def allowed(stmt: str) -> bool:
    return any(p.match(stmt) for p in _ALLOWED)
