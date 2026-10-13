import React, { useEffect, useMemo, useState } from "react";
import { job, resetJob, send, setStore, useAction, useStore } from "../kit";
import { RBAC } from "../graph";
import { ErrorBox, Metric, RoleChip, ago, fmt } from "../ui";
import { DescribeAlert, KIND_LABEL, WDraft, WatchForm, WatchList, blankSpec } from "./Watches";

type Any = any;
// Pre-fills new rules; set it to the address you configured in setup/setup.sql (alert_email).
const DEFAULT_EMAIL = "";

function useRules() {
  // Keep the last result while a refresh runs, so the tab never collapses to a skeleton
  // (that shrinks the page and resets the scroll position).
  const j = job<Any>("alert_rules", () => send("alert_rules", {}));
  const W = window as Any;
  if (j.result) W.__reRules = j.result;
  return j.result || !W.__reRules ? j : { ...j, loading: false, result: W.__reRules };
}

function TagInput({ values, options, onChange, placeholder }: { values: string[]; options: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [q, setQ] = useState("");
  const hits = q ? options.filter((o) => o.toUpperCase().includes(q.toUpperCase()) && !values.includes(o)).slice(0, 8) : [];
  return (
    <div style={{ position: "relative" }}>
      <div className="row" style={{ border: "1px solid var(--border2)", borderRadius: 8, padding: 5, background: "#fff", minHeight: 36 }}>
        {values.map((v) => (
          <span key={v} className="pill info" style={{ fontSize: 12.5 }}>{v}
            <span style={{ cursor: "pointer", marginLeft: 4 }} onClick={() => onChange(values.filter((x) => x !== v))}>×</span></span>
        ))}
        <input style={{ border: 0, outline: 0, flex: 1, minWidth: 120, font: "inherit" }} placeholder={placeholder} value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && hits[0]) { onChange([...values, hits[0]]); setQ(""); } }} />
      </div>
      {hits.length > 0 && (
        <div className="listpick" style={{ position: "absolute", zIndex: 5, left: 0, right: 0, top: "100%", maxHeight: 200, boxShadow: "0 6px 18px rgba(15,23,42,.12)" }}>
          {hits.map((h) => <div key={h} onClick={() => { onChange([...values, h]); setQ(""); }}>{h}</div>)}
        </div>
      )}
    </div>
  );
}

type Draft = { role: string; useUsers: boolean; allowed_users: string[]; allowed_type: string; useParents: boolean; allowed_parents: string[];
  email: string; slack: boolean; auto_revoke: boolean; enabled: boolean; note: string };

function draftFor(m: RBAC, role: string, existing?: Any): Draft {
  const r = m.byId.get(role);
  if (existing) return {
    role, useUsers: existing.allowed_users !== null, allowed_users: existing.allowed_users || [], allowed_type: existing.allowed_type || "",
    useParents: existing.allowed_parents !== null, allowed_parents: existing.allowed_parents || [], email: existing.email || "",
    slack: existing.slack, auto_revoke: existing.auto_revoke, enabled: existing.enabled, note: existing.note || "" };
  const users = r === undefined ? [] : m.roleUsers[r].map((u) => m.raw.users[u]);
  const svc = users.filter((u) => (u.type || "").includes("SERVICE"));
  return {
    role, useUsers: true, allowed_users: (svc.length ? svc : users).map((u) => u.name),
    allowed_type: svc.length || /SVC|SERVICE/i.test(role) ? "SERVICE" : "",
    useParents: true, allowed_parents: r === undefined ? [] : m.heldBy[r].filter((p) => m.kind[p] !== "db").map((p) => m.ids[p]),
    email: DEFAULT_EMAIL, slack: false, auto_revoke: false, enabled: true, note: "" };
}

/** Who would violate this rule today, using the ACCOUNT_USAGE snapshot. */
function preview(m: RBAC, d: Draft) {
  const r = m.byId.get(d.role);
  if (r === undefined) return [];
  const out: { who: string; why: string }[] = [];
  for (const u of m.roleUsers[r]) {
    const x = m.raw.users[u], t = x.type || "PERSON";
    const why = [];
    if (d.useUsers && !d.allowed_users.map((a) => a.toUpperCase()).includes(x.name.toUpperCase())) why.push("not on allowlist");
    if (d.allowed_type && t !== d.allowed_type) why.push(`type ${t}`);
    if (why.length) out.push({ who: "user " + x.name, why: why.join(", ") });
  }
  if (d.useParents) for (const p of m.heldBy[r]) if (!d.allowed_parents.includes(m.ids[p])) out.push({ who: "role " + m.ids[p], why: "parent role not allowed" });
  return out;
}

