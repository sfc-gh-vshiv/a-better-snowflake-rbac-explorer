import React, { useEffect, useMemo, useRef, useState } from "react";
import ELK from "elkjs/lib/elk.bundled.js";
import { setStore, useStore, job, send } from "../kit";
import { RBAC } from "../graph";
import { KIND_META } from "../theme";
import { Legend, RoleChip, fmt } from "../ui";
import { RolePanel } from "./Role";

type Any = any;
const W = window as Any;
const elk = new ELK();
const NW = 188, NH = 46, UW = 150, UH = 26;

type Lay = { nodes: { id: string; x: number; y: number; w: number; h: number; r?: number; u?: number; gi?: number }[];
  edges: { id: string; s: string; t: string; pts: [number, number][] }[]; w: number; h: number };
const LAYOUTS: Record<string, Lay> = W.__reLayouts || (W.__reLayouts = {});
const VIEWS: Record<string, { x: number; y: number; k: number }> = W.__reViews || (W.__reViews = {});

export function useProtected(): Set<string> {
  const j = job<Any>("alert_rules", () => send("alert_rules", {}));
  return useMemo(() => new Set<string>((j.result?.rules || []).filter((r: Any) => r.enabled).map((r: Any) => r.role)), [j.result]);
}

/** Visible subgraph: account roles (plus db/app roles when asked), or a focus neighbourhood. */
const COLLAPSE_AT = 5;
function subgraph(m: RBAC, sel: number | null, focus: boolean, hops: number, showDb: boolean, showUsers: boolean, expanded: Record<string, boolean>) {
  const ok = (r: number) => showDb || !(m.kind[r] === "db" || m.kind[r] === "app");
  let vis = new Set<number>();
  if (focus && sel !== null) {
    const walk = (start: number, next: (x: number) => number[]) => {
      let frontier = [start];
      for (let h = 0; h < hops && frontier.length; h++) {
        const nf: number[] = [];
        for (const x of frontier) for (const y of next(x)) if (ok(y) && !vis.has(y)) { vis.add(y); nf.push(y); }
        frontier = nf;
      }
    };
    vis.add(sel);
    walk(sel, (x) => m.heldBy[x]);
    walk(sel, (x) => m.inherits[x]);
  } else {
    for (let r = 0; r < m.n; r++) if (ok(r)) vis.add(r);
  }
  // Collapse leaf roles (no visible children, one visible parent) under busy parents
  // into a "+N roles" bundle, unless the parent was expanded or the role is selected.
  const groups: { p: number; members: number[] }[] = [];
  if (!(focus && sel !== null)) {
    const leaves = new Map<number, number[]>();
    for (const c of vis) {
      if (c === sel || m.inherits[c].some((x) => vis.has(x))) continue;
      const ps = m.heldBy[c].filter((x) => vis.has(x));
      if (ps.length === 1) leaves.set(ps[0], [...(leaves.get(ps[0]) || []), c]);
    }
    for (const [p, kids] of leaves) if (kids.length > COLLAPSE_AT && !expanded[m.ids[p]]) {
      kids.sort((a, b) => m.usersOf(b).length - m.usersOf(a).length || m.ids[a].localeCompare(m.ids[b]));
      groups.push({ p, members: kids });
      kids.forEach((k) => vis.delete(k));
    }
  }
  const edges: [number, number][] = [];
  for (const p of vis) for (const c of m.inherits[p]) if (vis.has(c)) edges.push([p, c]);
  const linked = new Set<number>();
  edges.forEach(([p, c]) => { linked.add(p); linked.add(c); });
  groups.forEach((g) => linked.add(g.p));
  const users: number[] = [];
  if (showUsers || focus) {
    const us = new Set<number>();
    for (const r of vis) for (const u of m.roleUsers[r]) us.add(u);
    for (const g of groups) for (const r of g.members) for (const u of m.roleUsers[r]) us.add(u);
    users.push(...us);
    for (const u of users) for (const r of m.userRoles[u]) if (vis.has(r)) linked.add(r);
  }
  if (sel !== null && vis.has(sel)) linked.add(sel);
  const isolated = [...vis].filter((r) => !linked.has(r)).sort((a, b) => m.ids[a].localeCompare(m.ids[b]));
  const groupOf = new Map<number, number>();
  groups.forEach((g, i) => g.members.forEach((r) => groupOf.set(r, i)));
  return { nodes: [...vis].filter((r) => linked.has(r)), edges, users, isolated, groups, groupOf };
}

