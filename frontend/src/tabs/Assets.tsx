// Assets: what an AI asset needs (data -> semantic view -> tool -> agent -> skill), who can use it
// right now, and the least-privilege fix. Discovery, SQL generation and apply all run server-side
// (modules/access.py); this file only shows them and computes gaps (bundle.ts).
import React, { useMemo, useState } from "react";
import { job, resetJob, send, setStore, store, useStore } from "../kit";
import { RBAC } from "../graph";
import { Bundle, Item, Live, Principal, Row, TreeNode, fromLive, fromModel, fromRole, gap, required, team } from "../bundle";
import { ErrorBox, Metric, Picker, Skeleton, ago, fmt } from "../ui";

type Any = any;
const KINDS: [string, string][] = [["agent", "Agents"], ["semantic_view", "Semantic views"], ["search_service", "Search services"],
  ["procedure", "Custom tool"], ["skill", "Skill"]];
const KIND_NAME: Record<string, string> = { agent: "agent", semantic_view: "semantic view", search_service: "search service",
  procedure: "procedure", function: "function", skill: "Cortex Code skill" };
const SRC: Record<string, string> = { spec: "agent spec", ddl: "definition", skill_md: "SKILL.md", access_history: "author's history", manual: "manual" };
const STATUS_PILL: Record<string, string> = { ready: "ok", partial: "warn", blocked: "bad" };
type Sel = { kind: string; fqn?: string; text?: string; learn?: { user: string; days: number; cli: boolean }; id?: string };

/** Start a request once per key; null key = idle. Payload is read when the key changes. */
function useRun<T = Any>(action: string) {
  useStore();   // re-render when the response (or a poll result) arrives
  const [k, setK] = useState<{ key: string; pl: Any } | null>(null);
  const j = k ? job<T>(k.key, () => send(action, k.pl)) : null;
  return { j, run: (pl: Any) => setK({ key: `${action}:${Date.now()}`, pl }), clear: () => setK(null) };
}

export function AssetsTab({ m }: { m: RBAC }) {
  const s = useStore();
  const view = s.assetView || "assets";
  return (
    <div>
      <div className="tabsm">
        {[["assets", "Assets"], ["requests", "Access requests"], ["applied", "Applied changes"], ["settings", "Settings"]].map(([v, l]) =>
          <button key={v} className={view === v ? "on" : ""} onClick={() => setStore({ assetView: v })}>{l}</button>)}
      </div>
      {view === "assets" && <AssetsView m={m} />}
      {view === "requests" && <RequestsView m={m} />}
      {view === "applied" && <AppliedView />}
      {view === "settings" && <SettingsView />}
    </div>
  );
}

// ------------------------------------------------------------------ pick an asset
function AssetsView({ m }: { m: RBAC }) {
  const s = useStore();
  const lst = job<Any>("access_assets:" + (s.assetNonce || 0), () => send("access_assets"));
  const [kind, setKind] = useState("agent");
  const sel: Sel | null = s.assetSel || null;
  const items = useMemo(() => (lst.result?.assets || []).filter((a: Any) => a.kind === kind)
    .map((a: Any) => ({ label: a.fqn, value: a.fqn, hint: a.owner || "" })), [lst.result, kind]);
  return (
    <div className="split" style={{ gridTemplateColumns: "360px minmax(0,1fr)" }}>
      <div className="card">
        <h3>What does this asset need?</h3>
        <div className="tabsm">{KINDS.map(([k, l]) => <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>{l}</button>)}</div>
        {lst.error && <ErrorBox msg={lst.error} />}
        {["agent", "semantic_view", "search_service"].includes(kind) && (lst.loading ? <Skeleton h={200} /> :
          <Picker items={items} value={sel?.fqn} onPick={(f) => setStore({ assetSel: { kind, fqn: f } })}
            placeholder={`Search ${KIND_NAME[kind]}s the app can see…`} />)}
        {kind === "procedure" && <ToolPick />}
        {kind === "skill" && <SkillPick m={m} />}
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Lists objects RBAC_EXPLORER_ROLE can see. To analyse an agent or semantic view it can't describe, grant it MONITOR on that object.
        </div>
        <h3 style={{ marginTop: 14 }}>Saved bundles</h3>
        {!(lst.result?.bundles || []).length && <div className="muted">None yet. Discover an asset and save it.</div>}
        <div className="listpick">
          {(lst.result?.bundles || []).map((b: Any) => (
            <div key={b.id} className={sel?.id === b.id ? "on" : ""} onClick={() => setStore({ assetSel: { kind: b.kind, fqn: b.fqn, id: b.id } })}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.fqn}</span>
              <span className="muted" style={{ fontSize: 12 }}>{KIND_NAME[b.kind]} · {b.n}</span>
            </div>))}
        </div>
      </div>
      <div className="card">{sel ? <Discovered m={m} sel={sel} /> :
        <div className="empty">Pick an agent, semantic view, tool or skill. Role Explorer walks it down to the data, lists every grant it needs, and shows who can use it today.</div>}</div>
    </div>
  );
}

