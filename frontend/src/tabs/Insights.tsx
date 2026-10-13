import React, { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { BarChart, PieChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import { setStore, useStore } from "../kit";
import { RBAC, blastRadius, hygiene } from "../graph";
import { KIND_META } from "../theme";
import { Metric, Picker, RoleChip, UserChip, fmt } from "../ui";

echarts.use([BarChart, PieChart, GridComponent, TooltipComponent, SVGRenderer]);

export function EChart({ option, height = 220 }: { option: any; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const ch = useRef<echarts.ECharts | null>(null);
  useEffect(() => {
    if (!el.current) return;
    ch.current = echarts.init(el.current, undefined, { renderer: "svg" });
    const ro = new ResizeObserver(() => ch.current?.resize());
    ro.observe(el.current);
    return () => { ro.disconnect(); ch.current?.dispose(); };
  }, []);
  useEffect(() => { ch.current?.setOption(option, true); }, [option]);
  return <div ref={el} style={{ height }} />;
}

const SEV = { high: ["#dc2626", "bad", "High"], med: ["#F59E0B", "warn", "Medium"], low: ["#29B5E8", "info", "Info"] } as const;

export function HygieneTab({ m }: { m: RBAC }) {
  const f = useMemo(() => hygiene(m), [m]);
  const [open, setOpen] = useState<string | null>(f.find((x) => x.items.length && x.sev === "high")?.id || null);
  const counts: Record<string, number> = {};
  m.kind.forEach((k) => (counts[k] = (counts[k] || 0) + 1));
  const kindOpt = useMemo(() => ({
    tooltip: { trigger: "item" },
    series: [{ type: "pie", radius: ["52%", "80%"], label: { show: false }, itemStyle: { borderColor: "#fff", borderWidth: 2 },
      data: Object.entries(counts).map(([k, n]) => ({ name: (KIND_META[k] || KIND_META.empty).label, value: n, itemStyle: { color: (KIND_META[k] || KIND_META.empty).stroke } })) }],
  }), [m]);
  const live = f.filter((x) => x.items.length);
  const barOpt = useMemo(() => ({
    grid: { left: 210, right: 30, top: 6, bottom: 20 }, tooltip: { trigger: "axis" },
    xAxis: { type: "value", splitLine: { lineStyle: { color: "rgba(11,118,168,.08)" } } },
    yAxis: { type: "category", inverse: true, data: live.map((x) => x.title), axisLabel: { color: "#0f172a", width: 200, overflow: "truncate" } },
    series: [{ type: "bar", barWidth: 14, data: live.map((x) => ({ value: x.items.length, itemStyle: { color: SEV[x.sev][0], borderRadius: [0, 4, 4, 0] } })) }],
  }), [f]);
  const high = f.filter((x) => x.sev === "high" && x.items.length).length;
  const mfaGap = f.find((x) => x.id === "mfa")?.items.length || 0;
  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="grid g4">
        <Metric l="High-severity findings" v={high} color={high ? "#dc2626" : "#059669"} s="needs attention" />
        <Metric l="ACCOUNTADMIN users" v={f.find((x) => x.id === "aa")?.items.length ?? 0} s="target: 2–3, all with MFA" />
        <Metric l="Grants to PUBLIC" v={fmt(f.find((x) => x.id === "public")?.items.length ?? 0)} s="everyone gets these" />
        <Metric l="Password users without MFA" v={mfaGap} color={mfaGap ? "#dc2626" : undefined} />
      </div>
      <div className="grid g2">
        <div className="card"><h3>Findings by size</h3><EChart option={barOpt} height={Math.max(160, live.length * 26 + 30)} /></div>
        <div className="card"><h3>Role mix <span className="muted">· {m.n} roles</span></h3><EChart option={kindOpt} height={200} />
          <div className="legend" style={{ justifyContent: "center" }}>{Object.entries(counts).map(([k, n]) => <span key={k}><i style={{ background: (KIND_META[k] || KIND_META.empty).fill, borderColor: (KIND_META[k] || KIND_META.empty).stroke }} />{(KIND_META[k] || KIND_META.empty).label} {n}</span>)}</div></div>
      </div>
      {f.map((x) => (
        <div key={x.id} className="finding">
          <div className="hd" onClick={() => setOpen(open === x.id ? null : x.id)}>
            <span className="sev" style={{ background: x.items.length ? SEV[x.sev][0] : "#cbd5e1" }} />
            <span className="n" style={{ color: x.items.length ? SEV[x.sev][0] : "#94a3b8" }}>{fmt(x.items.length)}</span>
            <div style={{ flex: 1 }}>
              <b>{x.title}</b> {x.items.length > 0 && <span className={"pill " + SEV[x.sev][1]}>{SEV[x.sev][2]}</span>}
              <div className="muted" style={{ fontSize: 12.5 }}>{x.why}</div>
            </div>
            <span className="muted">{open === x.id ? "▾" : "▸"}</span>
          </div>
          {open === x.id && (
            <div className="bd">
              {!x.items.length && <div className="muted">Nothing found. 👍</div>}
              <div className="scroll" style={{ maxHeight: 300 }}>
                {x.items.slice(0, 300).map((it, i) => (
                  <div key={i} className="between" style={{ padding: "4px 0", borderBottom: "1px solid var(--border)" }}>
                    <span className="row">
                      {it.user !== undefined && <UserChip m={m} u={it.user} />}
                      {it.role !== undefined && (x.id === "public" ? <span className="mono">{it.label}</span> : <RoleChip m={m} r={it.role} />)}
                      {it.role === undefined && it.user === undefined && <span>{it.label}</span>}
                    </span>
                    {it.detail && <span className="muted" style={{ fontSize: 12 }}>{it.detail}</span>}
                  </div>
                ))}
              </div>
              {x.id === "svcmix" && x.items.length > 0 && (
                <button className="btn sm primary" style={{ marginTop: 8 }} onClick={() => setStore({ tab: "alerts", alertDraft: x.items[0].role !== undefined ? m.ids[x.items[0].role] : null })}>Protect these roles with an alert…</button>)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ what-if
export function WhatIfTab({ m }: { m: RBAC }) {
  const s = useStore();
  const rm = s.removed;
  const [kind, setKind] = useState<"edge" | "ugrant" | "grant">("edge");
  const [role, setRole] = useState<number | null>(null);
  const toggle = (k: keyof typeof rm, i: number) => {
    const cur = rm[k];
    setStore({ removed: { ...rm, [k]: cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i] } });
  };
  const n = rm.edges.length + rm.ugrants.length + rm.grants.length;
  const res = useMemo(() => (n ? blastRadius(m.raw, rm) : null), [m, rm]);
  const roleItems = useMemo(() => m.ids.map((id, i) => ({ label: id, value: i })).sort((a, b) => a.label.localeCompare(b.label)), [m]);
  const candidates = role === null ? [] : kind === "edge"
    ? [...m.heldEdge[role].map((e) => ({ i: e, label: `${m.ids[role]} → granted to ${m.ids[m.raw.edges[e][1]]}` })),
       ...m.inhEdge[role].map((e) => ({ i: e, label: `${m.ids[m.raw.edges[e][0]]} → granted to ${m.ids[role]}` }))]
    : kind === "ugrant" ? m.roleUserGrant[role].map((g) => ({ i: g, label: `${m.ids[role]} → user ${m.raw.users[m.raw.ugrants[g][0]].name}` }))
    : m.grantsByRole[role].slice(0, 300).map((g) => ({ i: g, label: `${m.gPriv(g)} on ${m.objName(m.gObj(g))}` }));
  const field = kind === "edge" ? "edges" : kind === "ugrant" ? "ugrants" : "grants";
  return (
    <div className="split" style={{ gridTemplateColumns: "380px minmax(0,1fr)" }}>
      <div className="card">
        <h3>Simulate a revoke</h3>
        <p className="muted" style={{ marginTop: 0 }}>Nothing is changed in Snowflake. Pick grants to remove and see who loses what.</p>
        <div className="tabsm">
          {([["edge", "Role → role"], ["ugrant", "Role → user"], ["grant", "Privilege"]] as const).map(([k, l]) =>
            <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>{l}</button>)}
        </div>
        <Picker items={roleItems} value={role} onPick={setRole} placeholder="Role" max={300} />
        {role !== null && (
          <div className="listpick" style={{ marginTop: 8, maxHeight: 220 }}>
            {candidates.length === 0 && <div className="muted">Nothing to revoke here.</div>}
            {candidates.map((c) => (
              <div key={c.i} className={(rm as any)[field].includes(c.i) ? "on" : ""} onClick={() => toggle(field as any, c.i)}>
                <span>{(rm as any)[field].includes(c.i) ? "☑ " : "☐ "}{c.label}</span>
              </div>
            ))}
          </div>
        )}
        {n > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className="between"><b>{n} revoke{n > 1 ? "s" : ""} staged</b><button className="btn sm" onClick={() => setStore({ removed: { edges: [], ugrants: [], grants: [] } })}>Clear</button></div>
            <pre className="ddl">{[
              ...rm.edges.map((e) => { const [c, p] = m.raw.edges[e]; return `REVOKE ${m.kind[c] === "db" ? "DATABASE ROLE" : "ROLE"} ${m.ids[c]} FROM ${m.kind[p] === "db" ? "DATABASE ROLE" : "ROLE"} ${m.ids[p]};`; }),
              ...rm.ugrants.map((g) => `REVOKE ROLE ${m.ids[m.raw.ugrants[g][1]]} FROM USER ${m.raw.users[m.raw.ugrants[g][0]].name};`),
              ...rm.grants.map((g) => `REVOKE ${m.gPriv(g)} ON ${m.objType(m.gObj(g))} ${m.objName(m.gObj(g))} FROM ROLE ${m.ids[m.gRole(g)]};`),
            ].join("\n")}</pre>
          </div>
        )}
      </div>
      <div className="card">
        {!res ? <div className="empty">Stage one or more revokes to see the blast radius.</div> : (
          <div>
            <div className="grid g4" style={{ marginBottom: 12 }}>
              <Metric l="Users affected" v={res.users.length} color={res.users.length ? "#dc2626" : "#059669"} />
              <Metric l="Roles affected" v={res.roles.length} />
              <Metric l="Privileges lost" v={fmt(res.users.reduce((a, x) => a + x.lost.length, 0))} s="summed over users" />
            </div>
            {!res.users.length && <div className="callout ok">No user loses anything: every privilege is still reachable another way.</div>}
            {res.users.map((x) => (
              <details key={x.u} className="finding" style={{ marginBottom: 8 }}>
                <summary className="hd" style={{ listStyle: "none" }}>
                  <span className="sev" style={{ background: "#dc2626" }} />
                  <UserChip m={m} u={x.u} />
                  <span className="muted">loses {fmt(x.lost.length)} privileges{x.lostRoles.length ? ` and ${x.lostRoles.length} roles` : ""}</span>
                </summary>
                <div className="bd">
                  {x.lostRoles.length > 0 && <div className="row" style={{ marginBottom: 8 }}><span className="muted">Roles:</span>{x.lostRoles.map((r) => <RoleChip key={r} m={m} r={r} />)}</div>}
                  <div className="scroll" style={{ maxHeight: 240 }}><table className="t"><tbody>
                    {x.lost.slice(0, 300).map((k) => { const { obj, priv } = res.key(k); return (
                      <tr key={k}><td><span className="pill warn">{priv}</span></td><td className="mono">{m.objName(obj)}</td><td className="muted">{m.objType(obj).toLowerCase()}</td></tr>); })}
                  </tbody></table></div>
                </div>
              </details>
            ))}
            {res.roles.length > 0 && <>
              <h3 style={{ marginTop: 12 }}>Roles that lose inheritance or privileges</h3>
              <div className="row">{res.roles.slice(0, 80).map((x) => <span key={x.r} title={`${x.lostRoles.length} roles, ${x.lostGrants} privileges`}><RoleChip m={m} r={x.r} /></span>)}</div>
            </>}
          </div>
        )}
      </div>
    </div>
  );
}
