// E2E for the Ask bot and bot-drafted custom alerts.  Run: node tests/smoke_ask.mjs  (app on localhost:8507)
// Creates one custom alert through the UI, checks it is listed, then deletes it.
import { chromium } from "../frontend/node_modules/playwright-core/index.mjs";

const URL = process.env.APP_URL || "http://localhost:8507";
const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
p.on("pageerror", (e) => errs.push("pageerror " + e.message));
let failed = 0;
const t0 = Date.now();
const check = (name, ok, extra = "") => { console.log(`${Math.round((Date.now() - t0) / 1000)}s ${ok ? "PASS" : "FAIL"} ${name} ${extra}`); if (!ok) failed++; };
const text = (sel) => p.$eval(sel, (e) => e.innerText).catch(() => "");

await p.goto(URL);
await p.waitForSelector(".sl .graphbox svg g rect", { timeout: 300000 });
check("version 1.1.0", (await p.evaluate(() => window.SnowUI.version)) === "role-explorer-1.1.0");

// --- Ask
await p.locator(".sl .askfab").click();
await p.locator(".sl .askpanel .chipq", { hasText: "Who can use ACCOUNTADMIN" }).click();
await p.waitForFunction(() => {
  const b = [...document.querySelectorAll(".sl .askpanel .bub.bot")].pop();
  return b && !/^Thinking/.test(b.innerText);
}, null, { timeout: 120000 });
const ans = await p.$$eval(".sl .askpanel .bub.bot", (e) => e[e.length - 1].innerText);
check("ask answers about the holders", /ACCOUNTADMIN/.test(ans) && !/error/i.test(ans), JSON.stringify(ans.slice(0, 160)));
check("ask offers follow-ups or alert button", (await p.$$(".sl .askpanel .bub.bot button")).length > 0);
// follow-up keeps context
await p.locator(".sl .askpanel textarea").fill("Does SYSADMIN inherit it?");
await p.keyboard.press("Enter");
await p.waitForFunction(() => {
  const b = [...document.querySelectorAll(".sl .askpanel .bub.bot")];
  return b.length >= 2 && !/^Thinking/.test(b[b.length - 1].innerText);
}, null, { timeout: 120000 });
const ans2 = await p.$$eval(".sl .askpanel .bub.bot", (e) => e[e.length - 1].innerText);
check("follow-up answered", /SYSADMIN/i.test(ans2), JSON.stringify(ans2.slice(0, 160)));

// --- Ask -> alert hand-off via "Alert me ..." text
const NAME = "E2E new ACCOUNTADMIN holders " + Date.now().toString(36);
await p.locator(".sl .askpanel textarea").fill("Alert me if anyone new gets ACCOUNTADMIN, even through another role");
await p.keyboard.press("Enter");
await p.waitForSelector(".sl .card h3:has-text('New alert')", { timeout: 120000 });
check("alert request opens a drafted form on the Alerts tab", (await text(".sl .nav button.on")).includes("Alerts"));
await p.locator(".sl .askpanel button", { hasText: "—" }).click();
const form = p.locator(".sl .card", { has: p.locator("h3", { hasText: "New alert" }) });
check("draft is an admin_holders rule for ACCOUNTADMIN", (await form.innerText()).includes("ACCOUNTADMIN") && (await form.innerText()).includes("Role holders change"));
await p.waitForFunction(() => /users can use these roles today/.test(document.querySelector(".sl")?.innerText || ""), null, { timeout: 120000 });
check("live preview shows the baseline", true);
await form.locator("label", { hasText: "Name" }).locator("input").fill(NAME);
await form.locator("button", { hasText: "Save alert" }).click();
await p.waitForFunction((n) => [...document.querySelectorAll(".sl .card b")].some((b) => b.textContent === n), NAME, { timeout: 120000 });
check("saved alert is listed under Custom alerts", (await text(".sl")).includes("Custom alerts"));

// unsupported request is refused with a reason
await p.locator(".sl .card textarea").first().fill("alert me when warehouse spend exceeds 100 credits");
await p.locator(".sl button", { hasText: "Draft with AI" }).click();
await p.waitForSelector(".sl .card .callout.warn", { timeout: 120000 });
check("unsupported request explained", /not supported|can't|cannot|only/i.test(await text(".sl .card .callout.warn")));

// clean up
const card = p.locator(".sl .card", { has: p.locator("b", { hasText: NAME }) });
await card.locator("button", { hasText: "Delete" }).click();
await p.waitForFunction((n) => ![...document.querySelectorAll(".sl .card b")].some((b) => b.textContent === n), NAME, { timeout: 60000 });
check("deleted", true);
check("no page errors", errs.length === 0, errs.join(" | "));
await b.close();
process.exit(failed ? 1 : 0);
