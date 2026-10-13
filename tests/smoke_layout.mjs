// Layout check: panel collapse, full-screen graph, no node stripe.  Run: node tests/smoke_layout.mjs (app on localhost:8507)
import { chromium } from "../frontend/node_modules/playwright-core/index.mjs";
const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {}); const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
await p.goto("http://localhost:8507/");
let fr; for (let i = 0; i < 90; i++) { for (const x of p.frames()) if (await x.$(".graphbox").catch(() => null)) fr = x; if (fr) break; await p.waitForTimeout(1000); }
const ok = (n, c) => console.log((c ? "PASS " : "FAIL ") + n);
ok("graph found", !!fr);
await fr.waitForSelector(".graphbox g rect", { timeout: 60000 });
ok("no 5px stripe", (await fr.$$eval(".graphbox rect", (rs) => rs.filter((r) => r.getAttribute("width") === "5").length)) === 0);
ok("panel shown", !!(await fr.$(".card.panel")));
await fr.click("text=Hide panel");
ok("panel hidden", !(await fr.$(".card.panel")) && !!(await fr.$(".split.solo")));
const w = await fr.$eval(".graphbox", (e) => e.clientWidth);
await fr.click("text=Show panel");
ok("panel back", !!(await fr.$(".card.panel")) && (await fr.$eval(".graphbox", (e) => e.clientWidth)) < w);
await fr.click("button[title='Full screen']");
const r = await fr.$eval(".graphbox", (e) => [e.clientWidth, e.clientHeight, innerWidth, innerHeight]);
ok("full screen " + r, r[0] === r[2] && r[1] === r[3]);
await p.screenshot({ path: "/tmp/rx_full.png" });
await fr.locator("button[title^='Exit full screen']").press("Escape");
ok("esc exits", (await fr.$eval(".graphbox", (e) => e.offsetHeight)) === 680);
await b.close();