function ToolPick() {
  const [fqn, setFqn] = useState("");
  const [t, setT] = useState("procedure");
  return (
    <div className="grid" style={{ gap: 8 }}>
      <input className="txt" placeholder="DB.SCHEMA.NAME or DB.SCHEMA.NAME(NUMBER)" value={fqn} onChange={(e) => setFqn(e.target.value)} />
      <div className="row">
        <select className="txt" value={t} onChange={(e) => setT(e.target.value)}><option value="procedure">Procedure</option><option value="function">Function</option></select>
        <button className="btn primary" disabled={!fqn.trim()} onClick={() => setStore({ assetSel: { kind: t, fqn: fqn.trim() } })}>Discover</button>
      </div>
    </div>
  );
}

function SkillPick({ m }: { m: RBAC }) {
  const [text, setText] = useState("");
  const [user, setUser] = useState("");
  const [days, setDays] = useState(14);
  const [cli, setCli] = useState(false);
  const users = useMemo(() => m.raw.users.filter((u) => !u.disabled).map((u) => u.name).sort(), [m]);
  return (
    <div className="grid" style={{ gap: 8 }}>
      <textarea className="txt" rows={8} placeholder="Paste the skill's SKILL.md" value={text} onChange={(e) => setText(e.target.value)} />
      <label className="muted" style={{ fontSize: 12.5 }}>Also learn from what the author touched (ACCESS_HISTORY, Enterprise edition)</label>
      <select className="txt" value={user} onChange={(e) => setUser(e.target.value)}>
        <option value="">Don't learn from history</option>{users.map((u) => <option key={u}>{u}</option>)}
      </select>
      {user && <div className="row">
        <label className="row" style={{ fontSize: 12.5 }}>last <input className="txt" type="number" min={1} max={90} style={{ width: 60 }} value={days}
          onChange={(e) => setDays(Math.max(1, Math.min(90, +e.target.value || 14)))} /> days</label>
        <label className="toggle"><input type="checkbox" checked={cli} onChange={(e) => setCli(e.target.checked)} />Cortex Code CLI only</label>
      </div>}
      <button className="btn primary" disabled={!text.trim()} onClick={() =>
        setStore({ assetSel: { kind: "skill", text, learn: user ? { user, days, cli } : undefined } })}>Discover</button>
    </div>
  );
}

// ------------------------------------------------------------------ a discovered (or saved) bundle
function Discovered({ m, sel }: { m: RBAC; sel: Sel }) {
  const s = useStore();
  const key = sel.id ? `access_bundle:${sel.id}:${s.bundleNonce || 0}` : `access_discover:${JSON.stringify(sel)}:${s.bundleNonce || 0}`;
  const j = job<Bundle>(key, () => sel.id ? send("access_bundle", { id: sel.id }) : send("access_discover", sel));
  if (j.error) return <ErrorBox msg={j.error} />;
  if (!j.result) return <div><div className="row" style={{ marginBottom: 8 }}><b>Walking the asset down to its data</b>
    <span className="muted">{j.elapsed ? j.elapsed + "s" : ""} · DESCRIBE and SHOW GRANTS on each object</span></div><Skeleton h={300} /></div>;
  (window as Any).__reBundle = j.result;   // context for the Ask panel
  return <BundleView m={m} b={{ ...j.result, id: sel.id || j.result.id }} sel={sel} key={key} />;
}

