// Role Explorer shell. Built to ../ui/sl_ui.js and injected by react_bridge.load_bundle().
import React, { useEffect } from "react";
import { createRoot, Root } from "react-dom/client";
import { flushQueue, notify, setStore, store, useStore } from "./kit";
import { CSS } from "./theme";
import { ErrorBox, Loading, ago, fmt, useModel } from "./ui";
import { Hierarchy } from "./tabs/Hierarchy";
import { RoleTab } from "./tabs/Role";
import { AccessTab, UserTab } from "./tabs/User";
import { HygieneTab, WhatIfTab } from "./tabs/Insights";
import { AlertsTab, useOpenAlerts } from "./tabs/Alerts";
import { AssetsTab } from "./tabs/Assets";
import { ASK_CSS, AskPanel } from "./ask";

type Any = any;
const W = window as Any;
export const VERSION = "role-explorer-2.0.0";
const ALL_CSS = CSS + ASK_CSS;

const TABS = [
  { id: "graph", label: "Hierarchy" },
  { id: "assets", label: "AI assets" },
  { id: "role", label: "Role 360" },
  { id: "access", label: "Who can access?" },
  { id: "user", label: "Users" },
  { id: "hygiene", label: "Hygiene" },
  { id: "whatif", label: "Revoke what-if" },
  { id: "alerts", label: "Alerts" },
];

function App(p: Any) {
  const s = useStore();
  const { m, loading, error, elapsed } = useModel();
  const open = useOpenAlerts();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) {
        e.preventDefault();
        if (store.tab !== "graph") setStore({ tab: "graph" });
        setTimeout(() => (document.querySelector(".sl .gtools input") as HTMLInputElement | null)?.focus(), 30);
      }
    };
    if (!W.__reKeys) { W.__reKeys = true; window.addEventListener("keydown", onKey); }
  }, []);
  return (
    <div className="shell">
      <div className="top">
        <div className="brand">
          <div className="logo">
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="5" r="3" fill="#fff" /><circle cx="5" cy="18" r="3" fill="#fff" /><circle cx="19" cy="18" r="3" fill="#fff" />
              <path d="M12 8v4M12 12L6 16M12 12l6 4" stroke="#fff" strokeWidth="1.8" fill="none" /></svg>
          </div>
          <div><h1>Role Explorer</h1><div className="sub">{p.account}</div></div>
        </div>
        <div className="nav">
          {TABS.map((t) => (
            <button key={t.id} className={s.tab === t.id ? "on" : ""} onClick={() => setStore({ tab: t.id })}>
              {t.label}{t.id === "alerts" && open > 0 && <span className="cnt">{open}</span>}
            </button>
          ))}
        </div>
        <span className="grow" />
        <div className="fresh">
          {m && <><span className="dot" style={loading ? { background: "#F59E0B" } : undefined} />
            <span title="Role edges, user grants and privileges come from SNOWFLAKE.ACCOUNT_USAGE, which can be up to 2 hours behind.">
              {fmt(m.n)} roles · {fmt(m.raw.users.length)} users · {fmt(m.nGrants)} grants · loaded {ago(m.raw.asof)}</span></>}
          <button className="btn sm" disabled={loading} onClick={() => setStore({ nonce: s.nonce + 1 })}>{loading ? `Refreshing${elapsed ? " " + elapsed + "s" : ""}…` : "Refresh"}</button>
        </div>
      </div>
      {error && !m && <ErrorBox msg={error} />}
      {!m && !error && <Loading elapsed={elapsed} />}
      {m && (
        <div>
          {s.tab === "graph" && <Hierarchy m={m} />}
          {s.tab === "assets" && <AssetsTab m={m} />}
          {s.tab === "role" && <RoleTab m={m} />}
          {s.tab === "access" && <AccessTab m={m} />}
          {s.tab === "user" && <UserTab m={m} />}
          {s.tab === "hygiene" && <HygieneTab m={m} />}
          {s.tab === "whatif" && <WhatIfTab m={m} />}
          {s.tab === "alerts" && <AlertsTab m={m} />}
          <AskPanel m={m} />
        </div>
      )}
    </div>
  );
}

const ISLANDS: Record<string, (p: Any) => JSX.Element> = { App };

function injectCss() {
  let s = document.getElementById("re-css") as HTMLStyleElement | null;
  if (!s) { s = document.createElement("style"); s.id = "re-css"; document.head.appendChild(s); }
  if (s.textContent !== ALL_CSS) s.textContent = ALL_CSS;     // updates after a redeploy
}

// Keyed islands live in one persistent host moved into each rerun's slot, so React
// updates in place (no remount flash, no scroll jump). The slot keeps the last height.
type Host = HTMLElement & { __root?: Root };
const HOSTS: Record<string, Host> = (W.__reHosts = W.__reHosts || {});
// A redeployed bundle brings its own React: unmount roots created by the previous
// bundle (with its React) and drop its subscribers before rendering again.
const BUNDLE_ID = Math.random().toString(36).slice(2);
function adoptHosts() {
  if (W.__reBundleId === BUNDLE_ID) return;
  for (const h of Object.values(HOSTS)) { try { h.__root?.unmount(); } catch { /* old bundle */ } h.__root = undefined; }
  (W.__reSubs as Set<unknown> | undefined)?.clear();
  W.__reBundleId = BUNDLE_ID;
}

function mount(slot: Host, name: string, props: Any) {
  adoptHosts();
  injectCss();
  const C = ISLANDS[name];
  if (!C) { slot.textContent = "Unknown island " + name; return; }
  let el: Host = slot;
  const key = slot.dataset.key;
  if (key) {
    el = HOSTS[key];
    if (!el) {
      el = HOSTS[key] = document.createElement("div") as Host;
      el.className = "sl";
      new ResizeObserver(() => {
        if (el.offsetHeight) document.documentElement.style.setProperty(`--sl-h-${key}`, el.offsetHeight + "px");
      }).observe(el);
    }
    if (el.parentElement !== slot) slot.appendChild(el);
  }
  flushQueue(props?.responses);
  el.__root = el.__root || createRoot(el);
  el.__root.render(<C {...props} />);
  notify();
}
W.SnowUI = { mount, version: VERSION };
export {};
