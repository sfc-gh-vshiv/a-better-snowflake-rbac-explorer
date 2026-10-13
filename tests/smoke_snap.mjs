// Clicking a role pill below the graph pans the graph to that role.  Run: node tests/smoke_snap.mjs (app on localhost:8507)
import { chromium } from "../frontend/node_modules/playwright-core/index.mjs";
const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {}); const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
await p.goto("http://localhost:8507/");
let fr; for (let i = 0; i < 90; i++) { for (const x of p.frames()) if (await x.$(".graphbox").catch(() => null)) fr = x; if (fr) break; await p.waitForTimeout(1000); }
const ok = (n, c) => console.log((c ? "PASS " : "FAIL ") + n);
await fr.waitForSelector(".graphbox g rect", { timeout: 60000 });
const chips = fr.locator("h3:has-text('not linked') + .row > *");
const n = await chips.count();
ok("isolated pills present (" + n + ")", n > 0);
const names = await chips.allInnerTexts();
for (const i of [0, Math.floor(n / 2), n - 1]) {
  const name = names[i].trim();
  await fr.locator(".row > *", { hasText: new RegExp("^" + name + "$") }).first().click();
  await p.waitForTimeout(1500);
  const r = await fr.evaluate((name) => {
    const box = document.querySelector(".graphbox").getBoundingClientRect();
    const t = [...document.querySelectorAll(".graphbox svg text")].find((e) => e.textContent.trim() === name || e.textContent.startsWith(name.slice(0, 20)));
    if (!t) return null;
    const rc = t.getBoundingClientRect();
    return { dx: Math.abs(rc.left + rc.width / 2 - (box.left + box.width / 2)), dy: Math.abs(rc.top + rc.height / 2 - (box.top + box.height / 2)), w: box.width, h: box.height };
  }, name);
  await p.screenshot({ path: `/tmp/rx_snap_${i}.png` });
  ok(`${name} centred ${JSON.stringify(r)}`, !!r && r.dx < r.w * 0.2 && r.dy < r.h * 0.2);
  if (i === n - 1) await p.screenshot({ path: "/tmp/rx_snap.png" });
}
await b.close();
