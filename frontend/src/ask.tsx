// Ask bot: floating chat panel. Context is built from the in-browser RBAC model (no extra
// queries): account summary, admin holders, hygiene headlines, the current tab's selection,
// the alert rules, and facts for every role or user named in the question.
import React, { useEffect, useRef, useState } from "react";
import { job, response, send, setStore, store, useStore } from "./kit";
import { RBAC, hygiene } from "./graph";

type Any = any;
const W = window as Any;
const ADMIN = ["ORGADMIN", "ACCOUNTADMIN", "SECURITYADMIN", "USERADMIN", "SYSADMIN"];
export const ALERT_RE = /^\s*(?:(?:alert|notify|email|ping|warn|tell|let)\s+me\b|(?:watch|monitor|track)\s)/i;
const take = <T,>(a: T[], n: number) => (a.length > n ? [...a.slice(0, n), `…${a.length - n} more` as Any] : a);

type Turn = { role: "user" | "bot"; text?: string; key?: string; payload?: Any; note?: string };
type Thread = { open: boolean; turns: Turn[]; big?: boolean };
const T: Thread = W.__reAsk || (W.__reAsk = { open: false, turns: [] });

// ------------------------------------------------------------ context
function roleFacts(m: RBAC, r: number) {
  const eff = m.usersOf(r).map((u) => m.raw.users[u].name).sort();
  const acct = m.effective(r).filter((x) => m.objType(m.gObj(x.g)) === "ACCOUNT")
    .map((x) => `${m.gPriv(x.g)}${x.via !== r ? " via " + m.ids[x.via] : ""}`);
  const objs = m.grantsByRole[r].filter((g) => m.objType(m.gObj(g)) !== "ACCOUNT")
    .map((g) => `${m.gPriv(g)} on ${m.objType(m.gObj(g)).toLowerCase()} ${m.objName(m.gObj(g))}`);
  const nd = m.raw.nodes[r];
  return {
    role: m.ids[r], kind: m.kind[r], owner: nd[2], comment: nd[3], created: nd[4]?.slice(0, 10),
    direct_users: take(m.roleUsers[r].map((u) => m.raw.users[u].name), 40),
    effective_users: { count: eff.length, names: take(eff, 40) },
    granted_to_roles: m.heldBy[r].map((p) => m.ids[p]),
    inherits_roles: take(m.inherits[r].map((c) => m.ids[c]), 40),
    all_inherited_roles: m.reach(r).size - 1,
    paths_to_top: m.pathsUp(r, 4).map((p) => p.map((x) => m.ids[x]).join(" -> ")),
    account_privileges: take([...new Set(acct)], 40),
    direct_object_privileges: { count: objs.length, sample: take(objs, 30) },
    effective_privilege_count: m.effective(r).length,
  };
}
function userFacts(m: RBAC, u: number) {
  const x = m.raw.users[u];
  const reach = m.userReach(u);
  const admins = ADMIN.map((a) => m.byId.get(a)).filter((a): a is number => a !== undefined && reach.has(a))
    .map((a) => ({ role: m.ids[a], path: (m.userPath(u, a) || []).map((r) => m.ids[r]).join(" -> ") }));
  return {
    user: x.name, type: x.type || "PERSON", disabled: x.disabled, default_role: x.default_role, last_login: x.last_login?.slice(0, 10),
    created: x.created?.slice(0, 10), owner: x.owner, email: x.email, mfa: x.has_mfa, password: x.has_password, key_pair: x.has_rsa, pat: x.has_pat,
    direct_roles: m.userRoles[u].map((r) => m.ids[r]),
    effective_roles: { count: reach.size, names: take([...reach].map((r) => m.ids[r]).sort(), 50) },
    admin_roles_reached: admins,
  };
}
function mentioned(m: RBAC, q: string) {
  const Q = " " + q.toUpperCase().replace(/[^A-Z0-9_$]+/g, " ") + " ";
  const hit = (name: string) => name.length >= 3 && Q.includes(" " + name.toUpperCase().replace(/[^A-Z0-9_$]+/g, " ") + " ");
  const roles = m.ids.map((id, i) => [id, i] as const).filter(([id]) => hit(id)).sort((a, b) => b[0].length - a[0].length).slice(0, 8);
  const users = m.raw.users.map((x, i) => [x.name, i] as const).filter(([n]) => hit(n)).slice(0, 6);
  return { roles: roles.map(([, i]) => roleFacts(m, i)), users: users.map(([, i]) => userFacts(m, i)) };
}
export function buildContext(m: RBAC, question: string, history: Turn[]) {
  const s = store;
  const users = m.raw.users;
  const page: Any = { tab: s.tab };
  if (s.sel && m.byId.has(s.sel)) page.selected_role = roleFacts(m, m.byId.get(s.sel)!);
  if (s.user) { const u = users.findIndex((x) => x.name === s.user); if (u >= 0) page.selected_user = userFacts(m, u); }
  if (s.tab === "access" && s.obj !== null && m.raw.objs[s.obj]) {
    const a = m.access(s.obj);
    page.selected_object = {
      object: m.objName(s.obj), type: m.objType(s.obj),
      users: take([...a.users].map(([u, v]) => `${users[u].name}: ${v.best} via ${m.ids[v.via]}`), 60),
      roles: take([...a.roles].map(([r, v]) => `${m.ids[r]}: ${[...v.privs].join("/")}`), 60),
    };
  }
  const rm = s.removed;
  if (rm.edges.length || rm.ugrants.length || rm.grants.length)
    page.staged_revokes = {
      role_grants: rm.edges.map((e) => `${m.ids[m.raw.edges[e][0]]} from role ${m.ids[m.raw.edges[e][1]]}`),
      user_grants: rm.ugrants.map((g) => `${m.ids[m.raw.ugrants[g][1]]} from user ${users[m.raw.ugrants[g][0]].name}`),
      privileges: rm.grants.length,
    };
  // Include mentions from the last user turn too, so "and what about them?" keeps context.
  const prevQ = [...history].reverse().find((t) => t.role === "user")?.text || "";
  const types: Record<string, number> = {};
  users.forEach((u) => { const t = u.type || "PERSON"; types[t] = (types[t] || 0) + 1; });
  const alertsRes = response(store.jobs["alert_rules"])?.result || W.__reRules;
  return {
    account: { name: m.raw.account, data_as_of: m.raw.asof, roles: m.n, users: users.length, users_by_type: types,
      disabled_users: users.filter((u) => u.disabled).length, object_privilege_grants: m.nGrants },
    admin_roles: ADMIN.filter((a) => m.byId.has(a)).map((a) => {
      const r = m.byId.get(a)!;
      const nm = (u: number) => users[u].name + (users[u].disabled ? " (disabled)" : "");
      return { role: a, direct_users: m.roleUsers[r].map(nm),
        effective_users: take(m.usersOf(r).map(nm).sort(), 60), granted_to_roles: m.heldBy[r].map((p) => m.ids[p]) };
    }),
    hygiene: hygiene(m).map((f) => ({ finding: f.title, meaning: f.why, severity: f.sev, count: f.items.length,
      sample: take(f.items.map((i) => i.label + (i.detail ? ` (${i.detail})` : "")), 12) })),
    page,
    mentioned: mentioned(m, question + " " + prevQ),
    alerts: alertsRes ? {
      protected_role_rules: alertsRes.rules, other_rules: alertsRes.watches,
      open_alerts: (alertsRes.log || []).filter((x: Any) => x.status === "OPEN").slice(0, 20)
        .map((x: Any) => ({ kind: x.kind, role: x.role_name, grantee: x.grantee, reason: x.reason, detected: x.detected_at })),
      watcher_last_run: alertsRes.state?.last_run,
    } : "not loaded (open the Alerts tab)",
  };
}