// cache key for a node set: two subgraphs of equal size must not share a layout
function nodeSig(ns: number[]) { let h = 0; for (const r of ns) h = (h * 31 + r + 1) | 0; return `${ns.length}:${h}`; }

async function layout(m: RBAC, g: ReturnType<typeof subgraph>): Promise<Lay> {
  const children = [
    ...g.nodes.map((r) => ({ id: "r" + r, width: NW, height: NH })),
    ...g.users.map((u) => ({ id: "u" + u, width: UW, height: UH })),
    ...g.groups.map((gr, i) => ({ id: "g" + i, width: NW, height: NH + 12 })),
  ];
  const edges = [
    ...g.edges.map(([p, c]) => ({ id: `e${p}_${c}`, sources: ["r" + p], targets: ["r" + c] })),
    ...g.groups.map((gr, i) => ({ id: `eg${i}`, sources: ["r" + gr.p], targets: ["g" + i] })),
    ...g.users.flatMap((u) => {
      const t = new Set<string>();
      for (const r of m.userRoles[u]) {
        if (g.nodes.includes(r)) t.add("r" + r);
        else if (g.groupOf.has(r)) t.add("g" + g.groupOf.get(r));
      }
      return [...t].map((id) => ({ id: `x${u}_${id}`, sources: ["u" + u], targets: [id] }));
    }),
  ];
  const res: Any = await elk.layout({
    id: "root", children, edges,
    layoutOptions: {
      "elk.algorithm": "layered", "elk.direction": "DOWN", "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "54", "elk.spacing.nodeNode": "22",
      "elk.layered.spacing.edgeNodeBetweenLayers": "18", "elk.spacing.componentComponent": "50",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF", "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.separateConnectedComponents": "true", "elk.aspectRatio": "1.3", "elk.padding": "[top=70,left=30,bottom=30,right=30]",
    },
  });
  return {
    w: res.width, h: res.height,
    nodes: res.children.map((c: Any) => ({ id: c.id, x: c.x, y: c.y, w: c.width, h: c.height,
      r: c.id[0] === "r" ? +c.id.slice(1) : undefined, u: c.id[0] === "u" ? +c.id.slice(1) : undefined,
      gi: c.id[0] === "g" ? +c.id.slice(1) : undefined })),
    edges: res.edges.map((e: Any) => {
      const s = e.sections?.[0];
      const pts: [number, number][] = s ? [[s.startPoint.x, s.startPoint.y], ...(s.bendPoints || []).map((b: Any) => [b.x, b.y]), [s.endPoint.x, s.endPoint.y]] : [];
      return { id: e.id, s: e.sources[0], t: e.targets[0], pts };
    }),
  };
}

