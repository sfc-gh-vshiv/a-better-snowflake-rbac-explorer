// Bridge to Python (hidden st.text_input), persistent stores and background jobs.
// Streamlit re-creates the st.html element on every rerun, so all state lives on window.
import { useEffect, useState } from "react";

type Any = any;
const W = window as Any;

// ------------------------------------------------------------ store
export type Store = {
  tab: string;
  jobs: Record<string, string>;
  nonce: number;             // bump to force a fresh model pull
  sel: string | null;        // selected role id
  user: string | null;       // selected user
  obj: number | null;        // selected object index
  focus: boolean; hops: number; showDb: boolean; showUsers: boolean; panelOpen?: boolean;
  search: string;
  removed: { edges: number[]; ugrants: number[]; grants: number[] };
  live: Record<string, Any>; // live SHOW results per role
  [k: string]: Any;
};
export const store: Store = W.__reStore || (W.__reStore = {
  tab: "graph", jobs: {}, nonce: 0, sel: null, user: null, obj: null,
  focus: false, hops: 2, showDb: false, showUsers: false, search: "",
  removed: { edges: [], ugrants: [], grants: [] }, live: {},
});
const subs: Set<() => void> = W.__reSubs || (W.__reSubs = new Set());
export function setStore(patch: Partial<Store>) { Object.assign(store, patch); subs.forEach((f) => f()); }
export function useStore(): Store {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((n) => n + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  return store;
}
export function notify() { subs.forEach((f) => f()); }

// ------------------------------------------------------------ bridge
// One request in flight (the hidden input holds a single value). An unanswered
// request is re-sent (same id; Python dedupes) because a value written mid-rerun
// can be dropped. Responses are merged client-side and acked so Python can drop
// large payloads instead of re-shipping them on every rerun.
type Req = { id: string; action: string; payload: Any };
type Qt = { inflight: (Req & { t: number; tries: number }) | null; queue: Req[]; polls: Record<string, boolean>;
  last: Record<string, Any>; ack: string[]; timer?: number; backoff?: Record<string, number> };
const Q: Qt = W.__reQ || (W.__reQ = { inflight: null, queue: [], polls: {}, last: {}, ack: [] });
Q.backoff = Q.backoff || {};
const RETRY_MS = 6000, MAX_TRIES = 5;

export function send(action: string, payload: Any = {}): string {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  if (Q.inflight) Q.queue.push({ id, action, payload });
  else rawSend({ id, action, payload });
  return id;
}
export function flushQueue(responses: Any) {
  for (const [k, v] of Object.entries(responses || {})) {
    if (!Q.last[k]) { Q.last[k] = v; Q.ack.push(k); }
  }
  const keys = Object.keys(Q.last);
  if (keys.length > 400) for (const k of keys.slice(0, keys.length - 400)) delete Q.last[k];
  if (Q.inflight && Q.last[Q.inflight.id]) Q.inflight = null;
  if (!Q.inflight && Q.queue.length) { const n = Q.queue.shift()!; setTimeout(() => rawSend(n), 30); }
}
function watchdog() {
  const f = Q.inflight;
  if (!f) { if (Q.ack.length > 20) send("ack"); return; }
  if (Q.last[f.id] || Date.now() - f.t < RETRY_MS) return;
  if (f.tries >= MAX_TRIES) {
    Q.last[f.id] = { ok: false, error: "No response from the app, please retry." };
    Q.inflight = null; flushQueue({}); notify();
    return;
  }
  f.tries++; f.t = Date.now(); write(f);
}
function rawSend(r: Req) {
  Q.inflight = { ...r, t: Date.now(), tries: 1 };
  if (!Q.timer) Q.timer = W.setInterval(watchdog, 1000);
  write(Q.inflight);
}
function write(r: Req & { tries?: number }) {
  const input = document.querySelector(".st-key-sl_bridge input") as HTMLInputElement | null;
  if (!input) return;
  const ack = Q.ack.splice(0, 100);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  const active = document.activeElement as HTMLElement | null;
  input.focus({ preventScroll: true });
  setter.call(input, JSON.stringify({ id: r.id, action: r.action, payload: r.payload, try: r.tries || 1, ack }));
  input.dispatchEvent(new Event("input", { bubbles: true }));
  for (const t of ["keydown", "keypress", "keyup"])
    input.dispatchEvent(new KeyboardEvent(t, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  input.blur();
  active?.focus?.({ preventScroll: true });   // without preventScroll the page jumps to the focused element
}
export function response(id: string | undefined): Any { return id ? Q.last[id] : undefined; }

// ------------------------------------------------------------ jobs
export type Job<T = Any> = { loading: boolean; result: T | null; error: string | null; elapsed?: number };
/** Start once per key; poll pending results. Call only in the component that shows it.
 *  Each poll is a Streamlit rerun, so the interval backs off (1.5s, 2.5s, ... up to 5s) to keep long jobs quiet. */
export function job<T = Any>(key: string, start: () => string, poll = 1500): Job<T> {
  const map = store.jobs;
  if (!map[key]) map[key] = start();
  const id = map[key];
  const r = Q.last[id];
  if (!r) return { loading: true, result: null, error: null };
  if (!r.ok) return { loading: false, result: null, error: r.error };
  if (r.result && r.result.pending) {
    if (!Q.polls[id]) {
      Q.polls[id] = true;
      const n = (Q.backoff![key] = (Q.backoff![key] || 0) + 1);
      setTimeout(() => { if (map[key] === id) { map[key] = send("poll", { token: r.result.token }); notify(); } },
        Math.min(5000, poll + 1000 * (n - 1)));
    }
    return { loading: true, result: null, error: null, elapsed: r.result.elapsed };
  }
  return { loading: false, result: r.result, error: null };
}
export function resetJob(key: string) { delete store.jobs[key]; notify(); }

/** Fire-and-track request for mutations (save, delete, test). */
export function useAction() {
  const [id, setId] = useState<string | null>(null);
  useStore();
  const r = id ? Q.last[id] : null;
  return {
    run: (action: string, payload: Any) => setId(send(action, payload)),
    busy: !!id && !r, ok: r ? r.ok : null, result: r?.result, error: r && !r.ok ? r.error : null,
    reset: () => setId(null),
  };
}
