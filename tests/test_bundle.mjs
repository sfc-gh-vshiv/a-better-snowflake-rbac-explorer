// Unit tests for access-bundle gaps (frontend/src/bundle.ts) on a small synthetic account.
// Run: node tests/test_bundle.mjs
import { buildSync } from "../frontend/node_modules/esbuild/lib/main.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "rb-"));
for (const f of ["graph", "bundle"]) buildSync({ entryPoints: [join(here, `../frontend/src/${f}.ts`)], bundle: true, format: "esm",
  outfile: join(dir, `${f}.mjs`), platform: "neutral", logLevel: "error" });
const { RBAC } = await import(join(dir, "graph.mjs"));
const B = await import(join(dir, "bundle.mjs"));

let failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`}`);
  if (!ok) failed++;
};

// Roles: AUTHOR has everything; TEAM has the agent and SV only; PUBLIC has the Cortex role.
const R = ["ACCOUNTADMIN", "SYSADMIN", "PUBLIC", "AUTHOR", "TEAM", "SNOWFLAKE.CORTEX_USER"];
const nodes = R.map((n, i) => [n, i <= 2 ? "sys" : i === 5 ? "db" : "role", null, null, null]);
const e = (c, p) => [R.indexOf(c), R.indexOf(p), null, null];
const edges = [e("SYSADMIN", "ACCOUNTADMIN"), e("AUTHOR", "SYSADMIN"), e("TEAM", "SYSADMIN"), e("SNOWFLAKE.CORTEX_USER", "PUBLIC")];
const user = (name, dr, wh) => ({ name, type: "PERSON", disabled: false, default_role: dr, default_warehouse: wh, secondary: '["ALL"]',
  last_login: null, created: null, email: null, comment: null, owner: null, has_password: false, has_rsa: true, has_mfa: false, has_pat: false, locked: false });
const users = [user("ANA", "AUTHOR", "WH"), user("TOM", "TEAM", null), user("SAM", "PUBLIC", "WH")];
const ugrants = [[0, R.indexOf("AUTHOR"), null, null], [1, R.indexOf("TEAM"), null, null], [2, R.indexOf("AUTHOR"), null, null]];
// ACCOUNT_USAGE grants: tables, warehouse, db, schema (agent and SV grants are absent, as in real accounts)
const otypes = ["TABLE", "WAREHOUSE", "DATABASE", "SCHEMA", "PROCEDURE"], privs = ["SELECT", "USAGE", "OWNERSHIP"];
const objs = [[0, "D.S.ORDERS"], [1, "WH"], [2, "D"], [3, "D.S"], [4, "D.S.FORECAST(MONTHS NUMBER):NUMBER"]];
const g = (r, o, p) => [R.indexOf(r), o, privs.indexOf(p), 0];
const grants = [g("AUTHOR", 0, "SELECT"), g("AUTHOR", 1, "USAGE"), g("AUTHOR", 2, "USAGE"), g("AUTHOR", 3, "USAGE"), g("AUTHOR", 4, "USAGE"),
  g("TEAM", 2, "USAGE"), g("TEAM", 3, "USAGE"), g("ACCOUNTADMIN", 0, "OWNERSHIP")].flat();
const m = new RBAC({ asof: "", account: "", nodes, edges, users, ugrants, otypes, privs, objs, grants });

const it = (otype, fqn, priv, extra = {}) => ({ key: `${otype}|${fqn}`, otype, fqn, priv, via: "D.S.AGENT", source: ["spec"], ...extra });
const bundle = {
  kind: "agent", fqn: "D.S.AGENT", hash: "", needs_default_wh: true, tree: { kind: "agent", fqn: "D.S.AGENT", items: [], children: [], warnings: [] },
  items: [
    it("AGENT", "D.S.AGENT", "USAGE", { root: true, live: [["AUTHOR", "USAGE"], ["TEAM", "USAGE"]] }),
    it("SEMANTIC VIEW", "D.S.SV", "SELECT", { live: [["AUTHOR", "SELECT"], ["TEAM", "REFERENCES"]] }),
    it("DATABASE ROLE", "SNOWFLAKE.CORTEX_AGENT_USER", "USAGE", { live: [["PUBLIC", "USAGE"]] }),
    it("PROCEDURE", "D.S.FORECAST", "USAGE", { sig: "(NUMBER)" }),
    it("TABLE", "D.S.ORDERS", "SELECT"),
    it("DATABASE", "D", "USAGE"), it("SCHEMA", "D.S", "USAGE"),
    it("TABLE", "D.S.HISTORY_ONLY", "SELECT", { suggested: true }),
  ],
};