function BundleView({ m, b, sel }: { m: RBAC; b: Bundle; sel: Sel }) {
  const [off, setOff] = useState<Set<string>>(() => new Set(b.items.filter((i) => i.on === false).map((i) => i.key)));
  const [on, setOn] = useState<Set<string>>(() => new Set(b.items.filter((i) => i.suggested && i.on).map((i) => i.key)));
  const bx: Bundle = useMemo(() => ({ ...b, items: b.items.map((i) => ({ ...i,
    on: i.root ? true : off.has(i.key) ? false : i.suggested ? on.has(i.key) : true })) }), [b, off, on]);
  const save = useRun<Any>("access_save");
  const saved = save.j?.result;
  const id = saved?.id || b.id;
  const dirty = !b.id || b.items.some((i) => (i.on === false) !== off.has(i.key) || (!!i.suggested && !!i.on) !== on.has(i.key));
  const toggle = (i: Item) => {
    if (i.root) return;
    if (i.suggested) { const n = new Set(on); n.has(i.key) ? n.delete(i.key) : n.add(i.key); setOn(n); }
    else { const n = new Set(off); n.has(i.key) ? n.delete(i.key) : n.add(i.key); setOff(n); }
  };
  const warnings = useMemo(() => walk(b.tree).flatMap((n) => n.warnings.map((w) => `${n.fqn}: ${w}`)), [b]);
  const req = bx.items.filter(required);
  return (
    <div>
      <div className="between" style={{ marginBottom: 8 }}>
        <div className="row"><span className="pill plain">{KIND_NAME[b.kind]}</span><b className="mono" style={{ fontSize: 14 }}>{b.fqn}</b></div>
        <div className="row">
          {saved && <span className="pill ok">saved</span>}
          <button className="btn sm" onClick={() => setStore({ bundleNonce: (store.bundleNonce || 0) + 1 })}>Re-check live</button>
          <button className="btn primary sm" disabled={!!save.j?.loading || (!dirty && !!b.id && !saved)} onClick={() => save.run({
            ...(sel.id ? b.source : sel), id, exclude: [...off], include: [...on] })}>{save.j?.loading ? "Saving…" : b.id || saved ? "Save changes" : "Save bundle"}</button>
        </div>
      </div>
      {save.j?.error && <ErrorBox msg={save.j.error} />}
      <div className="grid g4" style={{ marginBottom: 10 }}>
        <Metric l="Grants needed" v={req.length} s={`${b.items.filter((i) => i.suggested).length} suggested from history`} />
        <Metric l="Layers" v={walk(b.tree).length} s={[...new Set(walk(b.tree).map((n) => KIND_NAME[n.kind] || n.kind))].join(", ")} />
        <Metric l="Access role" v={<span className="mono" style={{ fontSize: 14 }}>{saved?.ar || b.ar || "AR_…"}</span>} s="created on first apply" />
        <Metric l="Runs as" v={b.needs_default_wh ? "default role" : "session role"} s={b.needs_default_wh ? "agents ignore the session role" : "whatever role the caller uses"} />
      </div>
      {b.needs_default_wh && <div className="callout" style={{ marginBottom: 10 }}>
        Agents run with the caller's <b>default role and default warehouse</b>, not the role active in their session. A user can open the agent in a
        worksheet as one role and still be blocked when they ask it a question.</div>}
      {warnings.length > 0 && <div className="callout" style={{ marginBottom: 10, borderColor: "rgba(245,158,11,.5)" }}>{warnings.map((w, i) => <div key={i}>{w}</div>)}</div>}
      <h3>How it's built</h3>
      <Tree n={b.tree} depth={0} />
      <h3 style={{ marginTop: 12 }}>Every grant it needs</h3>
      <div className="scroll"><table className="t"><thead><tr><th></th><th>Privilege</th><th>Object</th><th>Why</th><th className="hide-sm">Found in</th><th className="hide-sm">Roles holding it</th></tr></thead><tbody>
        {bx.items.map((i) => (
          <tr key={i.key} style={{ opacity: required(i) ? 1 : 0.5 }}>
            <td><input type="checkbox" disabled={i.root} checked={required(i)} onChange={() => toggle(i)} title={i.root ? "the asset itself" : "include in the bundle"} /></td>
            <td><span className="pill info">{i.priv}</span></td>
            <td><span className="muted" style={{ fontSize: 12 }}>{i.otype.toLowerCase()}</span> <span className="mono">{i.fqn}{i.sig || ""}</span>
              {i.suggested && <span className="pill warn" title="Seen in the author's ACCESS_HISTORY but not in SKILL.md">suggested{i.uses ? ` · used ${i.uses}×` : ""}</span>}</td>
            <td className="muted" style={{ fontSize: 12.5 }}>{i.root ? "the asset itself" : i.note || (i.via !== b.fqn ? `needed by ${i.via}` : i.otype === "DATABASE" || i.otype === "SCHEMA" ? "container" : "")}</td>
            <td className="hide-sm">{i.source.map((x) => <span key={x} className="pill plain">{SRC[x] || x}</span>)}</td>
            <td className="hide-sm">{i.live ? i.live.length : i.error ? <span className="pill bad" title={i.error}>unreadable</span> : "—"}</td>
          </tr>))}
      </tbody></table></div>
      <CanUse m={m} b={bx} />
      {id ? <Fix m={m} b={{ ...bx, id }} saved={!dirty || !!saved} /> :
        <div className="callout" style={{ marginTop: 12 }}>Save the bundle to generate the least-privilege SQL, file access requests, and alert on drift.</div>}
    </div>
  );
}

