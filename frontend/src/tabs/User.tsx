import React, { useMemo, useState } from "react";
import { setStore, useStore } from "../kit";
import { RBAC, rankOf } from "../graph";
import { Metric, Path, Picker, RoleChip, Section, Split, ago, fmt } from "../ui";

export function UserTab({ m }: { m: RBAC }) {
  const s = useStore();
  const u = s.user ? m.raw.users.findIndex((x) => x.name === s.user) : -1;
  const items = useMemo(() => m.raw.users.map((x, i) => ({ label: x.name, value: i,
    hint: `${x.type || "PERSON"}${x.disabled ? " · disabled" : ""}` })).sort((a, b) => a.label.localeCompare(b.label)), [m]);
  return (
    <Split id="user" init={300}>
      <div className="card"><h3>Users</h3><Picker items={items} value={u} onPick={(i) => setStore({ user: m.raw.users[i].name })} placeholder="Find a user" /></div>
      <div className="card">{u < 0 ? <div className="empty">Pick a user to see every role they can use and everything they can touch.</div> : <UserPanel m={m} u={u} />}</div>
    </Split>
  );
}

function UserPanel({ m, u }: { m: RBAC; u: number }) {
  const x = m.raw.users[u];
  const [q, setQ] = useState("");
  const reach = m.userReach(u);
  const roles = [...reach].sort((a, b) => m.ids[a].localeCompare(m.ids[b]));
  const keys = m.userKeys(u);
  const priv = useMemo(() => {
    // best privilege per object across all reachable roles
    const best = new Map<number, { p: string; via: number; all: Set<string> }>();
    for (const r of reach) for (const g of m.grantsByRole[r]) {
      const o = m.gObj(g), p = m.gPriv(g);
      const cur = best.get(o);
      if (!cur) best.set(o, { p, via: r, all: new Set([p]) });
      else { cur.all.add(p); if (rankOf(p) > rankOf(cur.p)) { cur.p = p; cur.via = r; } }
    }
    return [...best.entries()];
  }, [m, u]);
  const t = q.trim().toUpperCase();
  const rows = priv.filter(([o]) => !t || m.objName(o).toUpperCase().includes(t)).sort((a, b) => rankOf(b[1].p) - rankOf(a[1].p));
  const svc = (x.type || "").includes("SERVICE");
  const auth = [x.has_password && "password", x.has_mfa && "MFA", x.has_rsa && "key pair", x.has_pat && "PAT"].filter(Boolean).join(" · ") || "none";
  const aa = m.byId.get("ACCOUNTADMIN");
  return (
    <div>
      <div className="between" style={{ marginBottom: 8 }}>
        <div className="row">
          <span className="chip" style={{ fontSize: 14, cursor: "default", background: svc ? "#eef2ff" : "#fff", borderColor: svc ? "#7159FF" : "rgba(11,118,168,.3)" }}>{svc ? "⚙ " : ""}{x.name}</span>
          <span className={"pill " + (svc ? "info" : "plain")}>{x.type || "PERSON"}</span>
          {x.disabled && <span className="pill bad">disabled</span>}
          {x.locked && <span className="pill bad">locked</span>}
          {aa !== undefined && reach.has(aa) && <span className="pill warn">can use ACCOUNTADMIN</span>}
        </div>
      </div>
      <div className="kv" style={{ marginBottom: 10 }}>
        <span className="k">Default role</span><span>{x.default_role || "—"}</span>
        <span className="k">Secondary roles</span><span>{x.secondary || "—"}</span>
        <span className="k">Last login</span><span>{x.last_login ? `${x.last_login.slice(0, 16).replace("T", " ")} · ${ago(x.last_login)}` : "never"}</span>
        <span className="k">Sign-in</span><span>{auth}</span>
        {x.email && <><span className="k">Email</span><span>{x.email}</span></>}
        {x.comment && <><span className="k">Comment</span><span>{x.comment}</span></>}
      </div>
      <div className="grid g4" style={{ marginBottom: 10 }}>
        <Metric l="Granted roles" v={m.userRoles[u].length} s="plus PUBLIC" />
        <Metric l="Usable roles" v={reach.size} s="incl. inherited" />
        <Metric l="Objects" v={fmt(priv.length)} />
        <Metric l="Privileges" v={fmt(keys.size)} s="distinct object + privilege" />
      </div>
      {x.secondary && x.secondary.includes("ALL") && <div className="callout" style={{ marginBottom: 10 }}>Secondary roles are <b>ALL</b>, so this user can exercise every privilege below at once, not just the active role's.</div>}
      <h3>Granted roles</h3>
      <div className="row" style={{ marginBottom: 12 }}>{m.userRoles[u].map((r) => <RoleChip key={r} m={m} r={r} />)}{!m.userRoles[u].length && <span className="muted">only PUBLIC</span>}</div>
      <h3>Everything they can use <span className="muted">({roles.length} roles)</span></h3>
      <div className="row" style={{ marginBottom: 12, maxHeight: 120, overflow: "auto" }}>{roles.map((r) => <RoleChip key={r} m={m} r={r} />)}</div>
      <h3>Objects</h3>
      <input className="txt" style={{ width: "100%", marginBottom: 6 }} placeholder="Filter objects" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="scroll"><table className="t"><thead><tr><th>Object</th><th>Type</th><th>Highest privilege</th><th>Via</th></tr></thead><tbody>
        {rows.slice(0, 400).map(([o, v]) => (
          <tr key={o}>
            <td className="mono" style={{ wordBreak: "break-all", cursor: "pointer" }} onClick={() => setStore({ obj: o, tab: "access" })}>{m.objName(o)}</td>
            <td className="muted">{m.objType(o).toLowerCase()}</td>
            <td title={[...v.all].join(", ")}><span className={"pill " + (v.p === "OWNERSHIP" ? "bad" : rankOf(v.p) >= 3 ? "warn" : "info")}>{v.p}</span>{v.all.size > 1 && <span className="muted"> +{v.all.size - 1}</span>}</td>
            <td><RoleChip m={m} r={v.via} /></td>
          </tr>
        ))}
      </tbody></table></div>
      {rows.length > 400 && <div className="muted" style={{ fontSize: 12 }}>Showing 400 of {fmt(rows.length)}.</div>}
    </div>
  );
}

export function AccessTab({ m }: { m: RBAC }) {
  const s = useStore();
  const [type, setType] = useState("");
  const items = useMemo(() => m.raw.objs.map((o, i) => ({ label: String(o[1] ?? ""), value: i, hint: m.raw.otypes[o[0]].toLowerCase(), t: m.raw.otypes[o[0]] }))
    .filter((x) => !type || x.t === type).sort((a, b) => a.label.localeCompare(b.label)), [m, type]);
  const types = useMemo(() => {
    const c: Record<string, number> = {};
    m.raw.objs.forEach((o) => (c[m.raw.otypes[o[0]]] = (c[m.raw.otypes[o[0]]] || 0) + 1));
    return Object.entries(c).sort((a, b) => b[1] - a[1]);
  }, [m]);
  return (
    <Split id="user-who" init={340}>
      <div className="card">
        <h3>Who can access…</h3>
        <select className="txt" style={{ width: "100%", marginBottom: 6 }} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All object types ({fmt(m.raw.objs.length)})</option>
          {types.map(([t, n]) => <option key={t} value={t}>{t.toLowerCase()} ({fmt(n)})</option>)}
        </select>
        <Picker items={items} value={s.obj} onPick={(o) => setStore({ obj: o })} placeholder="Search tables, schemas, warehouses…" />
      </div>
      <div className="card">{s.obj === null || !m.raw.objs[s.obj] ? <div className="empty">Pick an object to see every role and user that can reach it, and how.</div> : <AccessPanel m={m} o={s.obj} />}</div>
    </Split>
  );
}

function AccessPanel({ m, o }: { m: RBAC; o: number }) {
  const { roles, users } = useMemo(() => m.access(o), [m, o]);
  const name = m.objName(o), type = m.objType(o);
  // containers the object needs USAGE on (database, schema)
  const parts = name.split(".");
  const containers: [string, string][] = [];
  if (["TABLE", "VIEW", "MATERIALIZED VIEW", "EXTERNAL TABLE", "DYNAMIC TABLE", "STAGE", "FUNCTION", "PROCEDURE", "STREAM", "TASK", "PIPE", "CORTEX SEARCH SERVICE", "SEMANTIC VIEW"].includes(type) && parts.length >= 3)
    containers.push(["DATABASE", parts[0]], ["SCHEMA", parts[0] + "." + parts[1]]);
  else if (type === "SCHEMA" && parts.length >= 2) containers.push(["DATABASE", parts[0]]);
  const cIdx = containers.map(([t, n]) => m.raw.objs.findIndex((x) => m.raw.otypes[x[0]] === t && x[1] === n));
  const usable = (r: number) => cIdx.every((ci) => ci >= 0 && m.grantsByObj[ci].some((g) => m.reach(r).has(m.gRole(g))));
  const userRows = [...users.entries()].sort((a, b) => rankOf(b[1].best) - rankOf(a[1].best));
  const roleRows = [...roles.entries()].filter(([r]) => !["db", "app"].includes(m.kind[r]) || m.grantsByObj[o].some((g) => m.gRole(g) === r))
    .sort((a, b) => rankOf(b[1].best) - rankOf(a[1].best));
  const holders = [...new Set(m.grantsByObj[o].map((g) => m.gRole(g)))];
  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}><span className="pill plain">{type.toLowerCase()}</span><b className="mono" style={{ fontSize: 14 }}>{name}</b></div>
      <Section title="Summary">
      <div className="grid g4" style={{ marginBottom: 10 }}>
        <Metric l="Users" v={users.size} />
        <Metric l="Roles" v={roles.size} s={`${holders.length} direct · ${roles.size - holders.length} inherited`} />
        <Metric l="Grants on it" v={m.grantsByObj[o].length} />
      </div>
      <div className="callout">
        Based on privileges granted on this object. ACCOUNTADMIN and roles with MANAGE GRANTS can always grant themselves access, and future grants aren't shown.
        {containers.length > 0 && " A role also needs USAGE on the database and schema, so roles without it are marked."}
      </div>
      </Section>
      <Section title={`Users (${userRows.length})`}>
      {!userRows.length && <div className="empty">No user can reach this object.</div>}
      {userRows.map(([u, v]) => {
        const p = m.userPath(u, v.via);
        return (
          <div key={u} className="between" style={{ marginBottom: 7, borderBottom: "1px solid var(--border)", paddingBottom: 6 }}>
            {p ? <Path m={m} roles={p} user={u} /> : <span />}
            <span className="row">{[...v.privs].sort((a, b) => rankOf(b) - rankOf(a)).slice(0, 4).map((pv) =>
              <span key={pv} className={"pill " + (pv === "OWNERSHIP" ? "bad" : rankOf(pv) >= 3 ? "warn" : "info")}>{pv}</span>)}</span>
          </div>
        );
      })}
      </Section>
      <Section title={`Roles (${roleRows.length})`}>
      <div className="scroll"><table className="t"><thead><tr><th>Role</th><th>Privileges</th><th>Through</th><th className="hide-sm">Users</th></tr></thead><tbody>
        {roleRows.map(([r, v]) => (
          <tr key={r}>
            <td><RoleChip m={m} r={r} />{containers.length > 0 && !usable(r) && <span className="pill warn" title="Missing USAGE on the database or schema">no USAGE</span>}</td>
            <td>{[...v.privs].sort((a, b) => rankOf(b) - rankOf(a)).join(", ")}</td>
            <td>{v.via === r ? <span className="muted">direct</span> : <RoleChip m={m} r={v.via} />}</td>
            <td className="hide-sm">{m.roleUsers[r].length}</td>
          </tr>
        ))}
      </tbody></table></div>
      </Section>
    </div>
  );
}