// ------------------------------------------------------------ safe markdown (React nodes, never innerHTML)
function inline(s: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let i = 0, k = 0, mm: RegExpExecArray | null;
  while ((mm = re.exec(s))) {
    if (mm.index > i) out.push(s.slice(i, mm.index));
    const t = mm[0];
    if (t.startsWith("**")) out.push(<b key={k++}>{t.slice(2, -2)}</b>);
    else if (t.startsWith("`")) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else out.push(<i key={k++}>{t.slice(1, -1)}</i>);
    i = mm.index + t.length;
  }
  if (i < s.length) out.push(s.slice(i));
  return out;
}
export function Md({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let list: { ord: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const L = list.ord ? "ol" : "ul";
    blocks.push(<L key={blocks.length}>{list.items.map((x, i) => <li key={i}>{inline(x)}</li>)}</L>);
    list = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const b = line.match(/^\s*[-*•]\s+(.*)$/), o = line.match(/^\s*\d+[.)]\s+(.*)$/), h = line.match(/^#{1,4}\s+(.*)$/);
    if (b || o) {
      const ord = !!o;
      if (list && list.ord !== ord) flush();
      if (!list) list = { ord, items: [] };
      list.items.push((b || o)![1]);
      continue;
    }
    flush();
    if (h) blocks.push(<div key={blocks.length} className="mdh">{inline(h[1])}</div>);
    else if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line)}</p>);
  }
  flush();
  return <div className="md">{blocks}</div>;
}