function walk(n: TreeNode): TreeNode[] { return [n, ...n.children.flatMap(walk)]; }

function Tree({ n, depth }: { n: TreeNode; depth: number }) {
  const rights = n.rights ? (n.rights.includes("CALLER") ? "caller's rights: callers need what it reads" : "owner's rights: callers need only USAGE") : null;
  return (
    <div style={{ marginLeft: depth * 18, borderLeft: depth ? "2px solid var(--border)" : undefined, paddingLeft: depth ? 10 : 0, marginBottom: 4 }}>
      <div className="row"><span className="pill plain">{KIND_NAME[n.kind] || n.kind}</span><span className="mono">{n.fqn}{n.sig || ""}</span>
        {n.tool && <span className="muted" style={{ fontSize: 12 }}>tool “{n.tool}”</span>}
        {rights && <span className={"pill " + (n.rights!.includes("CALLER") ? "warn" : "ok")}>{rights}</span>}
        {n.suggested && <span className="pill warn">from history</span>}
        {n.base_tables && n.kind === "semantic_view" && depth === 0 && <span className="muted" style={{ fontSize: 12 }}>
          {n.base_tables.length} base tables: querying the view needs only SELECT on it; an agent using it also needs the tables</span>}</div>
      {n.children.map((c, i) => <Tree key={i} n={c} depth={depth + 1} />)}
    </div>
  );
}

// ------------------------------------------------------------------ can they use it?
function CanUse({ m, b }: { m: RBAC; b: Bundle }) {
  const s = useStore();
  const [mode, setMode] = useState<"person" | "team">("person");
  const [user, setUser] = useState<string | null>(s.canUser || null);
  const [how, setHow] = useState<string>(b.needs_default_wh ? "default" : "all");
  const [role, setRole] = useState<string>("");
  const users = useMemo(() => m.raw.users.map((u, i) => ({ label: u.name, value: u.name, hint: (u.type || "PERSON").toLowerCase(), i }))
    .filter((x) => !m.raw.users[x.i].disabled).sort((a, z) => a.label.localeCompare(z.label)), [m]);
  const roles = useMemo(() => m.ids.filter((_, i) => !["db", "app"].includes(m.kind[i])).sort(), [m]);
  return (
    <div style={{ marginTop: 14 }}>
      <div className="between"><h3>Can they use it?</h3>
        <div className="tabsm" style={{ margin: 0 }}>{[["person", "A person or AI tool"], ["team", "A whole team (role)"]].map(([v, l]) =>
          <button key={v} className={mode === v ? "on" : ""} onClick={() => setMode(v as Any)}>{l}</button>)}</div></div>
      {mode === "person" && <div>
        <div style={{ maxWidth: 420, marginBottom: 8 }}><Picker items={users} value={user} onPick={(u) => { setUser(u); setStore({ canUser: u }); }} placeholder="Search users…" max={user ? 6 : 40} /></div>
        <div>{user ? <PersonGap m={m} b={b} user={user} how={how} setHow={setHow} /> : <div className="empty">Pick a user to check the asset the way it will run for them.</div>}</div>
      </div>}
      {mode === "team" && <div>
        <select className="txt" value={role} onChange={(e) => setRole(e.target.value)} style={{ marginBottom: 8 }}>
          <option value="">Pick the role a team holds…</option>{roles.map((r) => <option key={r}>{r}</option>)}</select>
        {role && <TeamGap m={m} b={b} role={role} />}
      </div>}
    </div>
  );
}

