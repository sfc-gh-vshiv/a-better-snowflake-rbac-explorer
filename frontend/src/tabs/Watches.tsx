// Custom alert kinds: "Describe an alert" (bot draft), per-kind editable forms with a live
// preview, and the list of saved custom alerts. Protected-role drafts go to the existing form.
import React, { useEffect, useMemo, useState } from "react";
import { job, resetJob, send, setStore, useAction, useStore } from "../kit";
import { RBAC } from "../graph";
import { ErrorBox } from "../ui";

type Any = any;
export const KIND_LABEL: Record<string, string> = {
  protected_role: "Protected role", admin_holders: "Role holders change",
  sensitive_privilege: "Sensitive privilege", new_principal: "New user / role",
  bundle_drift: "AI asset drift", bundle_broken: "Access role broken",
};
const PRIVS = ["MANAGE GRANTS", "CREATE USER", "CREATE ROLE", "CREATE INTEGRATION", "CREATE DATABASE", "CREATE WAREHOUSE", "CREATE SHARE",
  "CREATE NETWORK POLICY", "CREATE ACCOUNT", "EXECUTE TASK", "EXECUTE MANAGED TASK", "MONITOR USAGE", "MONITOR EXECUTION", "IMPORT SHARE",
  "APPLY MASKING POLICY", "APPLY ROW ACCESS POLICY", "APPLY TAG", "MANAGE ACCOUNT SUPPORT CASES", "OVERRIDE SHARE RESTRICTIONS",
  "OWNERSHIP", "ALL PRIVILEGES", "USAGE", "MODIFY", "MONITOR", "CREATE SCHEMA", "APPLYBUDGET"];
export type WDraft = { id?: string; kind: string; name: string; spec: Any; email: string; slack: boolean; enabled: boolean; note: string };

export function blankSpec(kind: string): Any {
  if (kind === "admin_holders") return { roles: ["ACCOUNTADMIN"], inherited: true, allowed_users: [] };
  if (kind === "sensitive_privilege") return { privileges: ["MANAGE GRANTS"], scope: "ACCOUNT", except_roles: [] };
  return { object: "USER", name_pattern: "", user_type: null, owner_in: [] };
}

function Tags({ values, options, onChange, placeholder }: { values: string[]; options: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [q, setQ] = useState("");
  const hits = q ? options.filter((o) => o.toUpperCase().includes(q.toUpperCase()) && !values.includes(o)).slice(0, 8) : [];
  const add = (v: string) => { onChange([...values, v]); setQ(""); };
  return (
    <div style={{ position: "relative" }}>
      <div className="row" style={{ border: "1px solid var(--border2)", borderRadius: 8, padding: 5, background: "#fff", minHeight: 36 }}>
        {values.map((v) => <span key={v} className="pill info" style={{ fontSize: 12.5 }}>{v}
          <span style={{ cursor: "pointer", marginLeft: 4 }} onClick={() => onChange(values.filter((x) => x !== v))}>×</span></span>)}
        <input style={{ border: 0, outline: 0, flex: 1, minWidth: 120, font: "inherit" }} placeholder={placeholder} value={q}
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && hits[0]) add(hits[0]); }} />
      </div>
      {hits.length > 0 && <div className="listpick" style={{ position: "absolute", zIndex: 5, left: 0, right: 0, top: "100%", maxHeight: 200 }}>
        {hits.map((h) => <div key={h} onClick={() => add(h)}>{h}</div>)}</div>}
    </div>
  );
}

/** Text box + Ask-panel hand-off. Calls onDraft with a validated draft from the bot. */
export function DescribeAlert({ onDraft }: { onDraft: (d: Any) => void }) {
  const s = useStore();
  const [text, setText] = useState("");
  const [req, setReq] = useState<{ text: string; answer?: string; nonce: number } | null>(null);
  useEffect(() => {
    if (s.alertAsk) { setText(s.alertAsk.text); setReq(s.alertAsk); setStore({ alertAsk: null }); }
  }, [s.alertAsk]);
  const j = req ? job<Any>("adraft:" + req.nonce, () => send("alert_draft", req)) : null;
  useEffect(() => { if (j?.result?.ok) { onDraft(j.result); setReq(null); } }, [j?.result]);
  return (
    <div className="card">
      <h3>Describe an alert</h3>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <textarea className="txt" rows={2} style={{ flex: 1 }} value={text}
          placeholder="e.g. Tell me if anyone new gets ACCOUNTADMIN, even through another role · Alert me when a PERSON user is created with a name ending in _SVC"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && text.trim()) { e.preventDefault(); setReq({ text, nonce: Date.now() }); } }} />
        <button className="btn primary" disabled={!text.trim() || !!j?.loading} onClick={() => setReq({ text, nonce: Date.now() })}>
          {j?.loading ? `Drafting…${j.elapsed ? " " + j.elapsed + "s" : ""}` : "Draft with AI"}</button>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        The assistant fills in a rule form below. Nothing is turned on until you review it and click <b>Save</b>.
      </div>
      {j?.result && !j.result.ok && <div className="callout warn" style={{ marginTop: 8 }}>{j.result.reason}</div>}
      {j?.error && <div style={{ marginTop: 8 }}><ErrorBox msg={j.error} /></div>}
    </div>
  );
}

