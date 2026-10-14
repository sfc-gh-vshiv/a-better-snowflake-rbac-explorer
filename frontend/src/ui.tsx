import React, { useMemo, useRef, useState } from "react";
import { job, send, setStore, store, useStore } from "./kit";
import { RBAC, RawModel } from "./graph";
import { KIND_META } from "./theme";

type Any = any;
const W = window as Any;

/** The RBAC model (async). Built once per refresh and kept on window across reruns. */
export function useModel(): { m: RBAC | null; loading: boolean; error: string | null; elapsed?: number } {
  const s = useStore();
  const j = job<RawModel>("model:" + s.nonce, () => send("model", { nonce: s.nonce }));
  if (j.result) {
    if (!W.__reModel || W.__reModel.raw !== j.result) W.__reModel = new RBAC(j.result);
    return { m: W.__reModel, loading: false, error: null };
  }
  // keep showing the previous model while a refresh runs
  if (j.loading && W.__reModel) return { m: W.__reModel, loading: true, error: null, elapsed: j.elapsed };
  return { m: null, loading: j.loading, error: j.error, elapsed: j.elapsed };
}

export function RoleChip({ m, r, onClick }: { m: RBAC; r: number; onClick?: () => void }) {
  const k = KIND_META[m.kind[r]] || KIND_META.empty;
  return (
    <span className="chip" title={`${m.ids[r]} · ${k.label}`} style={{ background: k.fill, borderColor: k.stroke, color: k.ink }}
      onClick={(e) => { e.stopPropagation(); (onClick || (() => setStore({ sel: m.ids[r], tab: store.tab === "graph" ? "graph" : "role" })))(); }}>
      {m.ids[r]}
    </span>
  );
}
export function UserChip({ m, u }: { m: RBAC; u: number }) {
  const x = m.raw.users[u];
  const svc = (x.type || "").includes("SERVICE");
  return (
    <span className="chip" title={`${x.name} · ${x.type || "PERSON"}`} onClick={(e) => { e.stopPropagation(); setStore({ user: x.name, tab: "user" }); }}
      style={{ background: svc ? "#eef2ff" : "#fff", borderColor: svc ? "#7159FF" : "rgba(11,118,168,.3)", color: svc ? "#3f2fb8" : "#0f172a", opacity: x.disabled ? 0.55 : 1 }}>
      <span aria-hidden>{svc ? "⚙" : "●"}</span>{x.name}
    </span>
  );
}
export function Path({ m, roles, user }: { m: RBAC; roles: number[]; user?: number }) {
  return (
    <span className="path">
      {user !== undefined && <><UserChip m={m} u={user} /><span className="arr">uses</span></>}
      {roles.map((r, i) => (
        <React.Fragment key={i}>{i > 0 && <span className="arr">→</span>}<RoleChip m={m} r={r} /></React.Fragment>
      ))}
    </span>
  );
}
export function Metric({ l, v, s, color }: { l: string; v: React.ReactNode; s?: React.ReactNode; color?: string }) {
  return <div className="metric"><div className="l">{l}</div><div className="v" style={color ? { color } : undefined}>{v}</div>{s && <div className="s">{s}</div>}</div>;
}
export function Skeleton({ h = 18, w = "100%" }: { h?: number; w?: number | string }) {
  return <div className="skel" style={{ height: h, width: w }} />;
}
export function Loading({ elapsed, label = "Reading roles and grants from ACCOUNT_USAGE" }: { elapsed?: number; label?: string }) {
  return (
    <div className="card" style={{ padding: 22 }}>
      <div className="row" style={{ marginBottom: 12 }}><b>{label}</b><span className="muted">{elapsed ? `${elapsed}s` : ""} · usually under a minute</span></div>
      <div className="grid g4" style={{ marginBottom: 12 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={70} />)}</div>
      <Skeleton h={420} />
    </div>
  );
}
export function ErrorBox({ msg }: { msg: string }) { return <div className="err"><b>Something went wrong.</b> {msg}</div>; }

export const fmt = (n: number) => n.toLocaleString("en-US");
export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (d < 90) return "just now";
  if (d < 5400) return `${Math.round(d / 60)} min ago`;
  if (d < 129600) return `${Math.round(d / 3600)} h ago`;
  if (d < 86400 * 60) return `${Math.round(d / 86400)} days ago`;
  if (d < 86400 * 700) return `${Math.round(d / 86400 / 30)} months ago`;
  return `${Math.round(d / 86400 / 365)} years ago`;
}

/** Type-ahead picker over a list of {label, value, hint}. */
export function Picker<T>({ items, value, onPick, placeholder, max = 200 }:
  { items: { label: string; value: T; hint?: string }[]; value?: T | null; onPick: (v: T) => void; placeholder: string; max?: number }) {
  const [q, setQ] = useState("");
  const hits = useMemo(() => {
    const t = q.trim().toUpperCase();
    const f = t ? items.filter((x) => x.label.toUpperCase().includes(t)) : items;
    return f.slice(0, max);
  }, [q, items]);
  return (
    <div>
      <input className="txt" style={{ width: "100%", marginBottom: 6 }} placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="listpick">
        {hits.map((x, i) => (
          <div key={i} className={x.value === value ? "on" : ""} onClick={() => onPick(x.value)}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.label}</span>
            {x.hint && <span className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{x.hint}</span>}
          </div>
        ))}
        {!hits.length && <div className="muted">No matches</div>}
      </div>
      {items.length > max && !q && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Showing {max} of {fmt(items.length)}. Type to search.</div>}
    </div>
  );
}

export function Legend() {
  return (
    <div className="legend">
      {Object.entries(KIND_META).map(([k, v]) => <span key={k}><i style={{ background: v.fill, borderColor: v.stroke }} />{v.label}</span>)}
    </div>
  );
}

/** Two-panel layout with a draggable gutter. `side` is the fixed-width panel; its width is remembered per `id`.
 *  Double-click the gutter to reset. With `solo`, only the first child shows full width. */
export function Split({ id, init, side = "left", min = 220, max = 900, solo, children }:
  { id: string; init: number; side?: "left" | "right"; min?: number; max?: number; solo?: boolean; children: React.ReactNode }) {
  const key = "rx.split." + id;
  const read = () => { try { const v = Number(localStorage.getItem(key)); return v >= min && v <= max ? v : init; } catch { return init; } };
  const [w, setW] = useState<number>(read);
  const cur = useRef(w); cur.current = w;
  const [drag, setDrag] = useState(false);
  const kids = React.Children.toArray(children);
  if (solo) return <div className="split solo">{kids}</div>;
  const save = (v: number) => { try { localStorage.setItem(key, String(v)); } catch { /* storage may be blocked */ } };
  const down = (e: React.MouseEvent) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = cur.current;
    const mv = (ev: MouseEvent) => {
      const dx = ev.clientX - x0;
      setW(Math.max(min, Math.min(max, side === "left" ? w0 + dx : w0 - dx)));
    };
    const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); setDrag(false); save(cur.current); };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up); setDrag(true);
  };
  const reset = () => { setW(init); save(init); };
  const cols = side === "left" ? `${w}px 14px minmax(0,1fr)` : `minmax(0,1fr) 14px ${w}px`;
  return (
    <div className={"split rs" + (drag ? " dragging" : "")} style={{ gridTemplateColumns: cols }}>
      {kids[0]}
      <div className="gutter" role="separator" aria-orientation="vertical" title="Drag to resize. Double-click to reset."
        onMouseDown={down} onDoubleClick={reset} />
      {kids[1]}
    </div>
  );
}