function PersonGap({ m, b, user, how, setHow }: { m: RBAC; b: Bundle; user: string; how: string; setHow: (h: string) => void }) {
  const s = useStore();
  const lv = job<Live>(`access_principal:${user}:${s.bundleNonce || 0}`, () => send("access_principal", { user }));
  const u = m.raw.users.findIndex((x) => x.name === user);
  const live = lv.result;
  const opts: [string, string][] = [["default", b.needs_default_wh ? "Default role (how agents run)" : "Default role (Cortex Code and most tools)"], ["all", "All roles the user holds"]];
  for (const p of live?.pats || []) if (p.name) opts.push([`pat:${p.name}`, `PAT ${p.name}: ${p.role ? "restricted to " + p.role : "no role restriction"}`]);
  for (const r of live?.roots || []) opts.push([`role:${r}`, `Only role ${r}`]);
  let p: Principal;
  if (live) {
    if (how.startsWith("pat:")) { const pt = live.pats.find((x) => x.name === how.slice(4)); p = pt?.role ? fromLive(live, "role", pt.role) : fromLive(live, "default"); if (pt) p.label = `${user} via PAT ${pt.name}${pt.role ? " (" + pt.role + ")" : ", default role"}`; }
    else if (how.startsWith("role:")) p = fromLive(live, "role", how.slice(5));
    else p = fromLive(live, how as Any);
  } else p = fromModel(m, u, how === "all" ? "all" : "default");
  const g = gap(m, b, p);
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <select className="txt" value={how} onChange={(e) => setHow(e.target.value)}>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        {lv.loading && <span className="muted" style={{ fontSize: 12 }}>reading live grants…</span>}
        {live?.truncated && <span className="pill warn">walk capped at 150 roles</span>}
      </div>
      <GapRows g={g} />
      {live && !live.pats.length && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>No programmatic access tokens. Tools using key-pair or OAuth run with the role they request.</div>}
      {!live && !lv.loading && <div className="muted" style={{ fontSize: 12 }}>From ACCOUNT_USAGE (up to 2 h behind).</div>}
      <div className="row" style={{ marginTop: 8 }}>
        {[...g.principal.roles].length > 0 && g.status !== "ready" && (() => {
          const target = how.startsWith("role:") ? how.slice(5) : how.startsWith("pat:") ? live?.pats.find((x) => x.name === how.slice(4))?.role : live?.default_role || m.raw.users[u]?.default_role;
          return target ? <button className="btn sm" onClick={() => setStore({ fixTarget: target, fixRequest: null })}>Fix it for {target}</button> : null;
        })()}
      </div>
    </div>
  );
}

function GapRows({ g }: { g: ReturnType<typeof gap> }) {
  const ok = g.rows.filter((r) => r.ok);
  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}>
        <span className={"pill " + STATUS_PILL[g.status]} style={{ fontSize: 13 }}>{g.status === "ready" ? "Ready" : g.status === "blocked" ? "Blocked" : "Partly works"}</span>
        <span className="muted">{g.principal.label} · {ok.length} of {g.rows.length} grants in place</span></div>
      {g.principal.why && <div className="callout" style={{ marginBottom: 6 }}>{g.principal.why}</div>}
      {g.status === "partial" && <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
        An agent with a missing tool privilege still answers, without that tool, and reports a warning. That's the “it works for me” bug.</div>}
      {g.missing.map((r: Row) => (
        <div key={r.item.key} className="between" style={{ borderBottom: "1px solid var(--border)", padding: "5px 0" }}>
          <span><span className="pill bad">{r.item.priv}</span> <span className="muted" style={{ fontSize: 12 }}>{r.item.otype.toLowerCase()}</span> <span className="mono">{r.item.fqn}</span></span>
          <span className="muted" style={{ fontSize: 12.5 }}>{r.reason}</span></div>))}
      {ok.length > 0 && <details style={{ marginTop: 6 }}><summary className="muted" style={{ cursor: "pointer" }}>{ok.length} in place</summary>
        {ok.map((r: Row) => <div key={r.item.key} style={{ fontSize: 12.5, padding: "2px 0" }}><span className="pill ok">{r.item.priv}</span> <span className="mono">{r.item.fqn}</span> <span className="muted">through {r.via}</span></div>)}</details>}
    </div>
  );
}

function TeamGap({ m, b, role }: { m: RBAC; b: Bundle; role: string }) {
  const rows = useMemo(() => team(m, b, role), [m, b, role]);
  const c = { ready: 0, partial: 0, blocked: 0 } as Record<string, number>;
  rows.forEach((r) => c[r.status]++);
  const rg = gap(m, b, fromRole(m, role));
  return (
    <div>
      <div className="grid g4" style={{ marginBottom: 8 }}>
        <Metric l="People" v={rows.length} s={`hold ${role}`} />
        <Metric l="Ready" v={c.ready} color="var(--ok)" /><Metric l="Partly work" v={c.partial} color="#b45309" /><Metric l="Blocked" v={c.blocked} color="var(--bad)" />
      </div>
      <div className="callout" style={{ marginBottom: 8 }}>Checked with each person's {b.needs_default_wh ? "default role, as the agent runs" : "roles"}, from ACCOUNT_USAGE.
        The role itself is <b>{rg.status}</b>: {rg.missing.length} grants missing. <button className="btn sm" onClick={() => setStore({ fixTarget: role, fixRequest: null })}>Fix it for {role}</button></div>
      <div className="scroll"><table className="t"><thead><tr><th>User</th><th>Status</th><th>Missing</th></tr></thead><tbody>
        {rows.slice(0, 300).map((r) => <tr key={r.u}><td>{m.raw.users[r.u].name}</td><td><span className={"pill " + STATUS_PILL[r.status]}>{r.status}</span></td>
          <td className="muted" style={{ fontSize: 12.5 }}>{r.missing.slice(0, 3).map((x) => `${x.item.priv} ${x.item.fqn}`).join(", ")}{r.missing.length > 3 ? ` +${r.missing.length - 3}` : ""}</td></tr>)}
      </tbody></table></div>
    </div>
  );
}

