import React, { useMemo, useState } from "react";
import { job, resetJob, send, setStore, store, useStore } from "../kit";
import { RBAC, rankOf } from "../graph";
import { KIND_META } from "../theme";
import { ErrorBox, Metric, Path, Picker, RoleChip, UserChip, ago, fmt } from "../ui";

type Any = any;

export function RoleTab({ m }: { m: RBAC }) {
  const s = useStore();
  const sel = s.sel && m.byId.has(s.sel) ? m.byId.get(s.sel)! : null;
  const items = useMemo(() => m.ids.map((id, i) => ({ label: id, value: i, hint: (KIND_META[m.kind[i]] || KIND_META.empty).label }))
    .sort((a, b) => a.label.localeCompare(b.label)), [m]);
  return (
    <div className="split" style={{ gridTemplateColumns: "300px minmax(0,1fr)" }}>
      <div className="card"><h3>Roles</h3><Picker items={items} value={sel} onPick={(r) => setStore({ sel: m.ids[r] })} placeholder="Find a role" max={400} /></div>
      <div className="card">{sel === null ? <div className="empty">Pick a role to see its full profile.</div> : <RolePanel m={m} r={sel} />}</div>
    </div>
  );
}

export function RolePanel({ m, r, compact = false }: { m: RBAC; r: number; compact?: boolean }) {
  const [tab, setTab] = useState("access");
  const [scope, setScope] = useState<"all" | "direct">("all");
  const [q, setQ] = useState("");
  const k = KIND_META[m.kind[r]] || KIND_META.empty;
  const id = m.ids[r];
  const node = m.raw.nodes[r];
  const users = m.usersOf(r);
  const direct = m.roleUsers[r];
  const reach = m.reach(r), up = m.up(r);
  const eff = useMemo(() => m.effective(r), [m, r]);
  const shown = scope === "direct" ? eff.filter((x) => x.via === r) : eff;
  const byType = useMemo(() => {
    const t: Record<string, number> = {};
    for (const { g } of shown) { const ty = m.objType(m.gObj(g)); t[ty] = (t[ty] || 0) + 1; }
    return Object.entries(t).sort((a, b) => b[1] - a[1]);
  }, [shown]);
  const paths = useMemo(() => m.pathsUp(r, 6), [m, r]);
  const isAccountRole = !["db", "app"].includes(m.kind[r]);
  const owned = eff.filter((x) => x.via === r && m.gPriv(x.g) === "OWNERSHIP").length;
  const rows = useMemo(() => {
    const t = q.trim().toUpperCase();
    return shown.filter(({ g }) => !t || m.objName(m.gObj(g)).toUpperCase().includes(t) || m.gPriv(g).includes(t))
      .sort((a, b) => rankOf(m.gPriv(b.g)) - rankOf(m.gPriv(a.g)));
  }, [shown, q]);

  return (
    <div>
      <div className="between" style={{ marginBottom: 6 }}>
        <div className="row">
          <span className="chip" style={{ background: k.fill, borderColor: k.stroke, color: k.ink, fontSize: 14, cursor: "default" }}>{id}</span>
          <span className="pill plain">{k.label}</span>
        </div>
        <div className="row">
          {compact && <button className="btn sm" onClick={() => setStore({ tab: "role" })}>Open full profile</button>}
          <button className="btn sm" onClick={() => setStore({ focus: true, tab: "graph" })}>Focus in graph</button>
        </div>
      </div>
      <div className="kv" style={{ marginBottom: 10 }}>
        {node[2] && <><span className="k">Owner</span><span><b>{node[2]}</b></span></>}
        {node[4] && <><span className="k">Created</span><span>{node[4].slice(0, 10)} · {ago(node[4])}</span></>}
        {node[3] && <><span className="k">Comment</span><span>{node[3]}</span></>}
      </div>
      <div className="grid g4" style={{ gridTemplateColumns: compact ? "1fr 1fr" : undefined, marginBottom: 10 }}>
        <Metric l="Users" v={users.length} s={`${direct.length} direct`} />
        <Metric l="Privileges" v={fmt(eff.length)} s={`${fmt(m.grantsByRole[r].length)} direct · ${owned} owned`} />
        <Metric l="Inherits" v={reach.size - 1} s="roles below it" />
        <Metric l="Inherited by" v={up.size - 1} s="roles above it" />
      </div>
      {isAccountRole && <LiveCheck m={m} role={id} />}
      <div className="tabsm">
        {[["access", "What it can access"], ["users", `Users (${users.length})`], ["tree", "Hierarchy"], ["ddl", "SQL"]].map(([v, l]) =>
          <button key={v} className={tab === v ? "on" : ""} onClick={() => setTab(v)}>{l}</button>)}
      </div>

      {tab === "access" && (
        <div>
          <div className="row" style={{ marginBottom: 8 }}>
            <div className="tabsm" style={{ margin: 0 }}>
              <button className={scope === "all" ? "on" : ""} onClick={() => setScope("all")}>Direct + inherited</button>
              <button className={scope === "direct" ? "on" : ""} onClick={() => setScope("direct")}>Direct only</button>
            </div>
          </div>
          {byType.length === 0 && <div className="empty">No privileges.</div>}
          {byType.slice(0, compact ? 8 : 20).map(([t, n]) => (
            <div key={t} style={{ marginBottom: 6 }}>
              <div className="between" style={{ fontSize: 12.5 }}><span>{t.toLowerCase()}</span><b>{fmt(n)}</b></div>
              <div className="bar"><i style={{ width: `${(100 * n) / byType[0][1]}%` }} /></div>
            </div>
          ))}
          {!compact && (
            <>
              <input className="txt" style={{ width: "100%", margin: "10px 0 6px" }} placeholder="Filter by object or privilege" value={q} onChange={(e) => setQ(e.target.value)} />
              <div className="scroll"><table className="t"><thead><tr><th>Privilege</th><th>Object</th><th>Type</th><th>Via</th></tr></thead><tbody>
                {rows.slice(0, 500).map(({ g, via }, i) => (
                  <tr key={i}>
                    <td><span className={"pill " + (m.gPriv(g) === "OWNERSHIP" ? "bad" : rankOf(m.gPriv(g)) >= 3 ? "warn" : "info")}>{m.gPriv(g)}</span>{m.gOpt(g) && <span className="pill plain" title="WITH GRANT OPTION"> +grant</span>}</td>
                    <td className="mono" style={{ wordBreak: "break-all", cursor: "pointer" }} onClick={() => setStore({ obj: m.gObj(g), tab: "access" })}>{m.objName(m.gObj(g))}</td>
                    <td className="muted">{m.objType(m.gObj(g)).toLowerCase()}</td>
                    <td>{via === r ? <span className="muted">direct</span> : <RoleChip m={m} r={via} />}</td>
                  </tr>
                ))}
              </tbody></table></div>
              {rows.length > 500 && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Showing 500 of {fmt(rows.length)}. Filter to narrow.</div>}
            </>
          )}
        </div>
      )}

      {tab === "users" && (
        <div>
          {users.length === 0 && <div className="empty">No user can use this role.</div>}
          {users.map((u) => {
            const p = m.userPath(u, r);
            return (
              <div key={u} style={{ marginBottom: 8 }}>
                {p && p.length > 1 ? <Path m={m} roles={p} user={u} /> : <span className="path"><UserChip m={m} u={u} /><span className="pill info">direct</span></span>}
              </div>
            );
          })}
        </div>
      )}

      {tab === "tree" && (
        <div>
          <h3>Inherits from <span className="muted">(granted to this role)</span></h3>
          <div className="row" style={{ marginBottom: 10 }}>{m.inherits[r].length ? m.inherits[r].map((c) => <RoleChip key={c} m={m} r={c} />) : <span className="muted">nothing</span>}</div>
          <h3>Granted to <span className="muted">(these roles inherit it)</span></h3>
          <div className="row" style={{ marginBottom: 10 }}>{m.heldBy[r].length ? m.heldBy[r].map((c) => <RoleChip key={c} m={m} r={c} />) : <span className="muted">no parent role</span>}</div>
          <h3>Paths to the top</h3>
          {paths.map((p, i) => <div key={i} style={{ marginBottom: 6 }}><Path m={m} roles={p} /></div>)}
          {isAccountRole && !paths.some((p) => ["SYSADMIN", "ACCOUNTADMIN", "SECURITYADMIN"].includes(m.ids[p[0]])) && m.kind[r] !== "sys" &&
            <div className="callout warn">This role does not roll up to SYSADMIN or ACCOUNTADMIN, so system administrators can't manage what it owns.</div>}
        </div>
      )}

      {tab === "ddl" && (
        <div>
          <p className="muted" style={{ marginTop: 0 }}>Copy-ready statements for this role.</p>
          <pre className="ddl">{[
            `SHOW GRANTS OF ROLE ${id};   -- who holds it`,
            `SHOW GRANTS TO ROLE ${id};   -- what it can do`,
            isAccountRole && !m.up(r).has(m.byId.get("SYSADMIN") ?? -1) && m.kind[r] !== "sys" ? `GRANT ROLE ${id} TO ROLE SYSADMIN;   -- roll up to SYSADMIN` : null,
            ...direct.slice(0, 5).map((u) => `REVOKE ROLE ${id} FROM USER ${m.raw.users[u].name};`),
            ...m.heldBy[r].slice(0, 5).map((p) => `REVOKE ROLE ${id} FROM ROLE ${m.ids[p]};`),
          ].filter(Boolean).join("\n")}</pre>
        </div>
      )}
    </div>
  );
}

/** Compare the ACCOUNT_USAGE snapshot to live SHOW GRANTS OF ROLE. */
function LiveCheck({ m, role }: { m: RBAC; role: string }) {
  const s = useStore();
  const key = "live:" + role;
  const started = !!s.jobs[key];
  const j = started ? job<Any>(key, () => send("live_role", { role })) : null;
  const r = m.byId.get(role)!;
  if (!started) return (
    <div className="callout between" style={{ marginBottom: 10 }}>
      <span>Grants above are from ACCOUNT_USAGE (up to 2h behind).</span>
      <button className="btn sm" onClick={() => { store.jobs[key] = send("live_role", { role }); setStore({}); }}>Check live</button>
    </div>
  );
  if (!j || j.loading) return <div className="callout" style={{ marginBottom: 10 }}>Checking live grants…</div>;
  if (j.error) return <ErrorBox msg={j.error} />;
  const live = j.result;
  const snapUsers = new Set(m.roleUsers[r].map((u) => m.raw.users[u].name));
  const snapRoles = new Set(m.heldBy[r].map((p) => m.ids[p]));
  const liveUsers = live.grantees.filter((g: Any) => g.type === "USER");
  const liveRoles = live.grantees.filter((g: Any) => g.type === "ROLE");
  const added = [...liveUsers.filter((g: Any) => !snapUsers.has(g.name)), ...liveRoles.filter((g: Any) => !snapRoles.has(g.name))];
  const liveNames = new Set(live.grantees.map((g: Any) => g.name));
  const gone = [...snapUsers, ...snapRoles].filter((n) => !liveNames.has(n));
  return (
    <div className={"callout " + (added.length || gone.length ? "warn" : "ok")} style={{ marginBottom: 10 }}>
      <div className="between">
        <b>Live: {liveUsers.length} users, {liveRoles.length} parent roles</b>
        <button className="btn sm" onClick={() => resetJob(key)}>Recheck</button>
      </div>
      {!added.length && !gone.length && <div>Matches the snapshot.</div>}
      {added.map((g: Any) => <div key={g.name}>New since snapshot: <b>{g.type.toLowerCase()} {g.name}</b> · granted by {g.granted_by} · {ago(g.created)}</div>)}
      {gone.map((n) => <div key={n}>Removed since snapshot: <b>{n}</b></div>)}
    </div>
  );
}
