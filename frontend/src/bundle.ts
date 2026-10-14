// Access bundles: can a principal use everything an AI asset needs? Pure (no DOM) so
// tests/test_bundle.mjs can run it in Node. Bundles come from modules/asset_kinds.py; each item
// carries live grantees (SHOW GRANTS ON) because ACCOUNT_USAGE has no semantic view or agent grants.
import { RBAC } from "./graph";

export type Item = {
  key: string; otype: string; fqn: string; priv: string; via: string; source: string[];
  root?: boolean; suggested?: boolean; on?: boolean; live?: [string, string][] | null; alt?: string[];
  note?: string; sig?: string; error?: string; uses?: number;
};
export type TreeNode = {
  kind: string; fqn: string; items: Item[]; children: TreeNode[]; warnings: string[];
  rights?: string | null; tool?: string; source?: string; suggested?: boolean; base_tables?: string[]; sig?: string;
};
export type Bundle = {
  id?: string; kind: string; fqn: string; items: Item[]; tree: TreeNode; hash: string; ar?: string;
  needs_default_wh?: boolean; source?: any;
};
/** Live view of one user (modules/access.py principal): roles walked with SHOW, no ACCOUNT_USAGE lag. */
export type Live = {
  user: string; roots: string[]; edges: [string, string][]; truncated: boolean;
  default_role: string | null; default_warehouse: string | null; secondary: string | null; type?: string;
  pats: { name?: string; role?: string | null; expires?: string; status?: string; error?: string }[];
};
/** A set of roles something runs with, and the warehouse it would use. */
export type Principal = { label: string; roles: Set<string>; defaultWh?: string | null; why?: string };
export type Row = { item: Item; ok: boolean; via?: string; reason?: string };
export type Status = "ready" | "partial" | "blocked";

const ADMIN_PRIVS = new Set(["OWNERSHIP", "ALL PRIVILEGES"]);
export const satisfies = (have: string, need: string) => have === need || ADMIN_PRIVS.has(have);
export const required = (i: Item) => i.on !== false && !(i.suggested && !i.on);

// ------------------------------------------------------------------ principals
function closure(start: string[], kids: (r: string) => string[]): Set<string> {
  const s = new Set<string>(), st = [...start];
  while (st.length) { const r = st.pop()!; if (s.has(r)) continue; s.add(r); for (const c of kids(r)) st.push(c); }
  return s;
}
function modelReach(m: RBAC, names: string[]): Set<string> {
  const out = new Set<string>();
  for (const n of names) { const i = m.byId.get(n); if (i !== undefined) for (const x of m.reach(i)) out.add(m.ids[x]); }
  return out;
}

/** From the loaded model. mode: all = every role the user holds; default = default role only (how agents run). */
export function fromModel(m: RBAC, u: number, mode: "all" | "default"): Principal {
  const x = m.raw.users[u];
  if (mode === "all") return { label: `${x.name}, all roles`, roles: new Set([...m.userReach(u)].map((r) => m.ids[r])), defaultWh: x.default_warehouse };
  const held = m.userRoles[u].map((r) => m.ids[r]);
  const dr = x.default_role && held.includes(x.default_role) ? [x.default_role] : [];
  return { label: `${x.name}, default role ${x.default_role || "(none)"}`, roles: modelReach(m, [...dr, "PUBLIC"]), defaultWh: x.default_warehouse,
    why: x.default_role && !dr.length ? `default role ${x.default_role} isn't granted to the user` : undefined };
}
export function fromRole(m: RBAC, role: string): Principal {
  return { label: `role ${role}`, roles: modelReach(m, [role, "PUBLIC"]) };
}
/** From a live walk. role = a PAT's role restriction (or any one role the user holds). */
export function fromLive(lv: Live, mode: "all" | "default" | "role", role?: string | null): Principal {
  const kids = new Map<string, string[]>();
  for (const [c, p] of lv.edges) kids.set(p, [...(kids.get(p) || []), c]);
  const k = (r: string) => kids.get(r) || [];
  if (mode === "all") return { label: `${lv.user}, all roles (live)`, roles: closure([...lv.roots, "PUBLIC"], k), defaultWh: lv.default_warehouse };
  const r = mode === "default" ? lv.default_role : role;
  const held = !!r && lv.roots.includes(r);
  return { label: mode === "default" ? `${lv.user}, default role ${r || "(none)"} (live)` : `${lv.user} as ${r} (live)`,
    roles: closure([...(held ? [r!] : []), "PUBLIC"], k), defaultWh: lv.default_warehouse,
    why: r && !held ? `${r} isn't granted to ${lv.user}` : !r ? "no role set" : undefined };
}