// ------------------------------------------------------------------ least-privilege fix, apply, revert, watch
function Fix({ m, b, saved }: { m: RBAC; b: Bundle; saved: boolean }) {
  const s = useStore();
  const target: string = s.fixTarget || "";
  const cortexMissing = useMemo(() => {
    if (!target) return false;
    const r = gap(m, b, fromRole(m, target)).missing;
    return r.some((x) => x.item.otype === "DATABASE ROLE");
  }, [m, b, target]);
  const [cortex, setCortex] = useState<boolean | null>(null);
  const useCortex = cortex ?? cortexMissing;
  const roles = useMemo(() => m.ids.filter((x, i) => !["db", "app", "sys"].includes(m.kind[i]) && !x.startsWith("AR_")).sort(), [m]);
  const fx = job<Any>(`access_fix:${b.id}:${target}:${useCortex}:${s.bundleNonce || 0}`, () => send("access_fix", { id: b.id, target_role: target || null, cortex: useCortex }));
  const [confirm, setConfirm] = useState(false);
  const ap = useRun<Any>(s.fixRequest ? "access_request_decide" : "access_apply");
  const rv = useRun<Any>("access_revert");
  const watch = useRun<Any>("watch_save");
  const done = ap.j?.result;
  return (
    <div style={{ marginTop: 14 }}>
      <div className="between"><h3>Least-privilege fix</h3>
        {s.fixRequest && <span className="pill info">for an access request</span>}</div>
      <div className="row" style={{ marginBottom: 8 }}>
        <label className="row">Grant to role <select className="txt" value={target} onChange={(e) => { setStore({ fixTarget: e.target.value }); setConfirm(false); ap.clear(); }}>
          <option value="">(just build the access role)</option>{roles.map((r) => <option key={r}>{r}</option>)}</select></label>
        <label className="toggle" title="Only needed if PUBLIC no longer has CORTEX_USER or CORTEX_AGENT_USER"><input type="checkbox" checked={useCortex}
          onChange={(e) => setCortex(e.target.checked)} />include Cortex database role</label>
      </div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
        One access role holds exactly the bundle, then it's granted to the functional role your team already uses. Revoking that one grant undoes it.
        Statements are generated on the server from the saved bundle; Apply runs exactly these and nothing else.</div>
      {fx.error && <ErrorBox msg={fx.error} />}
      {!saved && <div className="callout">You have unsaved changes. Save the bundle so the SQL matches what you see.</div>}
      {fx.result && <>
        <pre className="ddl">{fx.result.statements.join(";\n") + ";"}</pre>
        <div className="row" style={{ marginTop: 8 }}>
          {!fx.result.apply_enabled && <span className="muted" style={{ fontSize: 12.5 }}>Apply is off. Run the SQL yourself, or turn Apply on in Settings.</span>}
          {fx.result.apply_enabled && target && !confirm && !done && <button className="btn primary" disabled={!saved} onClick={() => setConfirm(true)}>Apply…</button>}
        </div>
        {confirm && !done && <div className="callout" style={{ marginTop: 8, borderColor: "rgba(220,38,38,.4)" }}>
          <b>Run {fx.result.statements.length} statements as RBAC_EXPLORER_ROLE?</b> Everyone who holds {target} gains this bundle.
          Each statement and its result is logged in Applied changes.
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn danger" disabled={!!ap.j?.loading} onClick={() => ap.run(s.fixRequest
              ? { id: s.fixRequest, decision: "apply", target_role: target, cortex: useCortex, confirm: fx.result.hash }
              : { id: b.id, target_role: target, cortex: useCortex, confirm: fx.result.hash })}>{ap.j?.loading ? "Applying…" : `Apply ${fx.result.statements.length} statements`}</button>
            <button className="btn" onClick={() => setConfirm(false)}>Cancel</button></div></div>}
        {ap.j?.error && <ErrorBox msg={ap.j.error} />}
        {done && <div style={{ marginTop: 8 }}>
          <div className="row"><span className={"pill " + (done.ok ? "ok" : "warn")}>{done.ok ? "Applied" : "Partly applied"}</span>
            <button className="btn sm" onClick={() => setStore({ bundleNonce: (store.bundleNonce || 0) + 1, fixRequest: null })}>Re-check live</button>
            {!rv.j && <button className="btn sm danger" onClick={() => rv.run({ log_id: done.log_id })}>Revert</button>}
            {rv.j?.result && <span className="pill plain">reverted</span>}</div>
          {rv.j?.error && <ErrorBox msg={rv.j.error} />}
          {rv.j?.result?.note && <div className="muted" style={{ fontSize: 12.5 }}>{rv.j.result.note}</div>}
          {(done.results || []).filter((x: Any) => !x.ok).map((x: Any, i: number) => <div key={i} className="err" style={{ marginTop: 4 }}><span className="mono">{x.sql}</span>: {x.error}</div>)}
        </div>}
      </>}
      <h3 style={{ marginTop: 14 }}>Keep it working</h3>
      <div className="row">
        <button className="btn sm" disabled={!!watch.j?.loading} onClick={() => watch.run({ kind: "bundle_drift", spec: { bundle_id: b.id, asset: b.fqn }, enabled: true })}>Alert when the asset gains a dependency</button>
        <button className="btn sm" disabled={!!watch.j?.loading} onClick={() => watch.run({ kind: "bundle_broken", spec: { bundle_id: b.id, asset: b.fqn }, enabled: true })}>Alert when the access role loses a grant</button>
        {watch.j?.result && <span className="pill ok">alert saved</span>}
      </div>
      {watch.j?.error && <ErrorBox msg={watch.j.error} />}
      <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>The watcher checks every minute and emails the address on the alert (edit it in Alerts).</div>
    </div>
  );
}