function specKey(kind: string, spec: Any) { return kind + ":" + JSON.stringify(spec); }

function Preview({ d }: { d: WDraft }) {
  const [key, setKey] = useState(specKey(d.kind, d.spec));
  useEffect(() => { const t = setTimeout(() => setKey(specKey(d.kind, d.spec)), 600); return () => clearTimeout(t); }, [d.kind, JSON.stringify(d.spec)]);
  const [kind, spec] = [key.slice(0, key.indexOf(":")), JSON.parse(key.slice(key.indexOf(":") + 1))];
  const j = job<Any>("wprev:" + key, () => send("alert_preview", { kind, spec }));
  if (j.loading) return <div className="callout">Reading live grants…{j.elapsed ? ` ${j.elapsed}s` : ""}</div>;
  if (j.error) return <div className="callout warn">{j.error}</div>;
  const r = j.result!;
  const what = d.kind === "admin_holders" ? "users can use these roles today" : d.kind === "sensitive_privilege" ? "grants match today" : "existing objects match";
  return (
    <div className="callout ok">
      <b>{r.count} {what}.</b> They become the baseline: only changes after you save will alert.
      {r.count > 0 && <div className="mono" style={{ fontSize: 11.5, marginTop: 4, maxHeight: 120, overflowY: "auto" }}>
        {r.items.slice(0, 60).map((x: Any) => <div key={x.key}>{x.path || (x.privilege ? `${x.privilege} on ${x.on} → ${x.grantee}` : `${x.grantee}${x.user_type ? " (" + x.user_type + ")" : ""}${x.owner ? " · owner " + x.owner : ""}`)}</div>)}
        {r.count > 60 && <div>… {r.count - 60} more</div>}</div>}
    </div>
  );
}