// ------------------------------------------------------------------ holders and gaps
const baseName = (s: string) => s.split("(")[0].toUpperCase();
const objIndex = new WeakMap<RBAC, Map<string, number[]>>();
function objsOf(m: RBAC, otype: string, fqn: string): number[] {
  let ix = objIndex.get(m);
  if (!ix) {
    ix = new Map();
    m.raw.objs.forEach((o, i) => { const k = m.raw.otypes[o[0]] + "|" + baseName(String(o[1] ?? "")); ix!.set(k, [...(ix!.get(k) || []), i]); });
    objIndex.set(m, ix);
  }
  return ix.get(otype + "|" + baseName(fqn)) || [];
}
/** Roles holding the item's privilege, with the privilege each holds. Live grants win over ACCOUNT_USAGE. */
export function holders(m: RBAC, i: Item): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (r: string, p: string) => out.set(r, [...(out.get(r) || []), p]);
  if (i.live) { for (const [r, p] of i.live) add(r, p); return out; }
  for (const o of objsOf(m, i.otype, i.fqn)) for (const g of m.grantsByObj[o]) add(m.ids[m.gRole(g)], m.gPriv(g));
  return out;
}
export function check(m: RBAC, i: Item, p: Principal): Row {
  let lower: string | undefined;
  for (const [r, ps] of holders(m, i)) {
    if (!p.roles.has(r)) continue;
    if (ps.some((x) => satisfies(x, i.priv))) return { item: i, ok: true, via: r };
    lower = lower || `${ps.join(", ")} through ${r}`;
  }
  if (i.live === null && i.error) return { item: i, ok: false, reason: `couldn't read grants: ${i.error}` };
  return { item: i, ok: false, reason: lower ? `only ${lower}, needs ${i.priv}` : `no role in this set has ${i.priv}` };
}

export function gap(m: RBAC, b: Bundle, p: Principal) {
  const rows = b.items.filter(required).map((i) => check(m, i, p));
  if (b.needs_default_wh && p.defaultWh !== undefined) {
    const wh: Item = { key: "DEFAULT_WAREHOUSE", otype: "WAREHOUSE", fqn: p.defaultWh || "(none)", priv: "USAGE", via: b.fqn, source: ["spec"],
      note: "agents run on the caller's default warehouse" };
    rows.push(p.defaultWh ? { ...check(m, { ...wh, live: b.items.find((x) => x.otype === "WAREHOUSE" && x.fqn === p.defaultWh)?.live }, p), item: wh }
      : { item: wh, ok: false, reason: "no default warehouse set; agent calls fail without one" });
  }
  const root = rows.find((r) => r.item.root);
  const missing = rows.filter((r) => !r.ok);
  const status: Status = !missing.length ? "ready" : root && !root.ok ? "blocked" : "partial";
  return { rows, missing, status, principal: p };
}

/** Everyone who holds a role (directly or through others), checked the way the asset will run for them. */
export function team(m: RBAC, b: Bundle, role: string) {
  const r = m.byId.get(role);
  if (r === undefined) return [];
  const mode = b.kind === "agent" || b.needs_default_wh ? "default" : "all";
  return m.usersOf(r).filter((u) => !m.raw.users[u].disabled).map((u) => ({ u, ...gap(m, b, fromModel(m, u, mode)) }))
    .sort((a, b2) => (a.status === b2.status ? 0 : a.status === "blocked" ? -1 : b2.status === "blocked" ? 1 : a.status === "partial" ? -1 : 1));
}

/** Plain-language summary for the Ask panel. */
export function describeBundle(b: Bundle): string {
  const req = b.items.filter(required);
  return `${b.kind} ${b.fqn} needs ${req.length} grants: ` + req.slice(0, 30).map((i) => `${i.priv} on ${i.otype.toLowerCase()} ${i.fqn}`).join("; ");
}
