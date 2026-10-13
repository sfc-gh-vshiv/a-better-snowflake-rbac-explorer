// RBAC engine: the role DAG, transitive closure, paths, effective privileges and
// what-if diffs. Pure (no DOM) so tests/test_graph.mjs can exercise it in Node.

export type RawModel = {
  asof: string; account: string;
  nodes: [string, string, string | null, string | null, string | null][];   // id, kind, owner, comment, created
  edges: [number, number, string | null, string | null][];                  // child, parent, created, granted_by
  users: User[];
  ugrants: [number, number, string | null, string | null][];                // user, role, created, granted_by
  otypes: string[]; privs: string[];
  objs: [number, string][];                                                  // type idx, fqn
  grants: number[];                                                          // flat [role, obj, priv, grant_option] * n
};
export type User = {
  name: string; type: string | null; disabled: boolean; default_role: string | null; secondary: string | null;
  last_login: string | null; created: string | null; email: string | null; comment: string | null; owner: string | null;
  has_password: boolean; has_rsa: boolean; has_mfa: boolean; has_pat: boolean; locked: boolean;
};
export type Removed = { edges: number[]; ugrants: number[]; grants: number[] };
export type Kind = "sys" | "service" | "functional" | "access" | "empty" | "db" | "app";

export const PRIV_RANK: Record<string, number> = {
  OWNERSHIP: 5, "ALL PRIVILEGES": 4, INSERT: 3, UPDATE: 3, DELETE: 3, TRUNCATE: 3, "CREATE TABLE": 3,
  "CREATE SCHEMA": 3, MODIFY: 3, OPERATE: 2, MONITOR: 1, SELECT: 2, READ: 2, WRITE: 3, USAGE: 1, REFERENCES: 1,
};
export const rankOf = (p: string) => PRIV_RANK[p] ?? (p.startsWith("CREATE") ? 3 : 1);

export class RBAC {
  raw: RawModel;
  n: number;
  ids: string[];
  byId = new Map<string, number>();
  kind: Kind[] = [];
  inherits: number[][] = [];   // role -> roles granted to it (it can use them)
  heldBy: number[][] = [];     // role -> roles it is granted to
  inhEdge: number[][] = [];    // role -> edge indices (as parent)
  heldEdge: number[][] = [];   // role -> edge indices (as child)
  userRoles: number[][] = [];  // user -> role indices (direct)
  roleUsers: number[][] = [];  // role -> user indices (direct)
  roleUserGrant: number[][] = [];
  grantsByRole: number[][] = [];
  grantsByObj: number[][] = [];
  nGrants: number;
  publicIdx: number;
  private reachCache = new Map<number, Set<number>>();
  private upCache = new Map<number, Set<number>>();

  constructor(raw: RawModel, removed: Removed = { edges: [], ugrants: [], grants: [] }) {
    this.raw = raw;
    this.n = raw.nodes.length;
    this.ids = raw.nodes.map((x) => x[0]);
    this.ids.forEach((id, i) => this.byId.set(id, i));
    for (let i = 0; i < this.n; i++) {
      this.inherits.push([]); this.heldBy.push([]); this.inhEdge.push([]); this.heldEdge.push([]);
      this.roleUsers.push([]); this.roleUserGrant.push([]); this.grantsByRole.push([]);
    }
    const rmE = new Set(removed.edges), rmU = new Set(removed.ugrants), rmG = new Set(removed.grants);
    raw.edges.forEach(([c, p], i) => {
      if (rmE.has(i) || c === p) return;
      this.inherits[p].push(c); this.heldBy[c].push(p); this.inhEdge[p].push(i); this.heldEdge[c].push(i);
    });
    this.userRoles = raw.users.map(() => []);
    raw.ugrants.forEach(([u, r], i) => {
      if (rmU.has(i)) return;
      this.userRoles[u].push(r); this.roleUsers[r].push(u); this.roleUserGrant[r].push(i);
    });
    this.nGrants = raw.grants.length / 4;
    this.grantsByObj = raw.objs.map(() => []);
    for (let g = 0; g < this.nGrants; g++) {
      if (rmG.has(g)) continue;
      this.grantsByRole[raw.grants[g * 4]].push(g);
      this.grantsByObj[raw.grants[g * 4 + 1]].push(g);
    }
    this.publicIdx = this.byId.get("PUBLIC") ?? -1;
    this.kind = raw.nodes.map((nd, i) => this.classify(i, nd[1]));
  }

  private classify(i: number, k: string): Kind {
    if (k === "sys") return "sys";
    if (k === "db") return "db";
    if (k === "app") return "app";
    const us = this.roleUsers[i];
    if (us.length && us.every((u) => (this.raw.users[u].type || "").includes("SERVICE"))) return "service";
    if (us.length) return "functional";
    if (this.grantsByRole[i].length || this.inherits[i].length) return "access";
    return "empty";
  }