// ------------------------------------------------------------ panel
function useBot(t: Turn) {
  return job<Any>(t.key!, () => send("ask", t.payload), 1200);
}
function BotTurn(props: { t: Turn; last: boolean; onAsk: (q: string) => void; q: string }) {
  // Note turns (e.g. the alert hand-off) have no job: never call useBot for them.
  if (props.t.note) return <div className="bub bot"><Md text={props.t.note} /></div>;
  return <AnswerTurn {...props} />;
}
function AnswerTurn({ t, last, onAsk, q }: { t: Turn; last: boolean; onAsk: (q: string) => void; q: string }) {
  const j = useBot(t);
  if (j.loading) return <div className="bub bot muted">Thinking{j.elapsed ? ` · ${j.elapsed}s` : "…"}</div>;
  if (j.error) return (
    <div className="bub bot err">{j.error}
      <div><button className="btn sm" onClick={() => { delete store.jobs[t.key!]; t.key = t.key + "r"; setStore({}); }}>Retry</button></div></div>);
  const r = j.result || {};
  return (
    <div className="bub bot">
      <Md text={r.text || "(no answer)"} />
      <div className="row" style={{ marginTop: 6, gap: 6 }}>
        <button className="btn sm" onClick={() => setStore({ tab: "alerts", alertAsk: { text: q, answer: r.text, nonce: Date.now() } })}>Alert me about this</button>
      </div>
      {last && (r.followups || []).length > 0 && (
        <div className="row" style={{ marginTop: 6, gap: 6 }}>
          {r.followups.map((f: string) => <button key={f} className="chipq" onClick={() => onAsk(f)}>{f}</button>)}
        </div>)}
    </div>
  );
}
/** Keeps polling answers while the panel is minimised. */
function Poller({ t }: { t: Turn }) { useBot(t); return null; }