export function WatchForm({ m, d, setD, onDone }: { m: RBAC; d: WDraft; setD: (d: WDraft | null) => void; onDone: () => void }) {
  const roles = useMemo(() => m.ids.filter((_, i) => !["db", "app"].includes(m.kind[i])).sort(), [m]);
  const users = useMemo(() => m.raw.users.map((u) => u.name).sort(), [m]);
  const dbs = useMemo(() => [...new Set(m.raw.objs.filter(([t]) => m.raw.otypes[t] === "DATABASE").map(([, n]) => n))].sort(), [m]);
  const [saveN, setSaveN] = useState(0);
  const sv = saveN ? job<Any>("wsave:" + saveN, () => send("watch_save", d)) : null;
  useEffect(() => { if (sv?.result) { setSaveN(0); onDone(); } }, [sv?.result]);
  const sp = d.spec, set = (patch: Any) => setD({ ...d, spec: { ...sp, ...patch } });
  return (
    <div className="card" style={{ borderColor: "var(--bright)" }}>
      <div className="between"><h3>{d.id ? "Edit alert" : "New alert"} <span className="pill info">{KIND_LABEL[d.kind]}</span></h3>
        {!d.id && <select className="txt" value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value, spec: blankSpec(e.target.value) })}>
          {["admin_holders", "sensitive_privilege", "new_principal"].map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select>}</div>
      <div className="grid g2">
        <div className="grid" style={{ gap: 10, alignContent: "start" }}>
          <label>Name<br /><input className="txt" style={{ width: "100%" }} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></label>
          {d.kind === "admin_holders" && <>
            <div>Alert when someone new can use<Tags values={sp.roles} options={roles} placeholder="add role…" onChange={(v) => set({ roles: v })} /></div>
            <label className="toggle"><input type="checkbox" checked={sp.inherited} onChange={(e) => set({ inherited: e.target.checked })} />
              Also through parent roles (inheritance)</label>
            <div>Never alert for<Tags values={sp.allowed_users} options={users} placeholder="add user…" onChange={(v) => set({ allowed_users: v })} /></div>
          </>}
          {d.kind === "sensitive_privilege" && <>
            <div>Privileges<Tags values={sp.privileges} options={PRIVS} placeholder="add privilege…" onChange={(v) => set({ privileges: v })} /></div>
            <label>On<br /><select className="txt" value={sp.scope === "ACCOUNT" ? "ACCOUNT" : "DB"}
              onChange={(e) => set({ scope: e.target.value === "ACCOUNT" ? "ACCOUNT" : { databases: [] } })}>
              <option value="ACCOUNT">the account</option><option value="DB">specific databases</option></select></label>
            {sp.scope !== "ACCOUNT" && <Tags values={sp.scope.databases} options={dbs} placeholder="add database… (max 20)"
              onChange={(v) => set({ scope: { databases: v } })} />}
            <div>Ignore grants to<Tags values={sp.except_roles} options={roles} placeholder="add role…" onChange={(v) => set({ except_roles: v })} /></div>
          </>}
          {d.kind === "new_principal" && <>
            <label>Object<br /><select className="txt" value={sp.object} onChange={(e) => set({ object: e.target.value, user_type: null })}>
              <option value="USER">user</option><option value="ROLE">role</option></select></label>
            <label>Name pattern (* and ? wildcards, optional)<br /><input className="txt" style={{ width: "100%" }} value={sp.name_pattern || ""}
              placeholder="e.g. *_SVC" onChange={(e) => set({ name_pattern: e.target.value })} /></label>
            {sp.object === "USER" && <label>User type<br /><select className="txt" value={sp.user_type || ""} onChange={(e) => set({ user_type: e.target.value || null })}>
              <option value="">any</option><option>PERSON</option><option>SERVICE</option><option>LEGACY_SERVICE</option></select></label>}
            <div>Owned by (optional)<Tags values={sp.owner_in} options={roles} placeholder="add role…" onChange={(v) => set({ owner_in: v })} /></div>
          </>}
        </div>
        <div className="grid" style={{ gap: 10, alignContent: "start" }}>
          <label>Email<br /><input className="txt" style={{ width: "100%" }} value={d.email} onChange={(e) => setD({ ...d, email: e.target.value })} />
            <span className="muted" style={{ fontSize: 12 }}>Must be an allowed recipient of the RBAC_EXPLORER_EMAIL_INT integration.</span></label>
          <label className="toggle"><input type="checkbox" checked={d.slack} onChange={(e) => setD({ ...d, slack: e.target.checked })} />Post to Slack</label>
          <label className="toggle"><input type="checkbox" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} />Enabled</label>
          <label>Note<br /><input className="txt" style={{ width: "100%" }} value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} /></label>
          <Preview d={d} />
        </div>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={!!sv?.loading} onClick={() => setSaveN(Date.now())}>{sv?.loading ? "Saving…" : "Save alert"}</button>
        <button className="btn" onClick={() => setD(null)}>Cancel</button>
        {sv?.error && <span className="err" style={{ padding: "4px 10px" }}>{sv.error}</span>}
      </div>
    </div>
  );
}

export function WatchList({ watches, log, onEdit }: { watches: Any[]; log: Any[]; onEdit: (w: Any) => void }) {
  const del = useAction(), tog = useAction();
  useEffect(() => { if (del.ok || tog.ok) { resetJob("alert_rules"); del.reset(); tog.reset(); } }, [del.ok, tog.ok]);
  if (!watches.length) return null;
  return (
    <>
      {[del.error, tog.error].filter(Boolean).map((e) => <ErrorBox key={e} msg={e!} />)}
      <div className="grid g2">
        {watches.map((w) => {
          const openFor = log.filter((x) => x.rule_id === w.id && x.status === "OPEN").length;
          return (
            <div key={w.id} className="card" style={{ opacity: w.enabled ? 1 : 0.6, borderColor: openFor ? "rgba(220,38,38,.45)" : undefined }}>
              <div className="between">
                <span className="row"><b>{w.name}</b><span className="pill info">{KIND_LABEL[w.kind]}</span>
                  {openFor ? <span className="pill bad">{openFor} open</span> : <span className="pill ok">clean</span>}
                  {!w.enabled && <span className="pill plain">disabled</span>}</span>
                <span className="row">
                  <button className="btn sm" onClick={() => onEdit(w)}>Edit</button>
                  <button className="btn sm" disabled={tog.busy} onClick={() => tog.run("watch_toggle", { id: w.id, enabled: !w.enabled })}>{w.enabled ? "Disable" : "Enable"}</button>
                  <button className="btn sm danger" disabled={del.busy} onClick={() => del.run("watch_delete", { id: w.id })}>Delete</button>
                </span>
              </div>
              <div className="kv" style={{ marginTop: 8 }}>
                <span className="k">Rule</span><span>{w.summary}</span>
                <span className="k">Baseline</span><span>{w.baseline} existing item{w.baseline === 1 ? "" : "s"} ignored</span>
                <span className="k">Notify</span><span>{[w.email, w.slack && "Slack"].filter(Boolean).join(" · ") || "log only"}</span>
                {w.note && <><span className="k">Note</span><span>{w.note}</span></>}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