export function AlertsTab({ m }: { m: RBAC }) {
  const s = useStore();
  const j = useRules();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [wdraft, setWDraft] = useState<WDraft | null>(null);
  const onBotDraft = (r: Any) => {
    if (r.kind === "protected_role") {
      const sp = r.spec, base = draftFor(m, sp.role);
      setWDraft(null);
      setDraft({ ...base, useUsers: sp.allowed_users !== null, allowed_users: sp.allowed_users || [], allowed_type: sp.allowed_type || "",
        useParents: sp.allowed_parents !== null, allowed_parents: sp.allowed_parents || [], note: r.name });
    } else {
      setDraft(null);
      setWDraft({ kind: r.kind, name: r.name, spec: r.spec, email: DEFAULT_EMAIL, slack: false, enabled: true, note: "" });
    }
  };
  const save = useAction(), del = useAction(), ack = useAction(), task = useAction(), demo = useAction();
  // keep the log fresh while this tab is open
  useEffect(() => { const t = setInterval(() => resetJob("alert_rules"), 20000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (s.alertDraft && m.byId.has(s.alertDraft)) { setDraft(draftFor(m, s.alertDraft)); setStore({ alertDraft: null }); }
  }, [s.alertDraft]);
  useEffect(() => { if (save.ok || del.ok || ack.ok || task.ok || demo.ok) resetJob("alert_rules"); }, [save.ok, del.ok, ack.ok, task.ok, demo.ok]);
  useEffect(() => { if (save.ok) { setDraft(null); save.reset(); } }, [save.ok]);
  const [testNonce, setTestNonce] = useState(0);
  const testJob = testNonce ? job<Any>("alerttest:" + testNonce, () => send("alert_test", { nonce: testNonce })) : null;
  useEffect(() => { if (testJob?.result) resetJob("alert_rules"); }, [!!testJob?.result]);

  const accountRoles = useMemo(() => m.ids.filter((_, i) => !["db", "app"].includes(m.kind[i])).sort(), [m]);
  const userNames = useMemo(() => m.raw.users.map((u) => u.name).sort(), [m]);
  if (j.error) return <ErrorBox msg={j.error} />;
  const d = j.result;
  const st = d?.state, tk = d?.task;
  const open = (d?.log || []).filter((x: Any) => x.status === "OPEN").length;
  const running = tk?.state === "started";

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="grid g4">
        <Metric l="Watcher" v={tk ? (running ? "Running" : "Suspended") : "—"} color={running ? "#059669" : "#dc2626"} s={tk ? `every ${String(tk.schedule || "").replace("MINUTE", "min")}` : "task not found"} />
        <Metric l="Last check" v={st?.last_run ? ago(st.last_run) : "never"} s={st ? `${st.rules} rules · ${fmt(st.ms || 0)} ms` : ""} />
        <Metric l="Open alerts" v={open} color={open ? "#dc2626" : "#059669"} s="unresolved violations" />
        <Metric l="Alert rules" v={(d?.rules || []).filter((r: Any) => r.enabled).length + (d?.watches || []).filter((w: Any) => w.enabled).length}
          s={`${(d?.rules || []).length} protected roles · ${(d?.watches || []).length} custom`} />
      </div>
      {st?.error && <div className="callout bad">Last run reported: {st.error}</div>}
      <DescribeAlert onDraft={onBotDraft} />
      <div className="card">
        <div className="between">
          <div style={{ maxWidth: 760 }}>
            <h3>Protected roles</h3>
            <div className="muted" style={{ fontSize: 13 }}>
              A protected role may only be held by the users you allow (and/or only by SERVICE users) and may only be granted to the parent roles you allow.
              Every minute a serverless task reads the <b>live</b> grants (<code>SHOW GRANTS OF ROLE</code>, not the 2-hour-delayed ACCOUNT_USAGE), finds who ran the
              <code>GRANT</code>, and alerts by email and Slack with a ready-to-run <code>REVOKE</code>.
            </div>
          </div>
          <div className="row">
            <button className="btn" disabled={!!testJob?.loading} onClick={() => setTestNonce(Date.now())}>{testJob?.loading ? "Checking…" : "Run check now"}</button>
            {tk && <button className="btn" disabled={task.busy} onClick={() => task.run("alert_task", { resume: !running })}>{running ? "Pause watcher" : "Resume watcher"}</button>}
            <button className="btn" onClick={() => { setDraft(null); setWDraft({ kind: "admin_holders", name: "", spec: blankSpec("admin_holders"),
              email: DEFAULT_EMAIL, slack: false, enabled: true, note: "" }); }}>+ Custom alert</button>
            <button className="btn primary" onClick={() => { setWDraft(null); setDraft(draftFor(m, s.sel && accountRoles.includes(s.sel) ? s.sel : accountRoles[0])); }}>+ Protect a role</button>
          </div>
        </div>
        {testJob?.result && <div className={"callout " + (testJob.result.new?.length ? "warn" : "ok")} style={{ marginTop: 10 }}>
          Checked {testJob.result.rules} rules in {fmt(testJob.result.ms)} ms: {testJob.result.new?.length || 0} new violation(s), {testJob.result.resolved || 0} resolved.
          {(testJob.result.errors || []).map((e: string) => <div key={e}>{e}</div>)}</div>}
        {testJob?.error && <div style={{ marginTop: 10 }}><ErrorBox msg={testJob.error} /></div>}
        {[task.error, del.error, ack.error, demo.error].filter(Boolean).map((e) => <div key={e} style={{ marginTop: 10 }}><ErrorBox msg={e!} /></div>)}
      </div>

      {draft && (
        <div className="card" style={{ borderColor: "var(--bright)" }}>
          <h3>{(d?.rules || []).some((r: Any) => r.role === draft.role) ? "Edit rule" : "New rule"}</h3>
          <div className="grid g2">
            <div className="grid" style={{ gap: 10 }}>
              <label>Role<br /><select className="txt" style={{ width: "100%" }} value={draft.role}
                onChange={(e) => setDraft(draftFor(m, e.target.value, (d?.rules || []).find((r: Any) => r.role === e.target.value)))}>
                {accountRoles.map((r) => <option key={r}>{r}</option>)}</select></label>
              <div>
                <label className="toggle" style={{ marginBottom: 6 }}><input type="checkbox" checked={draft.useUsers} onChange={(e) => setDraft({ ...draft, useUsers: e.target.checked })} />Only these users may hold it</label>
                {draft.useUsers && <TagInput values={draft.allowed_users} options={userNames} placeholder="add user…" onChange={(v) => setDraft({ ...draft, allowed_users: v })} />}
              </div>
              <label>Users must be of type<br />
                <select className="txt" value={draft.allowed_type} onChange={(e) => setDraft({ ...draft, allowed_type: e.target.value })}>
                  <option value="">any type</option><option value="SERVICE">SERVICE (service accounts only)</option>
                  <option value="LEGACY_SERVICE">LEGACY_SERVICE</option><option value="PERSON">PERSON</option></select></label>
              <div>
                <label className="toggle" style={{ marginBottom: 6 }}><input type="checkbox" checked={draft.useParents} onChange={(e) => setDraft({ ...draft, useParents: e.target.checked })} />Only these roles may inherit it</label>
                {draft.useParents && <TagInput values={draft.allowed_parents} options={accountRoles} placeholder="add parent role… (empty = none)" onChange={(v) => setDraft({ ...draft, allowed_parents: v })} />}
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Granting the role to another role gives it to every holder of that role, so this is checked too.</div>
              </div>
            </div>
            <div className="grid" style={{ gap: 10, alignContent: "start" }}>
              <label>Email<br /><input className="txt" style={{ width: "100%" }} value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
                <span className="muted" style={{ fontSize: 12 }}>Must be an allowed recipient of the RBAC_EXPLORER_EMAIL_INT integration.</span></label>
              <label className="toggle"><input type="checkbox" checked={draft.slack} onChange={(e) => setDraft({ ...draft, slack: e.target.checked })} />Post to Slack (RBAC_EXPLORER_SLACK_INT)</label>
              <label className="toggle"><input type="checkbox" checked={draft.auto_revoke} onChange={(e) => setDraft({ ...draft, auto_revoke: e.target.checked })} />Auto-revoke violating grants</label>
              {draft.auto_revoke && <div className="callout warn">The watcher will run <code>REVOKE ROLE {draft.role} FROM …</code> within a minute of any violation. Make sure the allowlist is complete.</div>}
              <label className="toggle"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />Enabled</label>
              <label>Note<br /><input className="txt" style={{ width: "100%" }} value={draft.note} placeholder="e.g. ingestion service account only" onChange={(e) => setDraft({ ...draft, note: e.target.value })} /></label>
              <RulePreview m={m} d={draft} />
            </div>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={save.busy} onClick={() => save.run("alert_save", {
              role: draft.role, allowed_users: draft.useUsers ? draft.allowed_users : null, allowed_type: draft.allowed_type || null,
              allowed_parents: draft.useParents ? draft.allowed_parents : null, email: draft.email, slack: draft.slack,
              auto_revoke: draft.auto_revoke, enabled: draft.enabled, note: draft.note })}>{save.busy ? "Saving…" : "Save rule"}</button>
            <button className="btn" onClick={() => { setDraft(null); save.reset(); }}>Cancel</button>
            {save.error && <span className="err" style={{ padding: "4px 10px" }}>{save.error}</span>}
          </div>
        </div>
      )}

      {wdraft && <WatchForm m={m} d={wdraft} setD={setWDraft} onDone={() => { setWDraft(null); resetJob("alert_rules"); }} />}

      {!d ? <div className="card"><div className="skel" style={{ height: 120 }} /></div> : (
        <div className="grid g2">
          {d.rules.length === 0 && <div className="card empty">No protected roles yet. Click <b>+ Protect a role</b>.</div>}
          {d.rules.map((r: Any) => {
            const ri = m.byId.get(r.role);
            const pv = preview(m, draftFor(m, r.role, r));
            const openFor = d.log.filter((x: Any) => x.role_name === r.role && x.status === "OPEN").length;
            return (
              <div key={r.role} className="card" style={{ opacity: r.enabled ? 1 : 0.6, borderColor: openFor ? "rgba(220,38,38,.45)" : undefined }}>
                <div className="between">
                  <span className="row">{ri !== undefined ? <RoleChip m={m} r={ri} /> : <b>{r.role}</b>}
                    {openFor ? <span className="pill bad">{openFor} open</span> : <span className="pill ok">clean</span>}
                    {!r.enabled && <span className="pill plain">disabled</span>}{r.auto_revoke && <span className="pill warn">auto-revoke</span>}</span>
                  <span className="row">
                    <button className="btn sm" onClick={() => setDraft(draftFor(m, r.role, r))}>Edit</button>
                    <button className="btn sm danger" disabled={del.busy} onClick={() => del.run("alert_delete", { role: r.role })}>Delete</button>
                  </span>
                </div>
                <div className="kv" style={{ marginTop: 8 }}>
                  <span className="k">Allowed users</span><span>{r.allowed_users === null ? <span className="muted">any</span> : r.allowed_users.length ? r.allowed_users.join(", ") : <i>none</i>}</span>
                  <span className="k">User type</span><span>{r.allowed_type || <span className="muted">any</span>}</span>
                  <span className="k">Parent roles</span><span>{r.allowed_parents === null ? <span className="muted">not checked</span> : r.allowed_parents.length ? r.allowed_parents.join(", ") : <i>none allowed</i>}</span>
                  <span className="k">Notify</span><span>{[r.email, r.slack && "Slack"].filter(Boolean).join(" · ") || "log only"}</span>
                  {r.note && <><span className="k">Note</span><span>{r.note}</span></>}
                </div>
                {pv.length > 0 && <div className="callout warn" style={{ marginTop: 8, fontSize: 12.5 }}>In the latest snapshot: {pv.map((x) => `${x.who} (${x.why})`).join("; ")}</div>}
              </div>
            );
          })}
        </div>
      )}

      {d && (d.watches || []).length > 0 && <h3 style={{ margin: "4px 2px 0" }}>Custom alerts</h3>}
      {d && <WatchList watches={d.watches || []} log={d.log} onEdit={(w: Any) => {
        setDraft(null);
        setWDraft({ id: w.id, kind: w.kind, name: w.name, spec: w.spec, email: w.email || "", slack: w.slack, enabled: w.enabled, note: w.note || "" });
      }} />}

      {d?.demo?.exists && (
        <div className="card">
          <div className="between">
            <div>
              <h3>Try it: demo violation</h3>
              <div className="muted" style={{ fontSize: 13 }}>
                <code>{d.demo.role}</code> is meant for the service user <code>{d.demo.svc_user}</code> only. Grant it to the person
                <code>{d.demo.person_user}</code> and watch the alert arrive. Current holders: {d.demo.holders.join(", ") || "none"}.
              </div>
            </div>
            <div className="row">
              <button className="btn danger" disabled={demo.busy || d.demo.holders.includes(d.demo.person_user)} onClick={() => demo.run("alert_demo", { step: "violate" })}>Grant to {d.demo.person_user}</button>
              <button className="btn" disabled={demo.busy || !d.demo.holders.includes(d.demo.person_user)} onClick={() => demo.run("alert_demo", { step: "undo" })}>Undo</button>
            </div>
          </div>
        </div>
      )}

      {d && (
        <div className="card">
          <div className="between"><h3>Alert log</h3><span className="muted" style={{ fontSize: 12 }}>refreshes every 20 s</span></div>
          {d.log.length === 0 ? <div className="empty">No alerts yet.</div> : (
            <div className="scroll tscroll"><table className="t"><thead><tr><th>Detected</th><th>Alert</th><th>Grantee</th><th>Why</th><th>Granted by</th><th>Status</th><th /></tr></thead><tbody>
              {d.log.map((x: Any) => (
                <tr key={x.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{ago(x.detected_at)}<div className="muted" style={{ fontSize: 11.5 }}>{String(x.detected_at).slice(0, 19).replace("T", " ")}</div></td>
                  <td><span className="pill plain" style={{ marginBottom: 3 }}>{KIND_LABEL[x.kind] || x.kind}</span>
                    <div><b>{x.kind === "protected_role" ? x.role_name : x.detail?.rule || x.role_name}</b></div></td>
                  <td>{x.grantee_type?.toLowerCase()} <b>{x.grantee}</b>{x.grantee_user_type && <div className="muted" style={{ fontSize: 11.5 }}>{x.grantee_user_type}</div>}</td>
                  <td style={{ maxWidth: 260 }}>{x.reason}{x.detail?.fix && <div className="mono muted" style={{ fontSize: 11 }}>{x.detail.fix}</div>}</td>
                  <td>{x.granted_by_user ? <b>{x.granted_by_user}</b>
                    : x.granted_by_candidates ? <span title="Users holding the granting role. The exact user is filled in from ACCOUNT_USAGE within about an hour.">one of <b>{x.granted_by_candidates}</b></span>
                    : <span className="muted">unknown user</span>}<div className="muted" style={{ fontSize: 11.5 }}>as {x.granted_by_role || "?"}</div>
                    {x.query_text && <div className="mono muted" style={{ fontSize: 11, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={x.query_text}>{x.query_text}</div>}</td>
                  <td><span className={"pill " + (x.status === "OPEN" ? "bad" : x.status === "ACKED" ? "warn" : "ok")}>{x.status.toLowerCase()}</span>
                    {x.action === "REVOKED" && <div className="pill ok" style={{ marginTop: 3 }}>auto-revoked</div>}
                    <div className="muted" style={{ fontSize: 11.5 }}>{x.notified}</div></td>
                  <td>{x.status === "OPEN" && <button className="btn sm" disabled={ack.busy} onClick={() => ack.run("alert_ack", { id: x.id })}>Ack</button>}</td>
                </tr>
              ))}
            </tbody></table></div>
          )}
        </div>
      )}
    </div>
  );
}

function RulePreview({ m, d }: { m: RBAC; d: Draft }) {
  const pv = preview(m, d);
  return pv.length
    ? <div className="callout warn"><b>{pv.length} would alert right away:</b>{pv.map((x) => <div key={x.who}>{x.who} · {x.why}</div>)}</div>
    : <div className="callout ok">Today's holders all satisfy this rule.</div>;
}

export function useOpenAlerts(): number {
  const j = useRules();
  return (j.result?.log || []).filter((x: Any) => x.status === "OPEN").length;
}