/** Orthogonal polyline with rounded corners. */
function roundPath(pts: [number, number][], r = 8): string {
  if (pts.length < 2) return "";
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const a = Math.min(r, Math.hypot(x1 - x0, y1 - y0) / 2), b = Math.min(r, Math.hypot(x2 - x1, y2 - y1) / 2);
    const ux = Math.sign(x1 - x0), uy = Math.sign(y1 - y0), vx = Math.sign(x2 - x1), vy = Math.sign(y2 - y1);
    d += ` L${x1 - ux * a},${y1 - uy * a} Q${x1},${y1} ${x1 + vx * b},${y1 + vy * b}`;
  }
  const l = pts[pts.length - 1];
  return d + ` L${l[0]},${l[1]}`;
}

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function Hierarchy({ m }: { m: RBAC }) {
  const s = useStore();
  const prot = useProtected();
  const sel = s.sel !== null && m.byId.has(s.sel) ? m.byId.get(s.sel)! : null;
  const expanded: Record<string, boolean> = s.expanded || {};
  const expKey = Object.keys(expanded).filter((k) => expanded[k]).sort().join(",");
  // the selected role is never hidden inside a bundle
  const selGrouped = !s.focus && sel !== null;
  const g = useMemo(() => subgraph(m, sel, s.focus, s.hops, s.showDb, s.showUsers, expanded),
    [m, s.focus || selGrouped ? sel : -1, s.focus, s.hops, s.showDb, s.showUsers, expKey]);
  const key = `${m.raw.asof}|${s.focus ? sel : "all"}|${s.hops}|${s.showDb}|${s.showUsers || s.focus}|${expKey}|${nodeSig(g.nodes)}`;
  const [lay, setLay] = useState<Lay | null>(LAYOUTS[key] || null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (LAYOUTS[key]) { setLay(LAYOUTS[key]); return; }
    let live = true;
    setErr(null);
    layout(m, g).then((l) => { LAYOUTS[key] = l; if (live) setLay(l); }).catch((e) => live && setErr(String(e)));
    return () => { live = false; };
  }, [key]);

  // highlight set: hovered or selected role, its ancestors and descendants
  const [hover, setHover] = useState<number | null>(null);
  const focusR = hover ?? sel;
  const hi = useMemo(() => {
    if (focusR === null) return null;
    return { up: m.up(focusR), down: m.reach(focusR) };
  }, [focusR, m]);
  const q = s.search.trim().toUpperCase();
  const matches = useMemo(() => (q ? new Set(g.nodes.filter((r) => m.ids[r].toUpperCase().includes(q))) : null), [q, g]);

  // pan / zoom
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState(VIEWS[key] || null);
  const [size, setSize] = useState({ w: 1000, h: 680 });
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(() => box.current && setSize({ w: box.current.clientWidth, h: box.current.clientHeight }));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const fit = (l = lay) => {
    if (!l) return;
    const k = Math.min(size.w / l.w, size.h / l.h, 1.15);
    const v = { k, x: (size.w - l.w * k) / 2, y: Math.max(0, (size.h - l.h * k) / 2) };
    VIEWS[key] = v; setView(v);
  };
  // Open at a readable zoom anchored on the top of the tree; Fit shows everything.
  const home = (l: Lay) => {
    const k0 = Math.min(size.w / l.w, size.h / l.h, 1.15);
    if (k0 >= 0.6) return fit(l);
    const top = l.nodes.find((n) => n.r !== undefined && m.ids[n.r] === "ACCOUNTADMIN") || l.nodes.find((n) => n.r !== undefined);
    const k = 0.8;
    const v = { k, x: top ? size.w / 2 - (top.x + top.w / 2) * k : 0, y: top ? 70 - top.y * k : 0 };
    VIEWS[key] = v; setView(v);
  };
  useEffect(() => { if (lay) { if (VIEWS[key]) setView(VIEWS[key]); else home(lay); } }, [lay, size.w, size.h]);
  const setV = (v: { x: number; y: number; k: number }) => { VIEWS[key] = v; setView(v); };
  const zoomAt = (f: number, cx = size.w / 2, cy = size.h / 2) => {
    if (!view) return;
    const k = Math.max(0.08, Math.min(3, view.k * f));
    setV({ k, x: cx - (cx - view.x) * (k / view.k), y: cy - (cy - view.y) * (k / view.k) });
  };
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFull(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);
  useEffect(() => {
    const el = box.current?.querySelector("svg");
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rc = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rc.left, e.clientY - rc.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });
  // centre on the selected role when it changes
  const lastSel = useRef<string | null>(null);
  useEffect(() => {
    if (!lay || !view || s.sel === lastSel.current || s.focus) return;
    if (sel === null) { lastSel.current = s.sel; return; }
    // The role may only join the graph after a re-layout (isolated roles) or sit inside a bundle,
    // so only mark it handled once we've actually found something to centre on.
    const gi = g.groupOf.get(sel);
    const n = lay.nodes.find((x) => x.r === sel) || (gi !== undefined ? lay.nodes.find((x) => x.gi === gi) : undefined);
    if (!n) return;
    lastSel.current = s.sel;
    const k = Math.max(view.k, 0.85);
    setV({ k, x: size.w / 2 - (n.x + n.w / 2) * k, y: size.h / 2 - (n.y + n.h / 2) * k });
    box.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [s.sel, lay]);

  const pick = (r: number | null) => setStore({ sel: r === null ? null : m.ids[r] });
  const searchHit = () => {
    if (!q) return;
    const hit = m.ids.map((id, i) => [id, i] as const).find(([id]) => id.toUpperCase().includes(q));
    if (hit) setStore({ sel: hit[0] });
  };

  const dimmed = (r: number) => (hi ? !(hi.up.has(r) || hi.down.has(r)) : matches ? !matches.has(r) : false);
  const edgeState = (sId: string, tId: string) => {
    if (!hi || sId[0] !== "r") return hi ? "dim" : "";
    const p = +sId.slice(1);
    if (tId[0] === "g") { const gr = g.groups[+tId.slice(1)]; return gr && gr.members.some((r) => hi.down.has(r)) && hi.down.has(p) ? "down" : gr && hi.up.has(p) && gr.members.some((r) => hi.up.has(r)) ? "up" : "dim"; }
    const c = +tId.slice(1);
    if (hi.up.has(p) && hi.up.has(c)) return "up";
    if (hi.down.has(p) && hi.down.has(c)) return "down";
    return "dim";
  };

  return (
    <div className={"split" + (s.panelOpen === false ? " solo" : "")}>
      <div>
        <div className={"graphbox" + (full ? " full" : "")} ref={box}>
          <svg className={dragging ? "drag" : ""}
            onMouseDown={(e) => { if (!view) return; drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; setDragging(true); }}
            onMouseMove={(e) => {
              const d = drag.current;
              if (!d || !view) return;
              if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
              setV({ k: view.k, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y });
            }}
            onMouseUp={() => { setDragging(false); setTimeout(() => (drag.current = null), 0); }}
            onMouseLeave={() => { drag.current = null; setDragging(false); setHover(null); }}
            onClick={() => { if (!drag.current?.moved) pick(null); }}>
            <defs>
              <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" style={{ fill: "#94a3b8" }} /></marker>
              <marker id="arU" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" style={{ fill: "#0b76a8" }} /></marker>
              <marker id="arD" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" style={{ fill: "#F59E0B" }} /></marker>
            </defs>
            {lay && view && (
              <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
                {lay.edges.map((e) => {
                  const st = edgeState(e.s, e.t);
                  const isUser = e.s[0] === "u";
                  const col = st === "up" ? "#0b76a8" : st === "down" ? "#F59E0B" : isUser ? "#c4b5fd" : "#cbd5e1";
                  return <path key={e.id} d={roundPath(e.pts)} fill="none"
                    style={{ stroke: col, strokeWidth: st === "up" || st === "down" ? 2.2 : 1.3, opacity: st === "dim" ? 0.18 : 1,
                      strokeDasharray: isUser ? "4 3" : undefined }}
                    markerEnd={`url(#${st === "up" ? "arU" : st === "down" ? "arD" : "ar"})`} />;
                })}
                {lay.nodes.map((n) => {
                  if (n.gi !== undefined) {
                    const gr = g.groups[n.gi];
                    if (!gr) return null;
                    const lit = hi ? gr.members.some((r) => hi.up.has(r) || hi.down.has(r)) || hi.down.has(gr.p) : matches ? gr.members.some((r) => matches.has(r)) : true;
                    const hit = matches ? gr.members.filter((r) => matches.has(r)).length : 0;
                    return (
                      <g key={n.id} transform={`translate(${n.x},${n.y})`} style={{ cursor: "pointer", opacity: lit ? 1 : 0.22 }}
                        onClick={(e) => { e.stopPropagation(); setStore({ expanded: { ...expanded, [m.ids[gr.p]]: true } }); }}>
                        <title>{`${gr.members.length} roles granted only to ${m.ids[gr.p]}:\n` + gr.members.slice(0, 25).map((r) => m.ids[r]).join("\n") + (gr.members.length > 25 ? "\n…" : "") + "\n\nClick to expand"}</title>
                        <rect x={6} y={6} width={n.w} height={n.h} rx={10} style={{ fill: "#f1f5f9", stroke: "#cbd5e1" }} />
                        <rect x={3} y={3} width={n.w} height={n.h} rx={10} style={{ fill: "#f8fafc", stroke: "#cbd5e1" }} />
                        <rect width={n.w} height={n.h} rx={10} style={{ fill: "#fff", stroke: "#94a3b8", strokeDasharray: "4 3", strokeWidth: 1.3 }} />
                        <text x={14} y={20} style={{ fontSize: 13, fontWeight: 700, fill: "#0b76a8" }}>{`+${gr.members.length} roles`}{hit ? ` · ${hit} match` : ""}</text>
                        <text x={14} y={37} style={{ fontSize: 11, fill: "#64748b" }}>{trunc(gr.members.slice(0, 2).map((r) => m.ids[r]).join(", "), 30)}</text>
                        <text x={14} y={51} style={{ fontSize: 10.5, fill: "#29B5E8", fontWeight: 600 }}>click to expand</text>
                      </g>
                    );
                  }
                  if (n.u !== undefined) {
                    const u = m.raw.users[n.u];
                    const svc = (u.type || "").includes("SERVICE");
                    return (
                      <g key={n.id} transform={`translate(${n.x},${n.y})`} style={{ cursor: "pointer", opacity: hi && !m.userRoles[n.u].some((r) => hi.up.has(r) || hi.down.has(r)) ? 0.25 : 1 }}
                        onClick={(e) => { e.stopPropagation(); setStore({ user: u.name, tab: "user" }); }}>
                        <title>{`${u.name} (${u.type || "PERSON"})`}</title>
                        <rect width={n.w} height={n.h} rx={13} style={{ fill: svc ? "#eef2ff" : "#fff", stroke: svc ? "#7159FF" : "#94a3b8", strokeWidth: 1.2 }} />
                        <text x={n.w / 2} y={17} textAnchor="middle" style={{ fontSize: 11.5, fill: svc ? "#3f2fb8" : "#0f172a", fontWeight: 600 }}>
                          {(svc ? "⚙ " : "") + trunc(u.name, 19)}</text>
                      </g>
                    );
                  }
                  const r = n.r!;
                  const k = KIND_META[m.kind[r]] || KIND_META.empty;
                  const isSel = r === sel, isProt = prot.has(m.ids[r]);
                  const nu = m.roleUsers[r].length, ng = m.grantsByRole[r].length;
                  return (
                    <g key={n.id} transform={`translate(${n.x},${n.y})`} style={{ cursor: "pointer", opacity: dimmed(r) ? 0.22 : 1, transition: "opacity .15s" }}
                      onMouseEnter={() => setHover(r)} onMouseLeave={() => setHover(null)}
                      onClick={(e) => { e.stopPropagation(); if (!drag.current?.moved) pick(r); }}
                      onDoubleClick={(e) => { e.stopPropagation(); setStore({ sel: m.ids[r], focus: true }); }}>
                      <title>{`${m.ids[r]}\n${k.label} role · ${nu} direct users · ${ng} privileges${m.raw.nodes[r][3] ? "\n" + m.raw.nodes[r][3] : ""}`}</title>
                      {isSel && <rect x={-4} y={-4} width={n.w + 8} height={n.h + 8} rx={12} style={{ fill: "none", stroke: "#29B5E8", strokeWidth: 3, opacity: 0.55 }} />}
                      <rect width={n.w} height={n.h} rx={9} style={{ fill: k.fill, stroke: isProt ? "#dc2626" : k.stroke, strokeWidth: isSel ? 2.4 : 1.4 }} />
                      <text x={14} y={19} style={{ fontSize: 12.5, fontWeight: 700, fill: k.ink }}>{trunc(m.ids[r], isProt ? 20 : 23)}</text>
                      <text x={14} y={35} style={{ fontSize: 11, fill: "#64748b" }}>
                        {`${nu} user${nu === 1 ? "" : "s"} · ${fmt(ng)} priv${ng === 1 ? "" : "s"}`}</text>
                      {isProt && (
                        <g transform={`translate(${n.w - 22},7)`}><title>Protected by an alert rule</title>
                          <path d="M8 0 L16 3 V9 C16 14 12 17 8 19 C4 17 0 14 0 9 V3 Z" style={{ fill: "#dc2626" }} />
                          <path d="M4.5 9.5 L7 12 L11.5 6.5" style={{ fill: "none", stroke: "#fff", strokeWidth: 1.8 }} /></g>
                      )}
                    </g>
                  );
                })}
              </g>
            )}
          </svg>
          <div className="gtools">
            <input className="txt" style={{ width: 230 }} placeholder="Search roles…  (Enter to select)" value={s.search}
              onChange={(e) => setStore({ search: e.target.value })} onKeyDown={(e) => e.key === "Enter" && searchHit()} />
            <label className="toggle"><input type="checkbox" checked={s.focus} disabled={sel === null}
              onChange={(e) => setStore({ focus: e.target.checked })} />Focus on selection</label>
            {s.focus && <select className="txt" value={s.hops} onChange={(e) => setStore({ hops: +e.target.value })}>
              {[1, 2, 3, 5, 10].map((h) => <option key={h} value={h}>{h} hop{h > 1 ? "s" : ""}</option>)}</select>}
            <label className="toggle"><input type="checkbox" checked={s.showUsers || s.focus} disabled={s.focus}
              onChange={(e) => setStore({ showUsers: e.target.checked })} />Users</label>
            <label className="toggle"><input type="checkbox" checked={s.showDb} onChange={(e) => setStore({ showDb: e.target.checked })} />Database &amp; app roles</label>
            <span className="grow" />
            {!full && <button className="btn sm" title={s.panelOpen === false ? "Show the details panel" : "Hide the details panel"}
              onClick={() => setStore({ panelOpen: s.panelOpen === false })}>{s.panelOpen === false ? "Show panel ‹" : "Hide panel ›"}</button>}
            {expKey && <button className="btn sm" onClick={() => setStore({ expanded: {} })}>Collapse bundles</button>}
            <span className="pill plain" style={{ background: "#fff" }}>{fmt(g.nodes.length + g.groups.reduce((a, x) => a + x.members.length, 0))} roles · {fmt(g.edges.length)} links{g.groups.length ? ` · ${g.groups.length} bundles` : ""}</span>
          </div>
          <div className="zoom">
            <button title="Zoom in" onClick={() => zoomAt(1.25)}>+</button>
            <button title="Zoom out" onClick={() => zoomAt(0.8)}>−</button>
            <button title="Fit" onClick={() => fit()} style={{ fontSize: 12 }}>⤢</button>
            <button title={full ? "Exit full screen (Esc)" : "Full screen"} onClick={() => setFull(!full)} style={{ fontSize: 13 }}>{full ? "✕" : "⛶"}</button>
          </div>
          {lay && view && <MiniMap lay={lay} view={view} size={size} m={m} onJump={(x, y) => setV({ ...view, x: size.w / 2 - x * view.k, y: size.h / 2 - y * view.k })} />}
          {!lay && !err && <div className="empty" style={{ position: "absolute", inset: "50% 0 auto" }}>Laying out {fmt(g.nodes.length)} roles…</div>}
          {err && <div className="err" style={{ position: "absolute", top: 60, left: 12, right: 12 }}>{err}</div>}
        </div>
        <div className="between" style={{ marginTop: 8 }}>
          <Legend />
          <span className="muted" style={{ fontSize: 12 }}>Arrows point from a role to the roles it inherits. Hover to trace · click to inspect · double-click to focus · scroll to zoom</span>
        </div>
        {g.isolated.length > 0 && (
          <div className="card" style={{ marginTop: 10 }}>
            <h3>{g.isolated.length} roles not linked to any other role <span className="muted">· no parent and no child role{s.showUsers || s.focus ? ", no users" : ""}</span></h3>
            <div className="row">{g.isolated.map((r) => <RoleChip key={r} m={m} r={r} onClick={() => setStore({ sel: m.ids[r] })} />)}</div>
          </div>
        )}
      </div>
      {s.panelOpen !== false && <div className="card panel">
        {sel === null ? <Overview m={m} /> : <RolePanel m={m} r={sel} compact />}
      </div>}
    </div>
  );
}