  // grant accessors
  gRole(g: number) { return this.raw.grants[g * 4]; }
  gObj(g: number) { return this.raw.grants[g * 4 + 1]; }
  gPriv(g: number) { return this.raw.privs[this.raw.grants[g * 4 + 2]]; }
  gOpt(g: number) { return this.raw.grants[g * 4 + 3] === 1; }
  objName(o: number) { return this.raw.objs[o][1]; }
  objType(o: number) { return this.raw.otypes[this.raw.objs[o][0]]; }

  /** Every role r can use: itself plus everything granted to it, transitively. */
  reach(r: number): Set<number> {
    let s = this.reachCache.get(r);
    if (s) return s;
    s = new Set([r]);
    const st = [r];
    while (st.length) for (const c of this.inherits[st.pop()!]) if (!s.has(c)) { s.add(c); st.push(c); }
    this.reachCache.set(r, s);
    return s;
  }
  /** Every role that can use r (r plus its ancestors). */
  up(r: number): Set<number> {
    let s = this.upCache.get(r);
    if (s) return s;
    s = new Set([r]);
    const st = [r];
    while (st.length) for (const p of this.heldBy[st.pop()!]) if (!s.has(p)) { s.add(p); st.push(p); }
    this.upCache.set(r, s);
    return s;
  }
  /** Roles a user can activate (direct grants, plus PUBLIC) and everything they inherit. */
  userReach(u: number): Set<number> {
    const s = new Set<number>();
    const roots = [...this.userRoles[u]];
    if (this.publicIdx >= 0) roots.push(this.publicIdx);
    for (const r of roots) for (const x of this.reach(r)) s.add(x);
    return s;
  }
  /** Users who can use role r (directly or by inheritance). PUBLIC: everyone. */
  usersOf(r: number): number[] {
    if (r === this.publicIdx) return this.raw.users.map((_, i) => i);
    const out = new Set<number>();
    for (const a of this.up(r)) for (const u of this.roleUsers[a]) out.add(u);
    return [...out];
  }
  depth(r: number): number {   // longest chain of roles above r
    const memo = new Map<number, number>();
    const go = (x: number, seen: Set<number>): number => {
      if (memo.has(x)) return memo.get(x)!;
      let d = 0;
      for (const p of this.heldBy[x]) if (!seen.has(p)) { seen.add(p); d = Math.max(d, 1 + go(p, seen)); seen.delete(p); }
      memo.set(x, d);
      return d;
    };
    return go(r, new Set([r]));
  }

  /** Shortest chain from `from` down to `to` (from inherits to), as role indices, or null. */
  pathDown(from: number, to: number): number[] | null {
    if (from === to) return [from];
    const prev = new Map<number, number>([[from, -1]]);
    const q = [from];
    while (q.length) {
      const x = q.shift()!;
      for (const c of this.inherits[x]) if (!prev.has(c)) {
        prev.set(c, x);
        if (c === to) { const p = [c]; let y = x; while (y !== -1) { p.push(y); y = prev.get(y)!; } return p.reverse(); }
        q.push(c);
      }
    }
    return null;
  }
  /** Every distinct chain from r up to a top role (no parents), capped. */
  pathsUp(r: number, cap = 12): number[][] {
    const out: number[][] = [];
    const go = (x: number, path: number[]) => {
      if (out.length >= cap) return;
      const ps = this.heldBy[x].filter((p) => !path.includes(p));
      if (!ps.length) { out.push([...path].reverse()); return; }
      for (const p of ps) go(p, [...path, p]);
    };
    go(r, [r]);
    return out.sort((a, b) => a.length - b.length);
  }
  /** User -> role chain (user's granted role first). */
  userPath(u: number, r: number): number[] | null {
    let best: number[] | null = null;
    const roots = [...this.userRoles[u], ...(this.publicIdx >= 0 ? [this.publicIdx] : [])];
    for (const g of roots) {
      const p = this.pathDown(g, r);
      if (p && (!best || p.length < best.length)) best = p;
    }
    return best;
  }

