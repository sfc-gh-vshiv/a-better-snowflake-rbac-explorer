// Ask panel expand check.  Run: node tests/smoke_askexpand.mjs (app on localhost:8507)
import { chromium } from "../frontend/node_modules/playwright-core/index.mjs";
const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
await p.goto("http://localhost:8507/");
let fr; for (let i = 0; i < 90 && !fr; i++) { for (const x of p.frames()) if (await x.$(".askfab").catch(() => null)) fr = x; if (!fr) await p.waitForTimeout(1000); }
const ok = (n, c) => console.log((c ? "PASS " : "FAIL ") + n);
await fr.click(".askfab");
const w0 = await fr.$eval(".askpanel", (e) => e.offsetWidth);
await fr.click("button[title='Expand the chat']");
const [w1, h1, top] = await fr.$eval(".askpanel", (e) => [e.offsetWidth, e.offsetHeight, e.getBoundingClientRect().top]);
ok(`expands ${w0} -> ${w1}x${h1}`, w1 > w0 + 200 && h1 > 600);
// Snowsight's app bar (Deploy, Share...) sits over the top of the app: keep the panel header clear of it.
ok(`top edge clear of the app bar (top=${Math.round(top)}px)`, top >= 100);
ok("icon buttons, no Expand/Shrink words", !/Expand|Shrink/.test(await fr.$eval(".askhead", (e) => e.innerText)));
await p.screenshot({ path: "/tmp/rx_askbig.png" });
await fr.$eval("button[title='Shrink the chat']", (b) => b.click());
ok("shrinks", (await fr.$eval(".askpanel", (e) => e.offsetWidth)) === w0);
await b.close();