// ------------------------------------------------------------------ requests, applied changes, settings
function RequestsView({ m }: { m: RBAC }) {
  const s = useStore();
  const [nonce, setNonce] = useState(0);
  const rq = job<Any[]>(`access_requests:${nonce}`, () => send("access_requests"));
  const lst = job<Any>("access_assets:" + (s.assetNonce || 0), () => send("access_assets"));
  const decide = useRun<Any>("access_request_decide");
  const file = useRun<Any>("access_request_file");
  const [f, setF] = useState({ bundle_id: "", target_role: "", justification: "" });
  const roles = useMemo(() => m.ids.filter((_, i) => !["db", "app", "sys"].includes(m.kind[i])).sort(), [m]);
  return (
    <div className="split" style={{ gridTemplateColumns: "340px minmax(0,1fr)" }}>
      <div className="card">
        <h3>Request access</h3>
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>Anyone with the requester role can also file this from SQL or Cortex Code:
          <span className="mono"> CALL RBAC_EXPLORER_DB.ACCESS.FILE_REQUEST(…)</span>.</div>
        <div className="grid" style={{ gap: 8 }}>
          <select className="txt" value={f.bundle_id} onChange={(e) => setF({ ...f, bundle_id: e.target.value })}><option value="">Asset…</option>
            {(lst.result?.bundles || []).map((b: Any) => <option key={b.id} value={b.id}>{b.fqn}</option>)}</select>
          <select className="txt" value={f.target_role} onChange={(e) => setF({ ...f, target_role: e.target.value })}><option value="">Grant it to role…</option>
            {roles.map((r) => <option key={r}>{r}</option>)}</select>
          <textarea className="txt" rows={3} placeholder="Why do you need it?" value={f.justification} onChange={(e) => setF({ ...f, justification: e.target.value })} />
          <button className="btn primary" disabled={!f.bundle_id || !!file.j?.loading} onClick={() => { file.run(f); setTimeout(() => setNonce((n) => n + 1), 1500); }}>File request</button>
          {file.j?.result && <div className="muted">{String(file.j.result)}</div>}
          {file.j?.error && <ErrorBox msg={file.j.error} />}
        </div>
      </div>
      <div className="card">
        <div className="between"><h3>Requests</h3><button className="btn sm" onClick={() => setNonce(nonce + 1)}>Refresh</button></div>
        {rq.error && <ErrorBox msg={rq.error} />}
        {decide.j?.error && <ErrorBox msg={decide.j.error} />}
        {rq.loading && <Skeleton h={160} />}
        {rq.result && !rq.result.length && <div className="empty">No requests yet.</div>}
        {rq.result && rq.result.length > 0 && <div className="scroll"><table className="t"><thead><tr><th>Asset</th><th>Who</th><th>For role</th><th>Why</th><th>Status</th><th></th></tr></thead><tbody>
          {rq.result.map((r: Any) => <tr key={r.id}>
            <td><span className="mono">{r.fqn}</span></td><td>{r.requester}<div className="muted" style={{ fontSize: 12 }}>{ago(r.created_at)}</div></td>
            <td>{r.target_role || <span className="muted">—</span>}</td><td style={{ maxWidth: 260 }}>{r.justification}</td>
            <td><span className={"pill " + (r.status === "PENDING" ? "info" : r.status === "REJECTED" ? "bad" : "ok")}>{r.status.toLowerCase()}</span>
              {r.decided_by && <div className="muted" style={{ fontSize: 12 }}>{r.decided_by}</div>}</td>
            <td>{r.status === "PENDING" && <div className="row">
              <button className="btn sm primary" onClick={() => setStore({ assetView: "assets", assetSel: { kind: r.kind, fqn: r.fqn, id: r.bundle_id }, fixTarget: r.target_role, fixRequest: r.id })}>Review SQL</button>
              <button className="btn sm" onClick={() => { decide.run({ id: r.id, decision: "approve" }); setTimeout(() => setNonce((n) => n + 1), 1500); }} title="Mark approved; you run the SQL yourself">Approve</button>
              <button className="btn sm danger" onClick={() => { decide.run({ id: r.id, decision: "reject" }); setTimeout(() => setNonce((n) => n + 1), 1500); }}>Reject</button></div>}</td>
          </tr>)}</tbody></table></div>}
      </div>
    </div>
  );
}

