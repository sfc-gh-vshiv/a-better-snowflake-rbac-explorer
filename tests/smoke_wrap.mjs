// Role-name wrapping check.  Run: node tests/smoke_wrap.mjs (app on localhost:8507)
import { chromium } from "../frontend/node_modules/playwright-core/index.mjs";
const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
await p.goto("http://localhost:8507/");
let fr; for (let i = 0; i < 120 && !fr; i++) { for (const x of p.frames()) if (await x.$("svg tspan").catch(() => null)) fr = x; if (!fr) await p.waitForTimeout(1000); }
const ok = (n, c) => console.log((c ? "PASS " : "FAIL ") + n);
// every role node: a <g> whose name <text> holds <tspan>s, sized by its first <rect> (skipping the selection halo)
const r = await fr.$$eval("svg g", (gs) => gs.flatMap((g) => {
  const t = g.querySelector(":scope > text > tspan")?.parentElement;
  const rect = [...g.querySelectorAll(":scope > rect")].pop();
  if (!t || !rect) return [];
  const bb = t.getBBox(), w = +rect.getAttribute("width"), h = +rect.getAttribute("height");
  return [{ name: [...t.querySelectorAll("tspan")].map((s) => s.textContent).join(""), lines: t.querySelectorAll("tspan").length,
    right: bb.x + bb.width, w, h, bottom: bb.y + bb.height }];
}));
const over = r.filter((x) => x.right > x.w - 6 || x.bottom > x.h);
ok(`${r.length} role boxes, ${r.filter((x) => x.lines > 1).length} wrapped, all names inside their box`, r.length > 0 && over.length === 0);
if (over.length) console.log(over.slice(0, 5));
const cut = r.filter((x) => x.name.endsWith("…"));
console.log(`  still truncated after two lines: ${cut.length}` + (cut.length ? ` e.g. ${cut.slice(0, 3).map((x) => x.name).join(", ")}` : ""));
ok(`box width fixed (${[...new Set(r.map((x) => x.w))].join(",")}), height at most 61`, new Set(r.map((x) => x.w)).size === 1 && r.every((x) => x.h <= 61));
await p.screenshot({ path: "/tmp/rx_wrap.png", clip: { x: 80, y: 180, width: 700, height: 300 } });
await b.close();
