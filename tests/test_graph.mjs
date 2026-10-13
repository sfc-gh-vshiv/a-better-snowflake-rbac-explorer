// Unit tests for the RBAC engine (frontend/src/graph.ts) on a small synthetic account.
// Run: node tests/test_graph.mjs   (bundles graph.ts with esbuild first)
import { buildSync } from "../frontend/node_modules/esbuild/lib/main.js";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(mkdtempSync(join(tmpdir(), "re-")), "graph.mjs");
buildSync({ entryPoints: [join(here, "../frontend/src/graph.ts")], bundle: true, format: "esm", outfile: out, platform: "neutral", logLevel: "error" });
const { RBAC, blastRadius, hygiene } = await import(out);

let failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`}`);
  if (!ok) failed++;
};

const R = ["ACCOUNTADMIN", "SYSADMIN", "SECURITYADMIN", "PUBLIC", "ANALYST", "READER", "INGEST_SVC_ROLE", "ORPHAN", "DB1.DBR"];
const nodes = R.map((n, i) => [n, i <= 3 ? "sys" : i === 8 ? "db" : "role", null, null, "2024-01-01T00:00:00"]);
const e = (c, p) => [R.indexOf(c), R.indexOf(p), null, null];
const edges = [e("SYSADMIN", "ACCOUNTADMIN"), e("SECURITYADMIN", "ACCOUNTADMIN"), e("ANALYST", "SYSADMIN"),
  e("READER", "ANALYST"), e("INGEST_SVC_ROLE", "SYSADMIN"), e("DB1.DBR", "READER")];
const user = (name, type) => ({ name, type, disabled: false, default_role: null, secondary: '["ALL"]', last_login: new Date().toISOString(),
  created: null, email: null, comment: null, owner: null, has_password: false, has_rsa: true, has_mfa: false, has_pat: false, locked: false });
const users = [user("ALICE", "PERSON"), user("BOT", "SERVICE"), user("BOB", "PERSON"), user("ADMIN", "PERSON")];
const ug = (u, r) => [users.findIndex((x) => x.name === u), R.indexOf(r), null, null];
const ugrants = [ug("ALICE", "ANALYST"), ug("BOT", "INGEST_SVC_ROLE"), ug("BOB", "INGEST_SVC_ROLE"), ug("ADMIN", "ACCOUNTADMIN")];
const otypes = ["TABLE", "WAREHOUSE", "DATABASE"];
const objs = [[0, "DB1.S.T1"], [1, "WH"], [0, "DB1.S.T2"], [2, "DB1"]];
const privs = ["SELECT", "INSERT", "USAGE", "OWNERSHIP"];
const g = (r, o, p) => [R.indexOf(r), o, privs.indexOf(p), 0];
const grants = [g("READER", 0, "SELECT"), g("INGEST_SVC_ROLE", 0, "INSERT"), g("PUBLIC", 1, "USAGE"),
  g("DB1.DBR", 2, "SELECT"), g("SYSADMIN", 3, "OWNERSHIP")].flat();
const raw = { asof: "", account: "TEST", nodes, edges, users, ugrants, otypes, privs, objs, grants };

const m = new RBAC(raw);
const names = (s) => [...s].map((i) => m.ids[i]).sort();
const unames = (a) => a.map((i) => users[i].name).sort();

eq("reach(ACCOUNTADMIN) is everything above PUBLIC/ORPHAN", names(m.reach(m.byId.get("ACCOUNTADMIN"))),
  ["ACCOUNTADMIN", "ANALYST", "DB1.DBR", "INGEST_SVC_ROLE", "READER", "SECURITYADMIN", "SYSADMIN"]);
eq("up(READER)", names(m.up(m.byId.get("READER"))), ["ACCOUNTADMIN", "ANALYST", "READER", "SYSADMIN"]);
eq("usersOf(READER) includes inheritors", unames(m.usersOf(m.byId.get("READER"))), ["ADMIN", "ALICE"]);
eq("usersOf(PUBLIC) is everyone", unames(m.usersOf(m.byId.get("PUBLIC"))), ["ADMIN", "ALICE", "BOB", "BOT"]);
eq("pathDown ACCOUNTADMIN -> DB1.DBR", m.pathDown(m.byId.get("ACCOUNTADMIN"), m.byId.get("DB1.DBR")).map((i) => m.ids[i]),
  ["ACCOUNTADMIN", "SYSADMIN", "ANALYST", "READER", "DB1.DBR"]);
eq("userPath ALICE -> READER", m.userPath(0, m.byId.get("READER")).map((i) => m.ids[i]), ["ANALYST", "READER"]);
eq("depth(DB1.DBR)", m.depth(m.byId.get("DB1.DBR")), 4);
eq("classify service role", m.kind[m.byId.get("INGEST_SVC_ROLE")], "functional");
eq("classify access role", m.kind[m.byId.get("READER")], "access");
eq("classify empty role", m.kind[m.byId.get("ORPHAN")], "empty");

const acc = m.access(0);
eq("access(T1) users", unames([...acc.users.keys()]), ["ADMIN", "ALICE", "BOB", "BOT"]);
eq("access(T1) ALICE best SELECT", acc.users.get(0).best, "SELECT");
eq("access(T1) BOT best INSERT", acc.users.get(1).best, "INSERT");
eq("access(T1) ADMIN picks highest privilege", acc.users.get(3).best, "INSERT");
eq("db-role grant reaches ALICE (T2)", unames([...m.access(2).users.keys()]), ["ADMIN", "ALICE"]);
eq("effective(ANALYST) counts inherited", m.effective(m.byId.get("ANALYST")).length, 2);

// what-if: cut READER from ANALYST -> ALICE loses T1 SELECT and T2 SELECT; ADMIN loses them too
const cut = blastRadius(raw, { edges: [3], ugrants: [], grants: [] });
eq("what-if users affected", unames(cut.users.map((x) => x.u)), ["ADMIN", "ALICE"]);
eq("what-if ALICE loses 2 privileges", cut.users.find((x) => x.u === 0).lost.length, 2);
eq("what-if no-op is empty", blastRadius(raw, { edges: [], ugrants: [], grants: [] }).users.length, 0);
// redundant path: removing BOT's direct grant only affects BOT
const rmBot = blastRadius(raw, { edges: [], ugrants: [1], grants: [] });
eq("what-if revoke BOT", unames(rmBot.users.map((x) => x.u)), ["BOT"]);

const hy = Object.fromEntries(hygiene(m).map((f) => [f.id, f]));
eq("hygiene: person in service role", hy.svcmix.items.map((x) => x.label), ["BOB → INGEST_SVC_ROLE"]);
eq("hygiene: orphan role", hy.orphan.items.map((x) => x.label), ["ORPHAN"]);
eq("hygiene: ACCOUNTADMIN holders", hy.aa.items.map((x) => x.label), ["ADMIN"]);
eq("hygiene: PUBLIC grants", hy.public.items.length, 1);

console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