  /** Effective privileges of a role: [grant, via role] for every grant in its closure. */
  effective(r: number): { g: number; via: number }[] {
    const out: { g: number; via: number }[] = [];
    for (const x of this.reach(r)) for (const g of this.grantsByRole[x]) out.push({ g, via: x });
    return out;
  }
  /** Who can reach an object: roles holding a privilege on it and every role/user above them. */
  access(o: number) {
    const roles = new Map<number, { best: string; privs: Set<string>; via: number }>();
    for (const g of this.grantsByObj[o]) {
      const holder = this.gRole(g), priv = this.gPriv(g);
      for (const a of this.up(holder)) {
        const cur = roles.get(a) || { best: priv, privs: new Set<string>(), via: holder };
        cur.privs.add(priv);
        if (rankOf(priv) > rankOf(cur.best)) { cur.best = priv; cur.via = holder; }
        roles.set(a, cur);
      }
    }
    const users = new Map<number, { best: string; via: number; privs: Set<string> }>();
    for (const [r, v] of roles) {
      const us = r === this.publicIdx ? this.raw.users.map((_, i) => i) : this.roleUsers[r];
      for (const u of us) {
        const cur = users.get(u);
        if (!cur || rankOf(v.best) > rankOf(cur.best)) users.set(u, { best: v.best, via: r, privs: new Set(v.privs) });
        else v.privs.forEach((p) => cur.privs.add(p));
      }
    }
    return { roles, users };
  }
  /** Object/privilege keys a user can exercise. */
  userKeys(u: number): Set<number> {
    const s = new Set<number>();
    for (const r of this.userReach(u)) for (const g of this.grantsByRole[r]) s.add(this.gObj(g) * 1024 + this.raw.grants[g * 4 + 2]);
    return s;
  }
}

/** What-if: what each user and role loses if the removed grants/edges were revoked. */
export function blastRadius(raw: RawModel, removed: Removed) {
  const before = new RBAC(raw), after = new RBAC(raw, removed);
  const users: { u: number; lost: number[]; lostRoles: number[] }[] = [];
  raw.users.forEach((_, u) => {
    const a = after.userKeys(u), lost: number[] = [];
    for (const k of before.userKeys(u)) if (!a.has(k)) lost.push(k);
    const ar = after.userReach(u), lostRoles = [...before.userReach(u)].filter((r) => !ar.has(r));
    if (lost.length || lostRoles.length) users.push({ u, lost, lostRoles });
  });
  const roles: { r: number; lostRoles: number[]; lostGrants: number }[] = [];
  for (let r = 0; r < before.n; r++) {
    const ar = after.reach(r);
    const lostRoles = [...before.reach(r)].filter((x) => !ar.has(x));
    const lostGrants = after.effective(r).length < before.effective(r).length
      ? before.effective(r).length - after.effective(r).length : 0;
    if (lostRoles.length || lostGrants) roles.push({ r, lostRoles, lostGrants });
  }
  return { users, roles, key: (k: number) => ({ obj: Math.floor(k / 1024), priv: raw.privs[k % 1024] }) };
}

export type Finding = { id: string; title: string; why: string; sev: "high" | "med" | "low"; items: { label: string; role?: number; user?: number; detail?: string }[] };