const ana = B.gap(m, bundle, B.fromModel(m, 0, "default"));
eq("author is ready", [ana.status, ana.missing.map((r) => r.item.key)], ["ready", []]);
eq("suggested items aren't required until switched on", ana.rows.some((r) => r.item.fqn === "D.S.HISTORY_ONLY"), false);
eq("live grants beat ACCOUNT_USAGE (agent USAGE via AUTHOR)", ana.rows.find((r) => r.item.root).via, "AUTHOR");
eq("Cortex role through PUBLIC", ana.rows.find((r) => r.item.otype === "DATABASE ROLE").via, "PUBLIC");
eq("procedure grant matches across signature formats", ana.rows.find((r) => r.item.otype === "PROCEDURE").ok, true);

const tom = B.gap(m, bundle, B.fromModel(m, 1, "default"));
eq("teammate partly works", tom.status, "partial");
eq("teammate misses SV select, tool, table, default warehouse",
  tom.missing.map((r) => r.item.key).sort(), ["DEFAULT_WAREHOUSE", "PROCEDURE|D.S.FORECAST", "SEMANTIC VIEW|D.S.SV", "TABLE|D.S.ORDERS"]);
eq("lower privilege is explained", tom.missing.find((r) => r.item.otype === "SEMANTIC VIEW").reason, "only REFERENCES through TEAM, needs SELECT");
eq("no default warehouse is called out", tom.missing.find((r) => r.item.key === "DEFAULT_WAREHOUSE").reason.startsWith("no default warehouse"), true);

const sam = B.gap(m, bundle, B.fromModel(m, 2, "default"));
eq("agents use the default role only: SAM holds AUTHOR but defaults to PUBLIC", sam.status, "blocked");
eq("same user with all roles is ready (a worksheet would work)", B.gap(m, bundle, B.fromModel(m, 2, "all")).status, "ready");

const off = { ...bundle, items: bundle.items.map((i) => i.otype === "TABLE" && !i.suggested ? { ...i, on: false } : i) };
eq("switched-off items drop out", B.gap(m, off, B.fromModel(m, 1, "default")).missing.some((r) => r.item.otype === "TABLE"), false);
const on = { ...bundle, items: bundle.items.map((i) => i.suggested ? { ...i, on: true } : i) };
eq("switched-on suggestions are required", B.gap(m, on, B.fromModel(m, 0, "default")).missing.map((r) => r.item.fqn), ["D.S.HISTORY_ONLY"]);

// Live principal: PAT restricted to TEAM, no ACCOUNT_USAGE lag
const live = { user: "ANA", roots: ["AUTHOR", "TEAM"], edges: [["SNOWFLAKE.CORTEX_USER", "PUBLIC"]], truncated: false,
  default_role: "AUTHOR", default_warehouse: "WH", secondary: null, pats: [{ name: "bot", role: "TEAM" }] };
eq("PAT restricted to TEAM is partial even for the author", B.gap(m, bundle, B.fromLive(live, "role", "TEAM")).status, "partial");
eq("live default role is ready", B.gap(m, bundle, B.fromLive(live, "default")).status, "ready");
eq("a role the user doesn't hold is flagged", B.fromLive(live, "role", "SYSADMIN").why, "SYSADMIN isn't granted to ANA");

const t = B.team(m, bundle, "AUTHOR");
eq("team view checks each holder the way the agent runs", t.map((x) => [m.raw.users[x.u].name, x.status]), [["SAM", "blocked"], ["ANA", "ready"]]);
eq("role-level gap for the fix target", B.gap(m, bundle, B.fromRole(m, "TEAM")).missing.length, 3);

console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
