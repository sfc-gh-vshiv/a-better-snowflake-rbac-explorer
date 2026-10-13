// Local smoke test for Role Explorer.  Run: node tests/smoke.mjs  (app on localhost:8507)
// CHROME=<chromium or headless-shell binary> if playwright-core can't find one.
import { chromium } from "../frontend/node_modules/playwright-core/index.mjs";
import fs from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const URL = process.env.APP_URL || "http://localhost:8507";
const VERSION = process.env.EXPECT_VERSION || "role-explorer-1.1.0";
const BUNDLE = join(here, "../ui/sl_ui.js");
const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
p.on("pageerror", (e) => errs.push("pageerror " + e.message));
let failed = 0;
const t0 = Date.now();
const check = (name, ok) => { console.log(`${Math.round((Date.now() - t0) / 1000)}s ${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) failed++; };

await p.goto(URL);
await p.waitForSelector(".sl .nav", { timeout: 90000 });
check("bundle version " + VERSION, (await p.evaluate(() => window.SnowUI.version)) === VERSION);
await p.waitForSelector(".sl .graphbox svg g rect", { timeout: 300000 });
check("model loads and graph renders", (await p.$$(".sl .graphbox svg g g")).length > 10);

for (const w of [1440, 1100, 800]) {
  await p.setViewportSize({ width: w, height: 900 });
  await p.waitForTimeout(300);
  check(`nav fits at ${w}px`, await p.$eval(".sl .nav", (n) => n.scrollWidth <= n.clientWidth + 1));
}
await p.setViewportSize({ width: 1440, height: 900 });

// search + Enter selects and centres a role; the side panel shows it; clicking a node selects it
await p.locator(".sl .gtools input.txt").fill("SYSADMIN");
await p.keyboard.press("Enter");
await p.waitForTimeout(1200);
check("search selects role", (await p.$eval(".sl .panel", (e) => e.innerText)).includes("SYSADMIN"));
const box = await p.evaluate(() => {
  const g = [...document.querySelectorAll(".sl .graphbox svg > g > g")].find((n) => n.querySelector("text")?.textContent === "ACCOUNTADMIN");
  const r = g?.getBoundingClientRect();
  return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
});
if (box) await p.mouse.click(box.x, box.y);
await p.waitForTimeout(800);
check("graph click selects role", !!box && (await p.$eval(".sl .panel", (e) => e.innerText)).includes("ACCOUNTADMIN"));
await p.locator(".sl .gtools input.txt").fill("");

for (const [label, probe] of [["Role 360", "Inherited by"], ["Who can access?", "Who can access"], ["Users", "Users"],
  ["Hygiene", "Findings by size"], ["Revoke what-if", "Simulate a revoke"], ["Alerts", "Protected roles"], ["Hierarchy", "Legend"]]) {
  await p.locator(".sl .nav button", { hasText: label }).click();
  await p.waitForTimeout(2500);
  const txt = await p.$eval(".sl", (e) => e.innerText);
  check(`${label} renders`, probe === "Legend" ? (await p.$$(".sl .graphbox svg g rect")).length > 0 : txt.toLowerCase().includes(probe.toLowerCase()));
}

// scroll survives polling reruns (the Alerts tab refreshes every 20 s)
await p.locator(".sl .nav button", { hasText: "Alerts" }).click();
const main = "[data-testid=stMain]";
// wait for the tab's content first: setting scrollTop on a page that is still short just clamps it to 0
await p.waitForFunction(() => /Alert log/.test(document.querySelector(".sl")?.innerText || ""), null, { timeout: 60000 });
await p.waitForTimeout(1000);
await p.$eval(main, (e) => { e.scrollTop = 300; window.__minTop = 1e9; const f = () => { window.__minTop = Math.min(window.__minTop, e.scrollTop); requestAnimationFrame(f); }; f(); });
await p.waitForTimeout(25000);
const top = await p.evaluate(() => window.__minTop);
check("scroll position stable across reruns", top !== 0 || (await p.$eval(main, (e) => e.scrollHeight <= e.clientHeight + 300)));

// hash-keyed loader picks up a rebuilt bundle on the next rerun
const before = await p.evaluate(() => window.__slBundle);
const orig = fs.readFileSync(BUNDLE);
fs.writeFileSync(BUNDLE, Buffer.concat([orig, Buffer.from("\n")]));
try {
  await p.mouse.click(5, 300);
  await p.keyboard.press("r");
  await p.waitForFunction((h) => window.__slBundle && window.__slBundle !== h, before, { timeout: 30000 }).catch(() => {});
  check("bundle reloads after rebuild", (await p.evaluate(() => window.__slBundle)) !== before);
  await p.waitForTimeout(1500);
  check("app still renders after bundle swap", (await p.$eval(".sl", (e) => e.innerText.length)) > 100);
} finally {
  fs.writeFileSync(BUNDLE, orig);
}

check("no console errors", errs.length === 0);
console.log(failed ? `${failed} FAILED` : "ALL PASSED", errs.slice(0, 5));
await b.close();
process.exit(failed ? 1 : 0);