export function AskPanel({ m }: { m: RBAC }) {
  useStore(); // re-render on store changes
  const [q, setQ] = useState("");
  const body = useRef<HTMLDivElement>(null);
  const turns = T.turns;
  useEffect(() => { body.current?.scrollTo({ top: 1e6 }); }, [turns.length, T.open]);
  const pending = turns.filter((t) => t.role === "bot" && t.key && !t.note);
  const busy = pending.some((t) => { const r = response(store.jobs[t.key!]); return !r || r.result?.pending; });

  const ask = (text: string) => {
    text = text.trim();
    if (!text) return;
    const history = turns.filter((t) => t.text || t.role === "bot").slice(-8).map((t) => ({
      role: t.role === "user" ? "user" : "assistant",
      text: t.role === "user" ? t.text : response(store.jobs[t.key || ""])?.result?.text || t.note || "" }));
    turns.push({ role: "user", text });
    if (ALERT_RE.test(text)) {
      turns.push({ role: "bot", note: "Drafting that alert on the **Alerts** tab. Review it there and click **Save** to turn it on." });
      setStore({ tab: "alerts", alertAsk: { text, nonce: Date.now() } });
    } else {
      const payload = { question: text, history, page: { tab: store.tab }, ctx: buildContext(m, text, turns.slice(0, -1)) };
      turns.push({ role: "bot", key: "ask:" + Date.now().toString(36), payload });
    }
    setQ(""); setStore({});
  };
  const lastQ = (i: number) => [...turns.slice(0, i)].reverse().find((t) => t.role === "user")?.text || "";

  if (!T.open) return (
    <>
      {pending.map((t) => <Poller key={t.key} t={t} />)}
      <button className="askfab" onClick={() => { T.open = true; setStore({}); }}>{busy ? "Thinking…" : "Ask"}</button>
    </>
  );
  return (
    <div className={"askpanel" + (T.big ? " big" : "")}>
      <div className="between askhead">
        <b>Ask about roles &amp; access</b>
        <span className="row" style={{ gap: 6 }}>
          {turns.length > 0 && <button className="btn sm" onClick={() => { T.turns = []; setStore({}); }}>Clear</button>}
          <button className="btn sm" title={T.big ? "Shrink the chat" : "Expand the chat"}
            onClick={() => { T.big = !T.big; setStore({}); }}>{T.big ? "Shrink" : "Expand"}</button>
          <button className="btn sm" onClick={() => { T.open = false; setStore({}); }}>—</button>
        </span>
      </div>
      <div className="askbody" ref={body}>
        {!turns.length && (
          <div className="muted" style={{ fontSize: 12.5 }}>
            Ask about who can do what in this account. I read the roles, users and grants this app has loaded.
            <div className="row" style={{ marginTop: 8, gap: 6 }}>
              {["Who can use ACCOUNTADMIN, and how?", "Which roles look risky?", "Alert me if anyone new gets ACCOUNTADMIN"].map((x) =>
                <button key={x} className="chipq" onClick={() => ask(x)}>{x}</button>)}
            </div>
          </div>)}
        {turns.map((t, i) => t.role === "user"
          ? <div key={i} className="bub me">{t.text}</div>
          : <BotTurn key={i + (t.key || "")} t={t} last={i === turns.length - 1} onAsk={ask} q={lastQ(i)} />)}
      </div>
      <form className="askin" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <textarea className="txt" rows={2} value={q} placeholder="e.g. Why can BOB read SALES_DB?  ·  Alert me when…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(q); } }} />
        <button className="btn primary" disabled={!q.trim()}>Send</button>
      </form>
    </div>
  );
}

export const ASK_CSS = `
.sl .askfab{position:fixed;right:22px;bottom:22px;z-index:50;background:linear-gradient(135deg,#29B5E8,#0b76a8);color:#fff;border:0;border-radius:24px;padding:11px 20px;
 font:inherit;font-weight:700;box-shadow:0 6px 20px rgba(15,23,42,.25);cursor:pointer}
.sl .askfab:hover{background:#075985}
.sl .askpanel{position:fixed;right:18px;bottom:18px;z-index:50;width:min(460px,calc(100vw - 36px));height:min(620px,calc(100vh - 36px));font-size:12.5px;
 background:#fff;border:1px solid var(--border2);border-radius:14px;box-shadow:0 12px 36px rgba(15,23,42,.22);display:flex;flex-direction:column}
.sl .askpanel.big{width:min(900px,calc(100vw - 36px));height:calc(100vh - 36px)}
.sl .askhead{padding:10px 12px;border-bottom:1px solid var(--border)}
.sl .askbody{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
.sl .askin{display:flex;gap:8px;padding:10px;border-top:1px solid var(--border);align-items:flex-end}
.sl .askin textarea{flex:1;resize:none}
.sl .bub{border-radius:12px;padding:7px 10px;font-size:12.5px;line-height:1.45;max-width:92%}
.sl .bub.me{align-self:flex-end;background:var(--accent);color:#fff;white-space:pre-wrap}
.sl .bub.bot{align-self:flex-start;background:var(--surface2)}
.sl .bub.err{background:var(--bad-dim);color:var(--bad)}
.sl .md p{margin:0 0 6px}.sl .md ul,.sl .md ol{margin:2px 0 6px;padding-left:20px}.sl .md li{margin:1px 0}
.sl .md code{background:rgba(11,118,168,.08);border-radius:4px;padding:0 4px;font-size:11.5px}
.sl .md .mdh{font-weight:700;margin:4px 0}
.sl .chipq{border:1px solid var(--border2);background:#fff;color:var(--accent);border-radius:14px;padding:3px 10px;font:inherit;font-size:11.5px;cursor:pointer;text-align:left}
.sl .chipq:hover{background:var(--surface2)}
`;
