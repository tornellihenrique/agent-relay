/** The local dashboard served by the supervisor at http://127.0.0.1:<port>/?t=<token>. */
export function dashboardHtml(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-relay</title>
<style>
:root { --bg:#f6f7f9; --card:#fff; --text:#1c1f24; --muted:#6b7280; --line:#e5e7eb; --accent:#4f46e5; --ok:#16a34a; --warn:#d97706; --bad:#dc2626; --code:#f1f3f6; }
@media (prefers-color-scheme: dark) { :root { --bg:#111317; --card:#1a1d23; --text:#e7e9ee; --muted:#9aa1ad; --line:#2a2f38; --accent:#818cf8; --ok:#22c55e; --warn:#f59e0b; --bad:#f87171; --code:#22262e; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { padding:18px 20px 6px; display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
h1 { font-size:18px; margin:0; }
.sub { color:var(--muted); font-size:13px; }
main { padding:10px 16px 40px; display:grid; gap:14px; max-width:1100px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
.row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.name { font-weight:600; font-size:15px; }
.pill { font-size:12px; padding:2px 8px; border-radius:999px; border:1px solid var(--line); color:var(--muted); }
.pill.running { color:var(--ok); border-color:var(--ok); }
.pill.error { color:var(--bad); border-color:var(--bad); }
.pill.stopped { color:var(--warn); border-color:var(--warn); }
.presence { font-family: ui-monospace, Consolas, monospace; background:var(--code); padding:2px 8px; border-radius:6px; }
.spacer { flex:1; }
button { font:inherit; border:1px solid var(--line); background:var(--card); color:var(--text); padding:5px 12px; border-radius:7px; cursor:pointer; }
button:hover { border-color:var(--accent); }
button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
table { width:100%; border-collapse:collapse; margin-top:10px; font-size:13px; }
th, td { text-align:left; padding:5px 6px; border-top:1px solid var(--line); white-space:nowrap; }
th { color:var(--muted); font-weight:500; }
td.wrap { white-space:normal; }
pre { background:var(--code); border-radius:8px; padding:10px; max-height:360px; overflow:auto; font-size:12px; white-space:pre-wrap; word-break:break-all; margin:10px 0 0; }
.err { color:var(--bad); }
.muted { color:var(--muted); }
@media (max-width: 640px) { .hide-sm { display:none; } }
</style>
</head>
<body>
<header><h1>agent-relay</h1><span class="sub" id="sup"></span><span class="spacer"></span><button onclick="post('/api/reload')">Reload configs</button></header>
<main id="bots"><div class="card muted">Loading…</div></main>
<script>
const T = ${JSON.stringify(token)};
const open = new Set();
async function api(path, method) {
  const r = await fetch(path, { method: method || 'GET', headers: { 'x-relay-token': T } });
  if (!r.ok) throw new Error(await r.text());
  return r.headers.get('content-type')?.includes('json') ? r.json() : r.text();
}
async function post(path) { try { await api(path, 'POST'); } catch (e) { alert(e.message); } refresh(); }
function ago(t) { if (!t) return '—'; const s = Math.round((Date.now() - t) / 1000); return s < 60 ? s + 's ago' : s < 3600 ? Math.floor(s/60) + 'm ago' : s < 86400 ? Math.floor(s/3600) + 'h ago' : Math.floor(s/86400) + 'd ago'; }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
async function toggleLogs(id) { if (open.has(id)) open.delete(id); else open.add(id); refresh(); }
async function refresh() {
  let data;
  try { data = await api('/api/status'); } catch (e) { document.getElementById('bots').innerHTML = '<div class="card err">Supervisor not reachable: ' + esc(e.message) + '</div>'; return; }
  const s = data.supervisor;
  document.getElementById('sup').textContent = 'supervisor pid ' + s.pid + ' · up ' + ago(s.startedAt).replace(' ago', '') + ' · v' + s.version;
  const html = [];
  for (const b of data.bots) {
    const st = b.status;
    const state = b.configError ? 'error' : b.running ? (st?.state === 'error' ? 'error' : 'running') : 'stopped';
    const convs = (st?.conversations || []).map(c => '<tr><td>' + esc(c.key) + '</td><td>' + (c.busy ? '⚙️ working' : c.alive ? '🟢 ready' : '💤 asleep') + (c.queued ? ' · ' + c.queued + ' queued' : '') + '</td><td>' + esc(c.modelLabel || c.model || '—') + '</td><td class="hide-sm">' + esc(c.effort || 'default') + '</td><td>' + (c.ctxPercent != null ? Math.round(c.ctxPercent) + '%' : '—') + '</td><td class="hide-sm">' + ago(c.lastActiveAt) + '</td></tr>').join('');
    html.push('<div class="card"><div class="row"><span class="name">' + esc(b.name || b.id) + '</span><span class="pill ' + state + '">' + state + '</span>' +
      (st?.presence ? '<span class="presence">' + esc(st.presence) + '</span>' : '') + '<span class="spacer"></span>' +
      (b.running ? '<button onclick="post(\\'/api/bots/' + b.id + '/restart\\')">Restart</button><button onclick="post(\\'/api/bots/' + b.id + '/stop\\')">Stop</button>' : '<button class="primary" onclick="post(\\'/api/bots/' + b.id + '/start\\')">Start</button>') +
      '<button onclick="toggleLogs(\\'' + b.id + '\\')">' + (open.has(b.id) ? 'Hide logs' : 'Logs') + '</button></div>' +
      '<div class="sub">' + esc(b.id) + ' · ' + esc(b.context || '') + (b.pid ? ' · pid ' + b.pid : '') + (b.restarts ? ' · ' + b.restarts + ' restarts' : '') + (st?.user ? ' · ' + esc(st.user) : '') + '</div>' +
      (b.configError ? '<pre class="err">' + esc(b.configError) + '</pre>' : '') + (st?.error ? '<div class="err">' + esc(st.error) + '</div>' : '') +
      (convs ? '<table><tr><th>conversation</th><th>state</th><th>model</th><th class="hide-sm">effort</th><th>ctx</th><th class="hide-sm">last</th></tr>' + convs + '</table>' : '') +
      (open.has(b.id) ? '<pre id="log-' + b.id + '">…</pre>' : '') + '</div>');
  }
  document.getElementById('bots').innerHTML = html.join('') || '<div class="card muted">No bots yet. Create one with <code>relay new</code>.</div>';
  for (const id of open) { try { const el = document.getElementById('log-' + id); el.textContent = await api('/api/bots/' + id + '/logs?n=150'); el.scrollTop = el.scrollHeight; } catch {} }
}
refresh(); setInterval(refresh, 4000);
</script>
</body>
</html>`;
}