function AppliedView() {
  const [nonce, setNonce] = useState(0);
  const lg = job<Any[]>(`access_log:${nonce}`, () => send("access_log"));
  const rv = useRun<Any>("access_revert");
  return (
    <div className="card">
      <div className="between"><h3>Applied changes</h3><button className="btn sm" onClick={() => setNonce(nonce + 1)}>Refresh</button></div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>Every Apply, from RBAC_EXPLORER_DB.ACCESS.APPLY_LOG. Revert removes the access role from the target role, but only if that apply granted it.</div>
      {lg.error && <ErrorBox msg={lg.error} />}{rv.j?.error && <ErrorBox msg={rv.j.error} />}
      {lg.result && !lg.result.length && <div className="empty">Nothing applied yet.</div>}
      {lg.result && lg.result.length > 0 && <div className="scroll"><table className="t"><thead><tr><th>When</th><th>Asset</th><th>Access role → role</th><th>Statements</th><th>Status</th><th></th></tr></thead><tbody>
        {lg.result.map((r: Any) => <tr key={r.id}><td>{ago(r.applied_at)}<div className="muted" style={{ fontSize: 12 }}>{r.applied_by}</div></td>
          <td className="mono">{r.fqn}</td><td className="mono">{r.ar_role} → {r.target_role}</td><td>{fmt(r.n)}</td>
          <td><span className={"pill " + (r.status === "APPLIED" ? "ok" : r.status === "REVERTED" ? "plain" : "warn")}>{r.status.toLowerCase()}</span></td>
          <td>{r.status !== "REVERTED" && <button className="btn sm danger" onClick={() => { rv.run({ log_id: r.id }); setTimeout(() => setNonce((n) => n + 1), 1500); }}>Revert</button>}</td></tr>)}
      </tbody></table></div>}
    </div>
  );
}

function SettingsView() {
  const [nonce, setNonce] = useState(0);
  const st = job<Any>(`access_settings:${nonce}`, () => send("access_settings"));
  const set = useRun<Any>("access_settings");
  const on = set.j?.result ? set.j.result.apply_enabled : st.result?.apply_enabled;
  return (
    <div className="card" style={{ maxWidth: 760 }}>
      <h3>Apply grants from the app</h3>
      <div className="callout" style={{ marginBottom: 10 }}>
        Off by default. When on, anyone who can open Role Explorer can run the generated SQL as RBAC_EXPLORER_ROLE, after reviewing it.
        The server only runs statements it generated from a saved bundle: CREATE ROLE AR_*, grants of SELECT, USAGE or READ to an AR_* role,
        and GRANT ROLE AR_* to a role that isn't a system, protected or access role. Every run is logged and can be reverted.
      </div>
      {st.error && <ErrorBox msg={st.error} />}
      {on !== undefined && <label className="toggle"><input type="checkbox" checked={!!on} disabled={!!set.j?.loading}
        onChange={(e) => { set.run({ apply_enabled: e.target.checked }); setTimeout(() => setNonce((n) => n + 1), 1500); resetJob("x"); }} />
        Allow Apply ({on ? "on" : "off"})</label>}
    </div>
  );
}
