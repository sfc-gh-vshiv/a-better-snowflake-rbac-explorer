// Snowflake Blueprint palette, scoped to the React host (.sl).
export const KIND_META: Record<string, { label: string; fill: string; stroke: string; ink: string }> = {
  sys:        { label: "System",          fill: "#f1f5f9", stroke: "#0b76a8", ink: "#0f172a" },
  functional: { label: "Functional",      fill: "#e0f2fe", stroke: "#29B5E8", ink: "#0f172a" },
  service:    { label: "Service",         fill: "#eef2ff", stroke: "#7159FF", ink: "#3f2fb8" },
  access:     { label: "Access",          fill: "#fffbeb", stroke: "#F59E0B", ink: "#92400e" },
  empty:      { label: "Empty",           fill: "#f1f5f9", stroke: "#94a3b8", ink: "#475569" },
  db:         { label: "Database role",   fill: "#ecfdf5", stroke: "#11B981", ink: "#047857" },
  app:        { label: "Application role", fill: "#fdf4ff", stroke: "#D946EF", ink: "#a21caf" },
};

export const CSS = `
.sl{--bg:#f8fafc;--surface:#fff;--surface2:#f1f5f9;--border:#e2e8f0;--border2:#cbd5e1;
 --text:#0f172a;--dim:#64748b;--accent:#0b76a8;--bright:#29B5E8;--accent-dim:rgba(41,181,232,.10);
 --ok:#059669;--ok-dim:rgba(17,185,129,.12);--warn:#92400E;--warn-dim:rgba(245,158,11,.14);--bad:#dc2626;--bad-dim:rgba(220,38,38,.09);
 --purple:#5b45e0;--cost:#b45309;
 font-family:'DM Sans',system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--text);font-size:14px;line-height:1.45}
.sl *{box-sizing:border-box}
.sl .shell{background:var(--bg);background-image:linear-gradient(var(--grid,rgba(15,23,42,.035)) 1px,transparent 1px),linear-gradient(90deg,rgba(15,23,42,.035) 1px,transparent 1px);
 background-size:24px 24px;border:1px solid var(--border);border-radius:14px;padding:16px 18px 20px;min-height:640px}
.sl .top{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:12px}
.sl .brand{display:flex;align-items:center;gap:10px}
.sl .logo{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,#29B5E8,#0b76a8);display:grid;place-items:center;color:#fff;font-weight:700}
.sl h1{font-size:19px;margin:0;letter-spacing:-.01em}
.sl .sub{color:var(--dim);font-size:12px}
.sl .nav{display:flex;gap:2px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:3px;overflow-x:auto;max-width:100%}
.sl .nav button{border:0;background:transparent;border-radius:7px;padding:6px 11px;cursor:pointer;color:var(--dim);font:inherit;font-weight:500;white-space:nowrap;display:flex;gap:6px;align-items:center}
.sl .nav button:hover{color:var(--text);background:var(--surface2)}
.sl .nav button.on{background:linear-gradient(135deg,#29B5E8,#0b76a8);color:#fff;box-shadow:0 2px 8px rgba(41,181,232,.3)}
.sl .nav .cnt{background:var(--bad);color:#fff;border-radius:9px;font-size:11px;padding:0 6px;font-weight:700}
.sl .grow{flex:1}
.sl .fresh{font-size:12px;color:var(--dim);display:flex;gap:8px;align-items:center}
.sl .dot{width:8px;height:8px;border-radius:50%;background:var(--ok);display:inline-block}
.sl button.btn{border:1px solid var(--border2);background:var(--surface);color:var(--accent);border-radius:8px;padding:6px 12px;font:inherit;font-weight:600;cursor:pointer;display:inline-flex;gap:6px;align-items:center}
.sl button.btn:hover{background:var(--surface2)}
.sl button.btn.primary{background:linear-gradient(135deg,#29B5E8,#0b76a8);color:#fff;border-color:transparent;box-shadow:0 3px 10px rgba(41,181,232,.28)}
.sl button.btn.primary:hover{filter:brightness(1.06)}
.sl button.btn.danger{color:var(--bad);border-color:rgba(220,38,38,.35)}
.sl button.btn.sm{padding:3px 9px;font-size:12px}
.sl button.btn:disabled{opacity:.5;cursor:default}
.sl .card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.sl .card h3{margin:0 0 8px;font-size:14px;letter-spacing:.01em}
.sl .card h3 .muted{font-weight:400}
.sl .grid{display:grid;gap:12px}
.sl .g2{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.sl .g4{grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}
.sl .metric{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px 14px}
.sl .metric .v{font-size:24px;font-weight:700;letter-spacing:-.02em}
.sl .metric .l{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
.sl .metric .s{font-size:12px;color:var(--dim)}
.sl .muted{color:var(--dim)}
.sl .mono{font-family:'Fira Code',ui-monospace,'SF Mono',Consolas,monospace;font-size:12.5px}
.sl .pill{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:1px 8px;font-size:11.5px;font-weight:600;border:1px solid transparent;white-space:nowrap}
.sl .pill.ok{background:var(--ok-dim);color:var(--ok)}
.sl .pill.warn{background:var(--warn-dim);color:var(--warn)}
.sl .pill.bad{background:var(--bad-dim);color:var(--bad)}
.sl .pill.info{background:var(--accent-dim);color:var(--accent)}
.sl .pill.plain{background:var(--surface2);color:var(--dim)}
.sl .chip{display:inline-flex;align-items:center;gap:6px;border-radius:7px;padding:2px 8px;font-size:12.5px;font-weight:600;cursor:pointer;border:1px solid;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.sl .chip:hover{filter:brightness(.96)}
.sl .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.sl .between{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.sl input.txt,.sl select.txt,.sl textarea.txt{border:1px solid var(--border2);border-radius:8px;padding:6px 10px;font:inherit;background:#fff;color:var(--text);min-width:0}
.sl input.txt:focus,.sl select.txt:focus,.sl textarea.txt:focus{outline:2px solid rgba(41,181,232,.45);border-color:var(--bright)}
.sl table.t{width:100%;border-collapse:collapse;font-size:13px}
.sl table.t th{text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);font-weight:600;padding:6px 8px;border-bottom:1px solid var(--border2);position:sticky;top:0;background:#fff;z-index:1}
.sl table.t td{padding:6px 8px;border-bottom:1px solid var(--border);vertical-align:top}
.sl table.t tr:hover td{background:#f8fafc}
.sl .scroll{max-height:440px;overflow:auto;border-radius:8px}
.sl .tscroll{overflow-x:auto}
.sl .path{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.sl .path .arr{color:var(--dim);font-size:12px}
.sl .empty{padding:28px;text-align:center;color:var(--dim)}
.sl .skel{background:linear-gradient(90deg,#eef2f7 25%,#f8fafc 50%,#eef2f7 75%);background-size:200% 100%;animation:slsk 1.2s infinite;border-radius:8px}
@keyframes slsk{0%{background-position:200% 0}100%{background-position:-200% 0}}
.sl .err{background:var(--bad-dim);color:var(--bad);border-radius:10px;padding:10px 12px}
.sl .callout{border-left:3px solid var(--bright);background:var(--accent-dim);border-radius:0 10px 10px 0;padding:9px 12px;font-size:13px}
.sl .callout.warn{border-color:#F59E0B;background:var(--warn-dim)}
.sl .callout.bad{border-color:var(--bad);background:var(--bad-dim)}
.sl .callout.ok{border-color:#11B981;background:var(--ok-dim)}
.sl .split{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:12px}
.sl .split.solo{grid-template-columns:minmax(0,1fr)}
.sl .graphbox.full{position:fixed;inset:0;z-index:1000;height:auto;border-radius:0;border:0}
@media (max-width:1100px){.sl .split{grid-template-columns:1fr}.sl .hide-md{display:none}}
.sl .graphbox{position:relative;background:#fff;border:1px solid var(--border);border-radius:12px;overflow:hidden;height:680px}
.sl .graphbox svg{display:block;width:100%;height:100%;cursor:grab;user-select:none}
.sl .graphbox svg.drag{cursor:grabbing}
.sl .gtools{position:absolute;top:10px;left:10px;right:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;pointer-events:none}
.sl .gtools>*{pointer-events:auto}
.sl .zoom{position:absolute;right:10px;bottom:10px;display:flex;flex-direction:column;gap:4px}
.sl .zoom button{width:30px;height:30px;border-radius:8px;border:1px solid var(--border2);background:#fff;cursor:pointer;font-size:16px;color:var(--accent)}
.sl .graphbox svg.mini{position:absolute;left:10px;bottom:10px;width:180px;height:120px;cursor:pointer;background:rgba(255,255,255,.92);border:1px solid var(--border2);border-radius:8px}
.sl .legend{display:flex;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--dim)}
.sl .legend i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:4px;vertical-align:-1px;border:1.5px solid}
.sl .panel{max-height:680px;overflow:auto}
.sl .kv{display:grid;grid-template-columns:120px 1fr;gap:4px 10px;font-size:13px}
.sl .kv .k{color:var(--dim)}
.sl .tabsm{display:flex;gap:4px;margin:4px 0 8px;flex-wrap:wrap}
.sl .tabsm button{border:1px solid var(--border);background:#fff;border-radius:7px;padding:3px 9px;font:inherit;font-size:12.5px;cursor:pointer;color:var(--dim)}
.sl .tabsm button.on{background:var(--surface2);color:var(--accent);border-color:var(--border2);font-weight:600}
.sl .finding{border:1px solid var(--border);border-radius:12px;background:#fff;overflow:hidden}
.sl .finding .hd{display:flex;gap:10px;align-items:center;padding:11px 14px;cursor:pointer}
.sl .finding .hd:hover{background:#f8fafc}
.sl .finding .n{font-size:20px;font-weight:700;min-width:38px;text-align:right}
.sl .finding .bd{border-top:1px solid var(--border);padding:10px 14px;background:#fcfdff}
.sl .sev{width:4px;align-self:stretch;border-radius:2px}
.sl .listpick{max-height:300px;overflow:auto;border:1px solid var(--border);border-radius:8px;background:#fff}
.sl .listpick div{padding:5px 9px;cursor:pointer;border-bottom:1px solid var(--border);font-size:13px;display:flex;justify-content:space-between;gap:8px}
.sl .listpick div:hover,.sl .listpick div.on{background:var(--accent-dim)}
.sl code{font-family:'Fira Code',ui-monospace,monospace;font-size:12px;background:var(--surface2);padding:1px 5px;border-radius:5px;color:var(--purple)}
.sl pre.ddl{background:#0f172a;color:#e0f2fe;border-radius:10px;padding:10px 12px;font-size:12px;overflow:auto;margin:6px 0 0;white-space:pre-wrap}
.sl .bar{height:8px;border-radius:4px;background:var(--surface2);overflow:hidden}
.sl .bar>i{display:block;height:100%;background:var(--bright)}
.sl .toggle{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text);background:#fff;border:1px solid var(--border2);border-radius:8px;padding:4px 9px;cursor:pointer;user-select:none}
.sl .toggle input{margin:0}
.sl .kbd{border:1px solid var(--border2);border-bottom-width:2px;border-radius:5px;padding:0 5px;font-size:11px;color:var(--dim);background:#fff}
@media (max-width:900px){.sl .hide-sm{display:none}.sl .graphbox{height:520px}}
`;