function MiniMap({ lay, view, size, m, onJump }: { lay: Lay; view: { x: number; y: number; k: number }; size: { w: number; h: number }; m: RBAC; onJump: (x: number, y: number) => void }) {
  const s = Math.min(180 / lay.w, 120 / lay.h);
  return (
    <svg className="mini hide-sm" viewBox={`0 0 180 120`} onClick={(e) => {
      e.stopPropagation();
      const rc = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
      onJump((e.clientX - rc.left) / s, (e.clientY - rc.top) / s);
    }} style={{ cursor: "pointer" }}>
      {lay.nodes.map((n) => <rect key={n.id} x={n.x * s} y={n.y * s} width={Math.max(1, n.w * s)} height={Math.max(1, n.h * s)}
        style={{ fill: n.r !== undefined ? (KIND_META[m.kind[n.r]] || KIND_META.empty).stroke : "#c4b5fd" }} />)}
      <rect x={-view.x / view.k * s} y={-view.y / view.k * s} width={size.w / view.k * s} height={size.h / view.k * s}
        style={{ fill: "rgba(41,181,232,.12)", stroke: "#0b76a8", strokeWidth: 1 }} />
    </svg>
  );
}

function Overview({ m }: { m: RBAC }) {
  const counts: Record<string, number> = {};
  m.kind.forEach((k) => (counts[k] = (counts[k] || 0) + 1));
  const top = m.ids.map((_, i) => i).filter((r) => !["db", "app"].includes(m.kind[r]))
    .map((r) => [r, m.usersOf(r).length] as const).sort((a, b) => b[1] - a[1]).slice(0, 8);
  return (
    <div>
      <h3>Account at a glance</h3>
      <p className="muted" style={{ marginTop: 0 }}>Select a role in the graph to see who holds it, what it inherits and what it can touch.</p>
      <table className="t"><tbody>
        {Object.entries(KIND_META).filter(([k]) => counts[k]).map(([k, v]) => (
          <tr key={k}><td><span className="pill" style={{ background: v.fill, color: v.ink, border: `1px solid ${v.stroke}` }}>{v.label}</span></td>
            <td style={{ textAlign: "right", fontWeight: 600 }}>{counts[k]}</td></tr>))}
      </tbody></table>
      <h3 style={{ marginTop: 14 }}>Most widely held roles</h3>
      {top.map(([r, n]) => (
        <div key={r} className="between" style={{ marginBottom: 6 }}>
          <RoleChip m={m} r={r} onClick={() => setStore({ sel: m.ids[r] })} />
          <span className="muted" style={{ fontSize: 12 }}>{n} users</span>
        </div>
      ))}
      <div className="callout" style={{ marginTop: 12 }}>Tip: press <span className="kbd">/</span> to search, then <span className="kbd">Enter</span>.</div>
    </div>
  );
}