/** Hygiene findings over the whole model. */
export function hygiene(m: RBAC): Finding[] {
  const users = m.raw.users;
  const out: Finding[] = [];
  const idx = (n: string) => m.byId.get(n) ?? -1;
  const aa = idx("ACCOUNTADMIN"), sa = idx("SYSADMIN");
  const accountRoles = m.ids.map((_, i) => i).filter((i) => ["sys", "service", "functional", "access", "empty"].includes(m.kind[i]));

  if (aa >= 0) {
    const holders = m.usersOf(aa).filter((u) => !users[u].disabled);
    out.push({ id: "aa", sev: holders.length > 3 ? "high" : "med", title: "Users who can use ACCOUNTADMIN",
      why: "Snowflake recommends at least two and as few as possible, each with MFA. ACCOUNTADMIN should not be a default role.",
      items: holders.map((u) => ({ label: users[u].name, user: u,
        detail: [users[u].type || "PERSON", users[u].has_mfa ? "MFA" : "no MFA", users[u].default_role === "ACCOUNTADMIN" ? "default role" : ""].filter(Boolean).join(" · ") })) });
    const above = [...m.up(aa)].filter((r) => r !== aa);
    out.push({ id: "aaroles", sev: above.length ? "high" : "low", title: "Roles that inherit ACCOUNTADMIN",
      why: "ACCOUNTADMIN should sit at the top of the hierarchy. Granting it to another role hands full account control to everyone who holds that role.",
      items: above.map((r) => ({ label: m.ids[r], role: r, detail: `${m.usersOf(r).length} users` })) });
  }
  if (m.publicIdx >= 0) {
    const g = m.grantsByRole[m.publicIdx];
    out.push({ id: "public", sev: g.length > 20 ? "high" : g.length ? "med" : "low", title: "Privileges granted to PUBLIC",
      why: "Every user and role has PUBLIC, so these privileges are effectively granted to everyone.",
      items: g.slice(0, 400).map((x) => ({ label: `${m.gPriv(x)} on ${m.objType(m.gObj(x)).toLowerCase()} ${m.objName(m.gObj(x))}`, role: m.publicIdx })) });
  }
  if (sa >= 0 && aa >= 0) {
    const under = m.reach(sa);
    const orphans = accountRoles.filter((r) => m.kind[r] !== "sys" && !under.has(r) && !m.reach(idx("SECURITYADMIN")).has(r));
    out.push({ id: "orphan", sev: orphans.length > 10 ? "med" : "low", title: "Custom roles not rolled up to SYSADMIN",
      why: "Objects owned by these roles are invisible to SYSADMIN, so system administrators cannot manage them. Grant each top custom role to SYSADMIN.",
      items: orphans.map((r) => ({ label: m.ids[r], role: r, detail: m.heldBy[r].length ? "under " + m.heldBy[r].map((p) => m.ids[p]).join(", ") : "no parent role" })) });
  }
  const unused = accountRoles.filter((r) => m.kind[r] === "empty" && !m.heldBy[r].length);
  out.push({ id: "unused", sev: "low", title: "Empty roles", why: "No users, no privileges, no child roles and no parents. Usually safe to drop.",
    items: unused.map((r) => ({ label: m.ids[r], role: r, detail: m.raw.nodes[r][4]?.slice(0, 10) || "" })) });
  const noUsers = accountRoles.filter((r) => m.kind[r] === "access" && !m.usersOf(r).length);
  out.push({ id: "nousers", sev: "low", title: "Roles nobody can use", why: "These roles hold privileges but no user can reach them, directly or through another role.",
    items: noUsers.map((r) => ({ label: m.ids[r], role: r, detail: `${m.grantsByRole[r].length} privileges` })) });
  const deep = accountRoles.map((r) => [r, m.depth(r)] as const).filter(([, d]) => d >= 5);
  out.push({ id: "deep", sev: "low", title: "Deep inheritance chains (5+ levels)", why: "Long chains make it hard to reason about who can do what.",
    items: deep.map(([r, d]) => ({ label: m.ids[r], role: r, detail: `${d} levels` })) });
  const stale = users.map((u, i) => [u, i] as const).filter(([u, i]) => {
    if (!m.userRoles[i].length) return false;
    if (u.disabled) return true;
    return !u.last_login || (Date.now() - Date.parse(u.last_login)) / 864e5 > 90;
  });
  out.push({ id: "stale", sev: stale.length ? "med" : "low", title: "Disabled or idle users still holding roles",
    why: "No login for 90+ days, or disabled, but roles are still granted. Revoke or drop.",
    items: stale.map(([u, i]) => ({ label: u.name, user: i, detail: (u.disabled ? "disabled · " : "") + (u.last_login ? "last login " + u.last_login.slice(0, 10) : "never logged in") + ` · ${m.userRoles[i].length} roles` })) });
  const svcRoles = accountRoles.filter((r) => /(SVC|SERVICE|_SA$|PIPELINE|INGEST|ETL)/i.test(m.ids[r]));
  const mixed: Finding["items"] = [];
  for (const r of svcRoles) for (const u of m.roleUsers[r]) if (!(users[u].type || "").includes("SERVICE"))
    mixed.push({ label: `${users[u].name} → ${m.ids[r]}`, role: r, user: u, detail: `${users[u].type || "PERSON"} user in a service-style role` });
  out.push({ id: "svcmix", sev: mixed.length ? "high" : "low", title: "People in service-style roles",
    why: "Roles named like service roles should only be held by SERVICE users. Protect them with an alert rule.", items: mixed });
  const pwd = users.map((u, i) => [u, i] as const).filter(([u]) => !u.disabled && u.has_password && !u.has_mfa && (u.type || "PERSON") === "PERSON");
  out.push({ id: "mfa", sev: pwd.length ? "med" : "low", title: "Password users without MFA",
    why: "Single-factor password sign-in is being phased out. Enroll MFA or move to key-pair / SSO.",
    items: pwd.map(([u, i]) => ({ label: u.name, user: i })) });
  const own = accountRoles.map((r) => [r, m.grantsByRole[r].filter((g) => m.gPriv(g) === "OWNERSHIP").length] as const)
    .filter(([, n]) => n >= 50).sort((a, b) => b[1] - a[1]);
  out.push({ id: "own", sev: "low", title: "Ownership concentration", why: "Roles owning many objects are high-impact if misused or dropped.",
    items: own.map(([r, n]) => ({ label: m.ids[r], role: r, detail: `owns ${n} objects` })) });
  return out;
}
