/**
 * The setup UI's dashboard: one inline page with hash routes for the
 * overview, the parent's stored data, sync jobs, tools, the live Aula view
 * and deleting data. It holds no data itself; every number and item comes
 * from the parent's own /data/* JSON routes in setup-ui.ts.
 *
 * Aula content is put into the page with textContent only. The one place
 * that sets innerHTML is the icon helper, and it only ever gets the static
 * SVG paths below. The MitID QR codes arrive as SVG and are shown as <img>
 * data URLs, which cannot run script.
 *
 * Plain JS with no build step and nothing loaded from elsewhere, so it works
 * inside the HA addon and behind its ingress. Relative URLs throughout, as
 * the ingress serves the page under a path prefix.
 */

// setup-ui.ts imports this file, so it keeps its own escape and no import back.
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );
}

/** `signedInAs` is set in multi-parent mode, for the name and sign-out. */
export function renderDashboard(signedInAs?: string): string {
  const name = signedInAs ? escapeHtml(signedInAs) : '';
  const who = signedInAs
    ? `<div class="who"><div class="avatar" aria-hidden="true">${escapeHtml(initials(signedInAs))}</div><div><strong>${name}</strong><div class="muted small">Logget ind via login-udbyderen</div></div></div>
      <form method="post" action="/auth/logout"><button type="submit" class="btn btn-sm">Log af</button></form>`
    : '';
  const topAvatar = signedInAs
    ? `<div class="avatar" aria-label="${name}">${escapeHtml(initials(signedInAs))}</div>`
    : '';
  return `<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>aula-mcp dashboard</title>
<script>try { const t = localStorage.getItem('aulamcp-theme'); if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); } catch (e) {}</script>
<style>${CSS}</style>
</head>
<body data-signed-in="${name}">
<div class="app">
  <aside class="side" aria-label="Navigation">
    <div class="brand">
      <div class="brand-mark" aria-hidden="true">${HOME_MARK}</div>
      <div><div class="brand-name">aula-mcp</div><div class="brand-sub">Mine data</div></div>
    </div>
    <nav class="nav-list" id="sideNav"></nav>
    <div class="side-foot">
      ${who}
      <div class="theme-pick">
        <span class="muted small">Tema</span>
        <div class="seg" id="themeSeg"><button data-t="system" aria-pressed="true">System</button><button data-t="light" aria-pressed="false">Lys</button><button data-t="dark" aria-pressed="false">Mørk</button></div>
      </div>
    </div>
  </aside>

  <div style="min-width:0">
    <header class="top">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">${HOME_MARK}</div>
        <div><div class="brand-name">aula-mcp</div><div class="brand-sub" id="topSub">Oversigt</div></div>
      </div>
      <div class="spacer"></div>
      <button class="icon-btn" id="themeBtn" aria-label="Skift tema"></button>
      ${topAvatar}
    </header>
    <main id="main"></main>
  </div>
</div>

<nav class="bottom" id="bottomNav" aria-label="Navigation"></nav>

<dialog id="confirmDlg" aria-labelledby="confirmTitle"><form method="dialog" class="dlg" id="confirmForm"></form></dialog>
<dialog id="mitidDlg" aria-labelledby="mitidTitle"><div class="dlg" id="mitidBody"></div></dialog>
<dialog id="lightbox" aria-label="Billede"><div class="lb" id="lbBody"></div></dialog>
<dialog id="moreDlg" aria-label="Flere sider"><div class="dlg" id="moreBody"></div></dialog>
<div class="toast" id="toast" role="status" hidden></div>
<script>${SCRIPT}</script>
</body>
</html>`;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
}

const HOME_MARK =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z"/></svg>';

// Layout: a quiet sidebar on desktop, a sticky header and bottom tab bar on
// phones; the content is one calm column of panels. System fonts only.
const CSS = `
:root {
  --bg: #f3f5f3; --surface: #ffffff; --surface-2: #eaefec; --ink: #17221e; --muted: #5a6a63; --line: #d9e1dc;
  --accent: #2b6652; --accent-soft: #dcebe3; --accent-ink: #ffffff;
  --ok: #2c7a4b; --ok-soft: #e0f0e6; --warn: #9a6210; --warn-soft: #f8ecd6; --err: #b0373a; --err-soft: #f7e1e1;
  --shadow: 0 1px 2px rgba(23,34,30,.06), 0 8px 24px rgba(23,34,30,.06); --scrim: rgba(12,18,16,.55);
  --font-display: "Avenir Next", "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif;
  --font-body: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --r: 14px; --r-sm: 9px;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0e1412; --surface: #151d1a; --surface-2: #1c2622; --ink: #e5ece8; --muted: #92a39b; --line: #28342f;
    --accent: #74c3a3; --accent-soft: #1d3a2f; --accent-ink: #0e1412;
    --ok: #6fc28d; --ok-soft: #173325; --warn: #e3ac52; --warn-soft: #3a2c14; --err: #ec8585; --err-soft: #3d1c1d;
    --shadow: 0 1px 2px rgba(0,0,0,.3), 0 8px 24px rgba(0,0,0,.25); --scrim: rgba(0,0,0,.7);
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #0e1412; --surface: #151d1a; --surface-2: #1c2622; --ink: #e5ece8; --muted: #92a39b; --line: #28342f;
  --accent: #74c3a3; --accent-soft: #1d3a2f; --accent-ink: #0e1412;
  --ok: #6fc28d; --ok-soft: #173325; --warn: #e3ac52; --warn-soft: #3a2c14; --err: #ec8585; --err-soft: #3d1c1d;
  --shadow: 0 1px 2px rgba(0,0,0,.3), 0 8px 24px rgba(0,0,0,.25); --scrim: rgba(0,0,0,.7);
  color-scheme: dark;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 var(--font-body); }
body::before { content: ""; position: fixed; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); z-index: 30; background: var(--surface); }
h1, h2, h3 { font-family: var(--font-display); font-weight: 650; letter-spacing: -0.01em; text-wrap: balance; margin: 0; }
h1 { font-size: 1.75rem; line-height: 1.15; }
h2 { font-size: 1.15rem; line-height: 1.25; }
h3 { font-size: 1rem; line-height: 1.3; }
p { margin: 0; }
button, input, select { font: inherit; color: inherit; }
code, .mono { font-family: var(--font-mono); font-size: .84em; }
.muted { color: var(--muted); }
.small { font-size: .86rem; }
.num { font-variant-numeric: tabular-nums; }
.eyebrow { font-size: .74rem; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
.pre { white-space: pre-wrap; overflow-wrap: anywhere; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }

.app { display: grid; grid-template-columns: 1fr; min-height: 100vh; }
.side { display: none; }
.top {
  position: sticky; top: env(safe-area-inset-top, 0px); z-index: 20;
  background: var(--surface); border-bottom: 1px solid var(--line);
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px));
  padding-block: 10px; display: flex; align-items: center; gap: 12px;
}
.brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.brand-mark { width: 34px; height: 34px; border-radius: 10px; background: var(--accent); color: var(--accent-ink); display: grid; place-items: center; flex: none; }
.brand-name { font-family: var(--font-display); font-weight: 650; font-size: 1.05rem; line-height: 1.1; }
.brand-sub { font-size: .78rem; color: var(--muted); }
.top .spacer { flex: 1; }
main {
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px));
  padding-block: 20px calc(96px + env(safe-area-inset-bottom, 0px));
  min-width: 0;
}
.view { width: 100%; min-width: 0; display: grid; gap: 18px; }
.view-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px; }
.view-head .lede { color: var(--muted); max-width: 60ch; margin-top: 6px; }

.bottom {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 20;
  background: var(--surface); border-top: 1px solid var(--line);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  padding-left: env(safe-area-inset-left, 0px); padding-right: env(safe-area-inset-right, 0px);
  display: grid; grid-template-columns: repeat(5, 1fr);
}
.bottom button { background: none; border: 0; padding: 8px 4px 9px; display: grid; justify-items: center; gap: 2px; font-size: .72rem; color: var(--muted); cursor: pointer; }
.bottom button svg { width: 22px; height: 22px; }
.bottom button[aria-current="page"] { color: var(--accent); font-weight: 700; }

.nav-list { display: grid; gap: 2px; }
.nav-item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 12px; border-radius: var(--r-sm); background: none; border: 0; text-align: left; color: var(--ink); cursor: pointer; }
.nav-item svg { width: 19px; height: 19px; color: var(--muted); flex: none; }
.nav-item:hover { background: var(--surface-2); }
.nav-item[aria-current="page"] { background: var(--accent-soft); color: var(--accent); font-weight: 700; }
.nav-item[aria-current="page"] svg { color: var(--accent); }
.nav-item .count { margin-left: auto; font-size: .75rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.nav-item.danger, .nav-item.danger svg { color: var(--err); }
.nav-sep { height: 1px; background: var(--line); margin: 10px 4px; }

@media (min-width: 900px) {
  body::before { background: var(--bg); }
  .app { grid-template-columns: 256px 1fr; }
  .top, .bottom { display: none; }
  .side {
    display: flex; flex-direction: column; gap: 18px; position: sticky; top: 0; height: 100vh; overflow-y: auto;
    padding: calc(22px + env(safe-area-inset-top, 0px)) 14px 20px max(14px, env(safe-area-inset-left, 0px));
    background: var(--surface); border-right: 1px solid var(--line);
  }
  .side .brand { padding: 0 6px; }
  main { padding-block: 32px 56px; padding-left: 36px; padding-right: max(36px, env(safe-area-inset-right, 0px)); }
  h1 { font-size: 2rem; }
}
.side-foot { margin-top: auto; display: grid; gap: 10px; padding: 12px; border-radius: var(--r-sm); background: var(--surface-2); font-size: .84rem; }
.side-foot form { margin: 0; }
.theme-pick { display: grid; gap: 6px; }
.theme-pick .seg button { font-size: .76rem; padding: 4px 10px; }
.who { display: flex; gap: 10px; align-items: center; min-width: 0; overflow-wrap: anywhere; }
.avatar { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: .85rem; background: var(--accent-soft); color: var(--accent); flex: none; }

.btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 8px 14px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); cursor: pointer; font-weight: 700; font-size: .9rem; white-space: nowrap; }
.btn:hover { border-color: var(--muted); }
.btn svg { width: 16px; height: 16px; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.btn-primary:hover { filter: brightness(1.06); border-color: var(--accent); }
.btn-danger { background: var(--err); border-color: var(--err); color: var(--surface); }
.btn-danger:hover { filter: brightness(1.06); border-color: var(--err); }
.btn-ghost-danger { color: var(--err); }
.btn-sm { padding: 5px 11px; font-size: .82rem; }
.btn[disabled] { opacity: .5; cursor: not-allowed; filter: none; }
.icon-btn { width: 38px; height: 38px; border-radius: 50%; border: 1px solid var(--line); background: var(--surface); display: grid; place-items: center; cursor: pointer; flex: none; }
.icon-btn svg { width: 18px; height: 18px; }
.field { display: grid; gap: 4px; min-width: 0; }
.field label { font-size: .76rem; color: var(--muted); font-weight: 700; letter-spacing: .03em; }
.input, select.input { width: 100%; padding: 8px 12px; border-radius: var(--r-sm); border: 1px solid var(--line); background: var(--surface); min-height: 40px; }
.input:focus { outline: 2px solid var(--accent); outline-offset: 0; border-color: transparent; }
.seg { display: inline-flex; padding: 3px; border-radius: 999px; background: var(--bg); gap: 2px; flex-wrap: wrap; }
.seg button { border: 0; background: none; padding: 5px 12px; border-radius: 999px; cursor: pointer; font-size: .85rem; color: var(--muted); font-weight: 700; }
.seg button[aria-pressed="true"] { background: var(--surface); color: var(--ink); box-shadow: var(--shadow); }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { border: 1px solid var(--line); background: var(--surface); border-radius: 999px; padding: 4px 11px; font-size: .82rem; cursor: pointer; color: var(--ink); }
.chip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); font-weight: 700; }
.chip .c { opacity: .7; margin-left: 4px; font-variant-numeric: tabular-nums; }

.panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: 18px; min-width: 0; }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.grid-2 { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); }
.pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 999px; font-size: .78rem; font-weight: 700; white-space: nowrap; }
.pill::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.pill.ok { background: var(--ok-soft); color: var(--ok); }
.pill.warn { background: var(--warn-soft); color: var(--warn); }
.pill.err { background: var(--err-soft); color: var(--err); }
.pill.neutral { background: var(--surface-2); color: var(--muted); }
.pill.run { background: var(--accent-soft); color: var(--accent); }
.pill.run::before { animation: pulse 1s infinite; }
@keyframes pulse { 50% { opacity: .25; } }
.tag { display: inline-block; padding: 1px 8px; border-radius: 6px; font-size: .74rem; font-weight: 700; background: var(--surface-2); color: var(--muted); white-space: nowrap; }
.tag.read { background: var(--accent-soft); color: var(--accent); }
.tag.write { background: var(--warn-soft); color: var(--warn); }
.tag.raw { background: var(--err-soft); color: var(--err); }

.login-card { display: grid; gap: 16px; grid-template-columns: 1fr; align-items: center; }
@media (min-width: 700px) { .login-card { grid-template-columns: auto 1fr auto; } }
.login-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.seal { width: 54px; height: 54px; border-radius: 16px; display: grid; place-items: center; background: var(--ok-soft); color: var(--ok); }
.seal.bad { background: var(--warn-soft); color: var(--warn); }
.seal svg { width: 28px; height: 28px; }
.login-meta { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 6px; font-size: .88rem; color: var(--muted); }
.login-meta strong { color: var(--ink); font-weight: 700; }
.time-track { height: 6px; border-radius: 99px; background: var(--surface-2); overflow: hidden; margin-top: 10px; }
.time-track span { display: block; height: 100%; background: var(--ok); border-radius: 99px; }

.kid { display: grid; grid-template-columns: auto 1fr; gap: 12px; align-items: center; }
.kid-face { width: 46px; height: 46px; border-radius: 14px; display: grid; place-items: center; font-family: var(--font-display); font-weight: 650; font-size: 1.15rem; background: var(--accent-soft); color: var(--accent); }
.kid-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--muted); font-size: .86rem; }

.stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: var(--r); overflow: hidden; }
@media (min-width: 700px) { .stats { grid-template-columns: repeat(4, 1fr); } }
.stat { background: var(--surface); padding: 14px 16px; display: grid; gap: 2px; min-width: 0; align-content: start; }
.stat .v { font-family: var(--font-display); font-size: 1.6rem; font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1.1; }
.stat .v.small-v { font-size: 1.15rem; padding-block: 6px; }
.stat .l { font-size: .82rem; color: var(--muted); }
.stat button.linkish { justify-self: start; margin-top: 4px; }
.linkish { background: none; border: 0; padding: 0; color: var(--accent); font-weight: 700; cursor: pointer; font-size: .86rem; }
.linkish:hover { text-decoration: underline; }

.list { display: grid; }
.list > * + * { border-top: 1px solid var(--line); }
.li { display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: start; padding: 11px 0; }
button.li { width: 100%; background: none; border-left: 0; border-right: 0; border-bottom: 0; text-align: left; cursor: pointer; color: var(--ink); }
.list > button.li:first-child { border-top: 0; }
.type-dot { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; background: var(--surface-2); color: var(--muted); flex: none; }
.type-dot svg { width: 16px; height: 16px; }
.li-title { font-weight: 700; overflow-wrap: anywhere; }
.li-sub { color: var(--muted); font-size: .86rem; overflow-wrap: anywhere; }

.banner { display: flex; gap: 12px; align-items: flex-start; padding: 14px 16px; border-radius: var(--r); border: 1px solid var(--line); background: var(--surface); }
.banner > svg { width: 20px; height: 20px; flex: none; margin-top: 2px; }
.banner.info { background: var(--accent-soft); border-color: transparent; color: var(--ink); }
.banner.info > svg { color: var(--accent); }
.banner.warn { background: var(--warn-soft); border-color: transparent; }
.banner.warn > svg { color: var(--warn); }
.banner .grow { flex: 1; min-width: 0; display: grid; gap: 4px; }
.banner-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }

.kv { display: grid; grid-template-columns: max-content 1fr; gap: 8px 18px; font-size: .9rem; margin: 0; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.count-table { width: 100%; border-collapse: collapse; font-size: .9rem; }
.count-table th { text-align: left; font-size: .74rem; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); font-weight: 700; padding: 0 8px 8px 0; }
.count-table td { padding: 9px 8px 9px 0; border-top: 1px solid var(--line); vertical-align: middle; }
.count-table td.n, .count-table th.n { text-align: right; font-variant-numeric: tabular-nums; }
.count-table td.n { font-weight: 700; }
.count-table .barcell { width: 32%; }
.kind-cell { display: inline-flex; gap: 8px; align-items: center; }
.kind-cell .type-dot { width: 24px; height: 24px; }
.minibar { height: 6px; border-radius: 99px; background: var(--surface-2); overflow: hidden; }
.minibar span { display: block; height: 100%; background: var(--accent); border-radius: 99px; }
.table-wrap { overflow-x: auto; }
.hide-sm { display: none; }
@media (min-width: 700px) { .hide-sm { display: table-cell; } }
.lock-list { display: grid; gap: 12px; }
.lock-list > div { display: grid; grid-template-columns: auto 1fr; gap: 10px; }
.lock-list svg { width: 18px; height: 18px; color: var(--accent); margin-top: 3px; }
.stored-item + .stored-item { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }

.filters { display: grid; gap: 12px; }
.filter-row { display: grid; gap: 10px; grid-template-columns: 1fr; }
@media (min-width: 700px) { .filter-row { grid-template-columns: 2fr 1fr; } }
.browse { display: grid; gap: 18px; grid-template-columns: 1fr; align-items: start; }
@media (min-width: 1100px) { .browse { grid-template-columns: minmax(0, 5fr) minmax(0, 6fr); } }
.result-list { padding: 4px 0; }
.result { width: 100%; text-align: left; background: none; border: 0; border-left: 3px solid transparent; cursor: pointer; padding: 12px 16px 12px 13px; display: grid; grid-template-columns: auto 1fr; gap: 12px; color: var(--ink); }
.result:hover { background: var(--surface-2); }
.result[aria-current="true"] { background: var(--accent-soft); border-left-color: var(--accent); }
.result-top { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
.result-date { font-size: .78rem; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.result-foot { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 5px; }
.unread-dot { color: var(--accent); }
.more-row { padding: 10px 16px 16px; }
.detail { position: sticky; top: 24px; }
.detail-empty { text-align: center; padding: 48px 20px; color: var(--muted); }
.detail-empty svg { width: 28px; height: 28px; }
.msg { display: grid; grid-template-columns: auto 1fr; gap: 12px; padding: 14px 0; }
.msg + .msg { border-top: 1px solid var(--line); }
.msg .avatar { background: var(--surface-2); color: var(--muted); }
.msg-head { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; font-size: .86rem; }
.msg-body { margin-top: 4px; max-width: 65ch; }
.attachments { display: flex; gap: 6px; flex-wrap: wrap; }
.attach { display: inline-flex; gap: 6px; align-items: center; margin-top: 8px; padding: 5px 10px; border-radius: 8px; background: var(--surface-2); font-size: .84rem; overflow-wrap: anywhere; }
.attach svg { width: 14px; height: 14px; flex: none; }
.detail-meta { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: .86rem; color: var(--muted); margin: 6px 0 14px; }
.detail .kv { margin-bottom: 14px; }
.back-btn { display: none; }
@media (max-width: 1099px) {
  .browse.has-detail .result-panel { display: none; }
  .browse:not(.has-detail) .detail { display: none; }
  .back-btn { display: inline-flex; margin-bottom: 12px; }
  .detail { position: static; }
}
.empty { padding: 32px 16px; text-align: center; color: var(--muted); display: grid; gap: 4px; justify-items: center; }
.empty .btn { margin-top: 10px; }
.empty-icon { width: 54px; height: 54px; border-radius: 16px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); margin-bottom: 8px; }
.empty-icon svg { width: 26px; height: 26px; }
.error-text { color: var(--err); }

.jobs { display: grid; }
.job { border-top: 1px solid var(--line); }
.job:first-child { border-top: 0; }
.job-row { display: grid; grid-template-columns: 1fr auto; gap: 8px 14px; align-items: center; padding: 13px 0; }
@media (min-width: 800px) { .job-row { grid-template-columns: minmax(150px, 1.3fr) 1fr 1fr 1.1fr .9fr auto; } }
.job-name { display: flex; align-items: center; gap: 10px; min-width: 0; background: none; border: 0; padding: 0; text-align: left; cursor: pointer; color: var(--ink); }
.job-name .chev { width: 16px; height: 16px; color: var(--muted); transition: transform .15s; flex: none; }
.job[data-open="true"] .chev { transform: rotate(90deg); }
.every { font-size: .76rem; color: var(--muted); font-family: var(--font-mono); }
.jcell { font-size: .86rem; font-variant-numeric: tabular-nums; }
.jcell .lbl { display: block; font-size: .72rem; color: var(--muted); letter-spacing: .04em; text-transform: uppercase; font-weight: 700; }
.job-cells { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
@media (min-width: 800px) { .job-cells { display: contents; } .job-cells .jcell .lbl { display: none; } }
.job-head { display: none; }
@media (min-width: 800px) { .job-head { display: grid; grid-template-columns: minmax(150px, 1.3fr) 1fr 1fr 1.1fr .9fr auto; gap: 14px; padding-bottom: 8px; border-bottom: 1px solid var(--line); } .job-head span { font-size: .72rem; color: var(--muted); letter-spacing: .06em; text-transform: uppercase; font-weight: 700; } }
.job-status { grid-row: 1; grid-column: 2; justify-self: end; }
@media (min-width: 800px) { .job-status { grid-row: auto; grid-column: auto; justify-self: start; } }
.job-act { grid-column: 1 / -1; }
@media (min-width: 800px) { .job-act { grid-column: auto; } }
.job-more { padding: 0 0 14px 26px; display: grid; gap: 10px; font-size: .88rem; }
.errbox { padding: 10px 12px; border-radius: var(--r-sm); background: var(--err-soft); color: var(--ink); font-size: .86rem; overflow-wrap: anywhere; }
.errbox strong { color: var(--err); }

.tool-group + .tool-group { margin-top: 22px; }
.tool-group-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.tool { border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--surface); }
.tool + .tool { margin-top: 6px; }
.tool-sum { width: 100%; display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; padding: 11px 14px; background: none; border: 0; cursor: pointer; text-align: left; color: var(--ink); }
.tool-sum .chev { width: 16px; height: 16px; color: var(--muted); transition: transform .15s; }
.tool[data-open="true"] .tool-sum .chev { transform: rotate(90deg); }
.tool-name { font-family: var(--font-mono); font-size: .86rem; font-weight: 500; overflow-wrap: anywhere; }
.tool-title { font-size: .86rem; color: var(--muted); }
.tool-badges { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.tool-body { padding: 0 14px 14px 40px; display: grid; gap: 12px; font-size: .9rem; }
.tool-body p { max-width: 70ch; }
.params { width: 100%; border-collapse: collapse; font-size: .84rem; }
.params th { text-align: left; font-size: .72rem; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); padding: 0 10px 6px 0; }
.params td { border-top: 1px solid var(--line); padding: 7px 10px 7px 0; vertical-align: top; }
.enable-note { font-size: .84rem; padding: 8px 10px; background: var(--surface-2); border-radius: 8px; }
.onoff { font-size: .78rem; font-weight: 700; }
.onoff.on { color: var(--ok); }
.onoff.off { color: var(--muted); }

.cap { display: grid; gap: 6px; padding: 12px 0; }
.cap-tools { display: flex; gap: 6px; flex-wrap: wrap; }
.cap-tools code { background: var(--surface-2); padding: 2px 7px; border-radius: 6px; }
.skeleton { height: 14px; border-radius: 6px; background: var(--surface-2); animation: pulse 1.2s infinite; }
.skel-panel { display: grid; gap: 10px; }

.del-row { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center; padding: 12px 0; }
.del-name { display: flex; gap: 10px; align-items: center; min-width: 0; }
.danger-zone { border: 1px solid var(--err); border-radius: var(--r); padding: 18px; background: var(--surface); display: grid; gap: 12px; }
.danger-zone h2 { color: var(--err); }

dialog { border: 0; padding: 0; background: transparent; color: var(--ink); max-width: min(480px, calc(100vw - 32px)); width: 100%; }
dialog::backdrop { background: var(--scrim); }
.dlg { background: var(--surface); border-radius: 18px; padding: 22px; display: grid; gap: 14px; box-shadow: var(--shadow); border: 1px solid var(--line); margin: 0; }
.dlg-icon { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; background: var(--err-soft); color: var(--err); }
.dlg-icon.calm { background: var(--accent-soft); color: var(--accent); }
.dlg-icon svg { width: 22px; height: 22px; }
.dlg-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.qr-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.qr { border-radius: 12px; background: #fff; padding: 8px; display: grid; place-items: center; }
.qr img { width: 100%; height: auto; max-width: 200px; display: block; }
.otp { font-family: var(--font-mono); font-size: 1.6rem; text-align: center; letter-spacing: .12em; }
.identity-options { display: grid; gap: 8px; }

.storage-bar { position: relative; height: 14px; border-radius: 99px; background: var(--surface-2); margin: 14px 0 28px; }
.storage-bar .fill { position: absolute; inset: 0 auto 0 0; border-radius: 99px; background: var(--accent); max-width: 100%; }
.storage-bar .fill.other { background: color-mix(in srgb, var(--muted) 45%, var(--surface-2)); }
.storage-bar .stop { position: absolute; top: -5px; bottom: -5px; width: 2px; margin-left: -1px; background: var(--err); }
.storage-bar .stop span { position: absolute; top: 100%; right: 0; margin-top: 4px; font-size: .72rem; color: var(--err); font-weight: 700; white-space: nowrap; }
.storage-bar .stop.low span { right: auto; left: 0; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: .82rem; color: var(--muted); }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
.panel-foot { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; margin-top: 14px; }
.albums { display: grid; gap: 18px 14px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 160px), 1fr)); }
.album { background: none; border: 0; padding: 0; text-align: left; cursor: pointer; color: var(--ink); display: grid; gap: 4px; align-content: start; min-width: 0; }
.album-cover { aspect-ratio: 4 / 3; width: 100%; border-radius: 12px; overflow: hidden; position: relative; display: grid; place-items: center; background: var(--surface-2); color: var(--muted); margin-bottom: 4px; }
.album-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.album-cover > svg, .thumb > svg { width: 28px; height: 28px; }
.album:hover .album-cover { outline: 2px solid var(--accent); outline-offset: 2px; }
.album-title { font-weight: 700; font-size: .92rem; line-height: 1.3; overflow-wrap: anywhere; }
.album-sub { font-size: .8rem; color: var(--muted); overflow-wrap: anywhere; }
.dl-badge { position: absolute; right: 8px; bottom: 8px; background: var(--scrim); color: #fff; font-size: .72rem; padding: 2px 8px; border-radius: 99px; font-weight: 700; }
.media-grid { display: grid; gap: 6px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 108px), 1fr)); }
.thumb { aspect-ratio: 1; width: 100%; border: 0; padding: 0; border-radius: 8px; overflow: hidden; position: relative; cursor: pointer; background: var(--surface-2); color: var(--muted); display: grid; place-items: center; }
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.thumb:hover { outline: 2px solid var(--accent); outline-offset: 1px; }
.thumb .vid { position: absolute; left: 6px; top: 6px; background: var(--scrim); color: #fff; font-size: .7rem; padding: 1px 7px; border-radius: 99px; display: flex; gap: 4px; align-items: center; font-weight: 700; }
.thumb .vid svg { width: 10px; height: 10px; }
.thumb .queued { position: absolute; inset: auto 0 0; padding: 4px 6px; background: color-mix(in srgb, var(--surface) 82%, transparent); color: var(--muted); font-size: .72rem; font-weight: 700; text-align: center; }
.thumb .queued.failed { color: var(--err); }
#lightbox { max-width: min(1100px, calc(100vw - 24px)); }
.lb { background: var(--surface); border-radius: 16px; overflow: hidden; border: 1px solid var(--line); }
.lb-stage { position: relative; background: #0b0f0d; display: grid; place-items: center; min-height: 220px; }
.lb-stage img, .lb-stage video { width: 100%; max-height: 72vh; object-fit: contain; display: block; }
.lb-missing { color: #d6dfda; padding: 48px 24px; text-align: center; display: grid; gap: 6px; justify-items: center; max-width: 46ch; }
.lb-missing svg { width: 32px; height: 32px; }
.lb-nav, .lb-close { position: absolute; border: 0; background: rgba(255,255,255,.88); color: #17221e; display: grid; place-items: center; cursor: pointer; border-radius: 50%; }
.lb-nav { top: 50%; transform: translateY(-50%); width: 42px; height: 42px; }
.lb-nav svg { width: 20px; height: 20px; }
.lb-prev { left: 10px; } .lb-next { right: 10px; }
.lb-close { top: 10px; right: 10px; width: 36px; height: 36px; }
.lb-close svg { width: 18px; height: 18px; }
.lb-info { padding: 14px 18px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 18px; font-size: .86rem; }
.lb-info strong { overflow-wrap: anywhere; }
a.btn { text-decoration: none; }

.toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(86px + env(safe-area-inset-bottom, 0px)); z-index: 60; background: var(--ink); color: var(--bg); padding: 10px 16px; border-radius: 999px; font-size: .9rem; font-weight: 700; box-shadow: var(--shadow); max-width: calc(100vw - 32px); }
@media (min-width: 900px) { .toast { bottom: 28px; } }
@media (prefers-reduced-motion: reduce) { *, *::before { animation: none !important; transition: none !important; } }
`;

// Kept free of backticks, \${ and backslashes so it can sit in this template.
const SCRIPT = `
(() => {
'use strict';

/* ---------- icons: static paths only, never data ---------- */
const I = {
  home: '<path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z"/>',
  db: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  sync: '<path d="M20 12a8 8 0 0 1-14.3 4.9"/><path d="M4 12A8 8 0 0 1 18.3 7.1"/><path d="M18.5 3v4.3h-4.3"/><path d="M5.5 21v-4.3h4.3"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m20.5 16-4.5-4.5L7 19.5"/>',
  tools: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L4 16.8V20h3.2l5.3-5.3a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
  live: '<circle cx="12" cy="12" r="2.5"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 12.5h9L17.5 7"/><path d="M10 11v5M14 11v5"/>',
  more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
  shield: '<path d="M12 3 5 6v5.5c0 4.3 3 7.9 7 9.5 4-1.6 7-5.2 7-9.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  shieldX: '<path d="M12 3 5 6v5.5c0 4.3 3 7.9 7 9.5 4-1.6 7-5.2 7-9.5V6z"/><path d="M12 8.5v4.5M12 16h.01"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  warn: '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4.5M12 17.5h.01"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  left: '<path d="m15 6-6 6 6 6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7 8 6 8-6"/>',
  post: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M8 9h8M8 13h8M8 17h5"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  cal: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  door: '<path d="M6 20V4.5h9V20"/><path d="M15 6.5h3V20M4 20h16"/><circle cx="12.3" cy="12.5" r=".9" fill="currentColor"/>',
  week: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9 4.5v15M14.5 4.5v15"/>',
  task: '<path d="M8.5 12.5 11 15l5-6"/><rect x="4" y="4" width="16" height="16" rx="3"/>',
  person: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>',
  group: '<circle cx="9" cy="9" r="3"/><circle cx="17" cy="10" r="2.4"/><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8M15 14.6c2.4 0 4.2 1.4 4.8 4.4"/>',
  clip: '<path d="m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1L13 4.3a3.3 3.3 0 0 1 4.7 4.7l-7.8 7.8a1.7 1.7 0 0 1-2.4-2.4l7.1-7.1"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
};
const icon = (name, cls) => {
  const span = document.createElement('span');
  span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + I[name] + '</svg>';
  const svg = span.firstChild;
  if (cls) svg.setAttribute('class', cls);
  return svg;
};

/* ---------- DOM: text only ---------- */
const el = (tag, props, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.setAttribute('style', v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'disabled' || k === 'hidden') node[k] = Boolean(v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child);
  }
  return node;
};
const $ = (id) => document.getElementById(id);
/** replaceChildren, minus the nulls that conditional children leave. */
const fill = (node, ...kids) => node.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
const fmt = (n) => Number(n || 0).toLocaleString('da-DK');
const plural = (n, one, many) => fmt(n) + ' ' + (n === 1 ? one : many);
const UNITS = ['B', 'kB', 'MB', 'GB', 'TB'];
/** Bytes for people: 1,2 GB. */
function size(bytes) {
  let n = Number(bytes || 0);
  let i = 0;
  while (n >= 1000 && i < UNITS.length - 1) { n /= 1000; i++; }
  return n.toLocaleString('da-DK', { maximumFractionDigits: i < 2 ? 0 : 1 }) + ' ' + UNITS[i];
}
const pct = (x) => Math.round(Math.min(Math.max(Number(x) || 0, 0), 1) * 100) + ' %';

/* ---------- server ---------- */
const getJson = async (path) => {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || ('HTTP ' + res.status)), { status: res.status });
  return body;
};
const postJson = async (path, data) => {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(data || {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || ('HTTP ' + res.status)), { status: res.status });
  return body;
};

/* ---------- what is what ---------- */
const KINDS = {
  message_thread: { label: 'Beskedtråde', one: 'Beskedtråd', icon: 'mail', synced: true },
  message: { label: 'Beskeder', one: 'Besked', icon: 'mail', synced: true },
  post: { label: 'Opslag', one: 'Opslag', icon: 'post', synced: true },
  notification: { label: 'Notifikationer', one: 'Notifikation', icon: 'bell', synced: true },
  calendar_event: { label: 'Kalender', one: 'Begivenhed', icon: 'cal', synced: true },
  presence: { label: 'Fremmøde', one: 'Fremmøde', icon: 'door', synced: true },
  contact: { label: 'Kontakter', one: 'Kontakt', icon: 'person', synced: true },
  group: { label: 'Grupper', one: 'Gruppe', icon: 'group', synced: true },
  weekly_plan: { label: 'Ugeplaner', one: 'Ugeplan', icon: 'week', synced: false },
  task: { label: 'Opgaver og lektier', one: 'Opgave', icon: 'task', synced: false },
  gallery_album: { label: 'Fotoalbum', one: 'Album', icon: 'image', synced: true },
  gallery_media: { label: 'Billeder og video', one: 'Medie', icon: 'image', synced: true },
};
const kindOf = (k) => KINDS[k] || { label: k, one: k, icon: 'db', synced: false };
const JOBS = {
  messages: 'Beskeder',
  notifications: 'Notifikationer',
  posts: 'Opslag',
  presence: 'Fremmøde',
  calendar: 'Kalender',
  directory: 'Kontakter og grupper',
  gallery: 'Galleri',
};
const JOB_TEXT = {
  messages: 'Beskedtråde og beskederne i de tråde, der er ændret.',
  notifications: 'Notifikationer.',
  posts: 'Opslag fra skoler og klubber.',
  presence: 'Dagens fremmøde (komme og gå) for hvert barn.',
  calendar: 'Begivenheder fra en uge tilbage til otte uger frem.',
  directory: 'Børnenes grupper og deres kontaktlister.',
  gallery: 'Fotoalbum med billeder og videoer i original kvalitet og et miniaturebillede, op til 300 filer pr. kørsel.',
};
const jobLabel = (j) => JOBS[j] || j;
const VIEWS = [
  { id: 'oversigt', label: 'Oversigt', icon: 'home', bottom: true },
  { id: 'gemt', label: 'Gemt om dig', icon: 'db' },
  { id: 'gennemse', label: 'Gennemse', icon: 'search', bottom: true },
  { id: 'sync', label: 'Synkronisering', short: 'Sync', icon: 'sync', bottom: true },
  { id: 'galleri', label: 'Galleri', icon: 'image', bottom: true },
  { id: 'vaerktoejer', label: 'Værktøjer', icon: 'tools' },
  { id: 'live', label: 'Live fra Aula', icon: 'live' },
  { id: 'slet', label: 'Slet data', icon: 'trash', danger: true },
];

/* ---------- dates (Aula times are Danish) ---------- */
const MON = ['jan.', 'feb.', 'mar.', 'apr.', 'maj', 'jun.', 'jul.', 'aug.', 'sep.', 'okt.', 'nov.', 'dec.'];
const DAY = ['søn.', 'man.', 'tir.', 'ons.', 'tor.', 'fre.', 'lør.'];
const pad = (n) => String(n).padStart(2, '0');
const toDate = (v) => (typeof v === 'number' ? new Date(v * 1000) : v ? new Date(v) : null);
const hm = (t) => pad(t.getHours()) + ':' + pad(t.getMinutes());
function rel(v) {
  const t = toDate(v);
  if (!t || Number.isNaN(t.getTime())) return '–';
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(t).setHours(0, 0, 0, 0) - day0) / 864e5);
  if (diff === 0) return 'i dag ' + hm(t);
  if (diff === -1) return 'i går ' + hm(t);
  if (diff === 1) return 'i morgen ' + hm(t);
  return DAY[t.getDay()] + ' ' + t.getDate() + '. ' + MON[t.getMonth()] + (t.getFullYear() !== new Date().getFullYear() ? ' ' + t.getFullYear() : '');
}
function longDate(v) {
  const t = toDate(v);
  if (!t || Number.isNaN(t.getTime())) return '–';
  return t.getDate() + '. ' + MON[t.getMonth()] + ' ' + t.getFullYear();
}
const every = (min) => (min % 1440 === 0 ? (min / 1440) + 'd' : min % 60 === 0 ? (min / 60) + 't' : min + 'm');

/* ---------- state ---------- */
const signedInAs = document.body.dataset.signedIn || '';
const state = {
  summary: null,
  summaryError: null,
  sync: null,
  live: null,
  liveError: null,
  tools: null,
  recent: null,
  browse: { q: '', kind: '', range: '', items: [], offset: 0, more: false, loading: false, sel: null, detail: null, truncated: false },
  toolFilter: { q: '', access: 'alle', open: new Set() },
  syncOpen: new Set(),
  wasRunning: new Set(),
  gallery: { data: null, error: null, loading: false, stale: true, child: '', year: '', album: null, albumFor: null, albumError: null, albumLoading: false, lb: 0 },
};
const loggedIn = () => Boolean(state.summary && state.summary.login && state.summary.login.logged_in);
const database = () => (state.summary ? state.summary.database : null);
const statsOf = (kind) => ((database() && database().kinds) || []).find((k) => k.kind === kind);
const countOf = (kind) => (statsOf(kind) ? statsOf(kind).count : 0);
const totalCount = () => ((database() && database().kinds) || []).reduce((s, k) => s + k.count, 0);

async function loadSummary() {
  try { state.summary = await getJson('data/summary'); state.summaryError = null; }
  catch (err) { state.summaryError = err.message; }
}
async function loadSync() {
  try { state.sync = await getJson('data/sync'); }
  catch (err) { state.sync = { available: false, jobs: [], error: err.message }; }
}
async function loadLive(force) {
  if (state.live && !force) return;
  state.liveError = null;
  if (!loggedIn()) { state.live = null; return; }
  try { state.live = await getJson('data/live'); }
  catch (err) { state.live = null; state.liveError = err.message; }
}

/* ---------- shell ---------- */
const main = $('main');
function current() { const h = location.hash.slice(1).split('/')[0]; return VIEWS.some((v) => v.id === h) ? h : 'oversigt'; }
function go(id) { if (location.hash.slice(1) === id) route(); else location.hash = id; }
function navButton(v, cur, cls) {
  const count = v.id === 'gennemse' && database() ? el('span', { class: 'count' }, fmt(totalCount()))
    : v.id === 'sync' && state.summary && !loggedIn() ? el('span', { class: 'count', style: 'color:var(--warn)' }, 'venter') : null;
  return el('button', { class: cls + (v.danger ? ' danger' : ''), 'data-go': v.id, 'aria-current': v.id === cur ? 'page' : null },
    icon(v.icon), el('span', {}, v.label), count);
}
function renderNav(cur) {
  const side = [];
  for (const v of VIEWS) {
    if (v.id === 'slet') side.push(el('div', { class: 'nav-sep' }));
    side.push(navButton(v, cur, 'nav-item'));
  }
  fill($('sideNav'), ...side);
  const bottoms = VIEWS.filter((v) => v.bottom);
  const inMore = !bottoms.some((v) => v.id === cur);
  fill($('bottomNav'), 
    ...bottoms.map((v) => el('button', { 'data-go': v.id, 'aria-current': v.id === cur ? 'page' : null }, icon(v.icon), el('span', {}, v.short || v.label))),
    el('button', { id: 'moreBtn', 'aria-current': inMore ? 'page' : null, onclick: openMore }, icon('more'), el('span', {}, 'Mere')),
  );
  $('topSub').textContent = VIEWS.find((v) => v.id === cur).label;
}
function route() {
  const cur = current();
  if (cur === 'galleri' || cur === 'slet') state.gallery.stale = true;
  renderNav(cur);
  fill(main, el('div', { class: 'view' }, R[cur]()));
  if (window.innerWidth < 900) window.scrollTo(0, 0);
}
function rerender(view) { if (current() === view) { renderNav(view); fill(main, el('div', { class: 'view' }, R[view]())); } }
window.addEventListener('hashchange', route);

const head = (title, lede, action) => el('div', { class: 'view-head' },
  el('div', {}, el('h1', {}, title), lede ? el('p', { class: 'lede' }, lede) : null), action || null);
const banner = (kind, ic, ...body) => el('div', { class: 'banner ' + kind }, icon(ic), el('div', { class: 'grow' }, ...body));
const skeleton = () => el('section', { class: 'panel skel-panel' },
  el('div', { class: 'skeleton', style: 'width:40%' }), el('div', { class: 'skeleton', style: 'width:70%' }), el('div', { class: 'skeleton', style: 'width:55%' }));
const typeDot = (kind) => el('span', { class: 'type-dot' }, icon(kindOf(kind).icon));
const mitidButton = (label, primary) => el('button', { class: 'btn' + (primary ? ' btn-primary' : ''), onclick: openMitid }, icon('key'), label);
const storageOff = () => banner('info', 'info',
  el('p', {}, el('strong', {}, 'Lokal lagring er slået fra på denne server. '), 'aula-mcp henter alt live fra Aula og gemmer intet. Den slås til med ', el('code', {}, 'AULA_MCP_STORAGE=sqlite'), ' eller ', el('code', {}, 'postgres'), '.'));
const R = {};

/* ---------- oversigt ---------- */
function loginPanel() {
  if (!state.summary) return state.summaryError ? banner('warn', 'warn', el('p', {}, 'Kunne ikke hente status: ' + state.summaryError)) : skeleton();
  const login = state.summary.login;
  if (!login.logged_in) {
    return el('section', { class: 'banner warn', 'aria-label': 'Aula-login' }, icon('shieldX'), el('div', { class: 'grow' },
      el('h2', {}, 'Du er ikke logget ind på Aula'),
      el('p', {}, 'Log ind med MitID, så AI-assistenten kan læse fra Aula, og synkroniseringen kan hente nyt. Det, der allerede er gemt, er her stadig.'),
      el('div', { class: 'banner-actions' }, mitidButton('Log ind med MitID', true))));
  }
  const now = Date.now() / 1000;
  const expired = login.seconds_remaining <= 0;
  const span = Math.max(login.expires_at - login.saved_at, 1);
  const left = Math.min(Math.max((login.expires_at - now) / span, 0), 1);
  return el('section', { class: 'panel login-card', 'aria-label': 'Aula-login' },
    el('div', { class: 'seal' + (expired ? ' bad' : '') }, icon(expired ? 'shieldX' : 'shield')),
    el('div', { style: 'min-width:0' },
      el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
        el('h2', {}, 'Logget ind på Aula'),
        expired ? el('span', { class: 'pill warn' }, 'Adgangen er udløbet') : el('span', { class: 'pill ok' }, 'Aktivt')),
      el('div', { class: 'login-meta' },
        el('span', {}, expired ? 'Udløb ' : 'Adgang til ', el('strong', { class: 'num' }, rel(login.expires_at))),
        el('span', {}, 'Automatisk fornyelse ', el('strong', {}, login.auto_renew ? 'slået til' : 'slået fra')),
        login.auto_renew && login.renews_at ? el('span', {}, 'Næste fornyelse ', el('strong', { class: 'num' }, rel(login.renews_at))) : null,
        el('span', {}, 'MitID-bruger ', el('strong', {}, login.username || '–')),
        login.identity_name ? el('span', {}, 'Identitet ', el('strong', {}, login.identity_name)) : null),
      el('div', { class: 'time-track', title: 'Tid tilbage af adgangen' }, el('span', { style: 'width:' + Math.round(left * 100) + '%' })),
      el('p', { class: 'muted small', style: 'margin-top:6px' },
        login.auto_renew
          ? 'aula-mcp fornyer adgangen i baggrunden, så du ikke skal logge ind med MitID igen.'
          : 'Adgangen fornyes, næste gang den bruges.',
        ' Senest gemt ' + rel(login.saved_at) + '.')),
    el('div', { class: 'login-actions' }, mitidButton('Log ind igen'), el('button', { class: 'btn', onclick: askLogout }, 'Log ud af Aula')));
}
function kidsPanel() {
  if (!loggedIn()) return null;
  if (state.liveError) return el('p', { class: 'muted small' }, 'Kunne ikke hente dine børn fra Aula: ' + state.liveError);
  if (!state.live) return el('div', { class: 'grid-2' }, skeleton(), skeleton());
  if (!state.live.children.length) return null;
  return el('div', { class: 'grid-2' }, state.live.children.map((c) => el('section', { class: 'panel' },
    el('div', { class: 'kid' }, el('div', { class: 'kid-face', 'aria-hidden': 'true' }, (c.name || '?').slice(0, 1)),
      el('div', { style: 'min-width:0' }, el('h2', {}, c.name), el('div', { class: 'kid-meta' }, c.institution ? el('span', {}, c.institution) : null))))));
}
function syncPill() {
  const s = state.sync;
  if (!s || !s.available) return el('span', { class: 'pill neutral' }, 'Slået fra');
  if (!loggedIn()) return el('span', { class: 'pill warn' }, 'Venter på login');
  if (s.jobs.some((j) => j.running || j.queued)) return el('span', { class: 'pill run' }, 'Kører');
  const fails = s.jobs.filter((j) => j.ok === false).length;
  if (fails) return el('span', { class: 'pill err' }, plural(fails, 'fejl', 'fejl'));
  if (s.jobs.every((j) => j.ok === null)) return el('span', { class: 'pill neutral' }, 'Ikke kørt endnu');
  return el('span', { class: 'pill ok' }, 'Alt ok');
}
function itemRow(item, onclick) {
  const k = kindOf(item.kind);
  return el('button', { class: 'li', onclick },
    typeDot(item.kind),
    el('span', { style: 'min-width:0;display:block' },
      el('span', { class: 'li-title', style: 'display:block' }, item.unread ? el('span', { class: 'unread-dot' }, '● ') : null, item.title),
      el('span', { class: 'li-sub', style: 'display:block' }, [k.one, item.subtitle].filter(Boolean).join(' · '))),
    el('span', { class: 'result-date' }, rel(item.occurredAt || item.updatedAt)));
}
const openItem = (item) => {
  state.browse = Object.assign(state.browse, { q: '', kind: '', range: '', items: [], offset: 0, more: false, sel: item.kind + '/' + item.id, detail: null });
  go('gennemse');
};
R.oversigt = () => {
  const today = new Date().toLocaleDateString('da-DK', { weekday: 'long', day: 'numeric', month: 'long' });
  const first = (signedInAs || (state.summary && state.summary.login.identity_name) || '').split(' ')[0];
  const db = database();
  const recent = !db ? null : state.recent === null ? skeleton()
    : el('div', { class: 'list' }, state.recent.length ? state.recent.map((it) => itemRow(it, () => openItem(it))) : el('p', { class: 'empty' }, 'Intet gemt endnu. Den første synkronisering starter, når du er logget ind.'));
  return [
    el('div', { class: 'view-head' }, el('div', {},
      el('p', { class: 'eyebrow' }, today),
      el('h1', {}, first ? 'Hej ' + first : 'Oversigt'),
      el('p', { class: 'lede' }, 'Her kan du se, hvad aula-mcp har hentet fra Aula for din familie, og hvad din AI-assistent kan læse.'))),
    loginPanel(),
    kidsPanel(),
    db ? el('div', { class: 'stats' },
      el('div', { class: 'stat' }, el('span', { class: 'l' }, 'Gemt i alt'), el('span', { class: 'v' }, fmt(totalCount())), el('button', { class: 'linkish', 'data-go': 'gemt' }, 'Se hvad')),
      el('div', { class: 'stat' }, el('span', { class: 'l' }, 'Beskedtråde'), el('span', { class: 'v' }, fmt(countOf('message_thread'))), el('button', { class: 'linkish', 'data-go': 'gennemse' }, 'Gennemse')),
      el('div', { class: 'stat' }, el('span', { class: 'l' }, 'Synkronisering'), el('span', { class: 'v small-v' }, syncPill()), el('button', { class: 'linkish', 'data-go': 'sync' }, 'Se jobs')),
      galleryStat())
      : state.summary ? storageOff() : null,
    db ? el('section', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('h2', {}, 'Senest gemt'), el('button', { class: 'linkish', 'data-go': 'gennemse' }, 'Se alt')),
      recent) : null,
  ];
};

/* ---------- gemt om dig ---------- */
R.gemt = () => {
  if (!state.summary) return [head('Gemt om dig'), state.summaryError ? banner('warn', 'warn', el('p', {}, 'Kunne ikke hente: ' + state.summaryError)) : skeleton()];
  const db = database();
  const s = state.summary;
  const shown = Object.keys(KINDS).filter((k) => KINDS[k].synced || countOf(k) > 0);
  const max = Math.max(1, ...shown.map(countOf));
  const notYet = Object.keys(KINDS).filter((k) => !KINDS[k].synced && countOf(k) === 0).map((k) => KINDS[k].label);
  return [
    head('Gemt om dig', db
      ? 'aula-mcp gemmer en kopi af det, du kan se i Aula, så din assistent kan søge i det uden at spørge Aula hver gang.'
      : 'Her kan du se, hvad aula-mcp ved om dig, og hvor det ligger.'),
    db ? el('div', { class: 'grid-2' },
      el('section', { class: 'panel' },
        el('div', { class: 'panel-head' }, el('h2', {}, 'Lokal database'), el('span', { class: 'pill ok' }, 'Slået til')),
        el('dl', { class: 'kv' },
          el('dt', {}, 'Type'), el('dd', {}, db.type === 'postgres' ? 'PostgreSQL' : 'SQLite'),
          el('dt', {}, 'Placering'), el('dd', {}, el('code', {}, db.location)),
          el('dt', {}, 'Kryptering'), el('dd', {}, 'Ja, med en nøgle der kun gælder dig'),
          el('dt', {}, 'Gemt i alt'), el('dd', { class: 'num' }, fmt(totalCount())))),
      el('section', { class: 'panel' },
        el('div', { class: 'panel-head' }, el('h2', {}, 'Sådan passer vi på det')),
        el('div', { class: 'lock-list' },
          el('div', {}, icon('lock'), el('p', {}, el('strong', {}, 'Krypteret for dig alene. '), 'Indholdet krypteres med en nøgle, der kun gælder dig. En anden forælder på samme server kan ikke se dine data.')),
          el('div', {}, icon('db'), el('p', {}, el('strong', {}, 'Gemt, til du sletter det. '), 'Intet slettes automatisk. Du bestemmer selv under ', el('button', { class: 'linkish', 'data-go': 'slet' }, 'Slet data'), '.')),
          el('div', {}, icon('shield'), el('p', {}, el('strong', {}, 'Kun læsning. '), 'Synkronisering markerer aldrig noget som læst i Aula.')))))
      : storageOff(),
    db ? el('section', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('h2', {}, 'Antal pr. type'), el('span', { class: 'muted small num' }, fmt(totalCount()) + ' i alt')),
      el('div', { class: 'table-wrap' }, el('table', { class: 'count-table' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Type'), el('th', { class: 'hide-sm' }, 'Fordeling'), el('th', { class: 'n' }, 'Antal'), el('th', {}, 'Ældste'), el('th', { class: 'hide-sm' }, 'Nyeste'))),
        el('tbody', {}, shown.map((k) => {
          const st = statsOf(k);
          const n = countOf(k);
          return el('tr', {},
            el('td', {}, el('span', { class: 'kind-cell' }, typeDot(k), KINDS[k].label)),
            el('td', { class: 'barcell hide-sm' }, el('div', { class: 'minibar' }, el('span', { style: 'width:' + Math.round((n / max) * 100) + '%' }))),
            el('td', { class: 'n' }, fmt(n)),
            el('td', { class: 'num' }, st && st.oldest ? longDate(st.oldest) : '–'),
            el('td', { class: 'num hide-sm' }, st && st.newest ? longDate(st.newest) : '–'));
        })))),
      notYet.length ? el('p', { class: 'muted small', style: 'margin-top:12px' }, 'Hentes ikke endnu: ' + notYet.join(', ') + '. Assistenten læser dem live fra Aula.') : null) : null,
    el('section', { class: 'panel' },
      el('h2', { style: 'margin-bottom:10px' }, 'Det gemmer aula-mcp om dig'),
      s.stored.map((item) => el('div', { class: 'stored-item' },
        el('h3', {}, item.what), el('p', { class: 'muted small' }, 'Hvor: ', item.where), el('p', {}, item.detail)))),
    el('section', { class: 'panel' },
      el('h2', { style: 'margin-bottom:10px' }, 'Det gemmes ikke'),
      el('div', { class: 'list' }, s.not_stored.map((t) => el('div', { class: 'li', style: 'grid-template-columns:1fr' }, el('p', {}, t))))),
  ];
};

/* ---------- gennemse ---------- */
const RANGES = [['', 'Hele perioden'], ['7', 'Seneste 7 dage'], ['30', 'Seneste 30 dage'], ['kommende', 'Kommende']];
function browseQuery(offset) {
  const b = state.browse;
  const p = new URLSearchParams({ offset: String(offset), limit: '30' });
  if (b.kind) p.set('kind', b.kind);
  if (b.q.trim()) p.set('q', b.q.trim());
  const now = Math.floor(Date.now() / 1000);
  if (b.range === '7') { p.set('since', String(now - 7 * 86400)); p.set('until', String(now)); }
  if (b.range === '30') { p.set('since', String(now - 30 * 86400)); p.set('until', String(now)); }
  if (b.range === 'kommende') p.set('since', String(now));
  return 'data/items?' + p.toString();
}
let browseSeq = 0;
async function loadResults(append) {
  const b = state.browse;
  const seq = ++browseSeq;
  b.loading = true;
  if (!append) { b.items = []; b.offset = 0; }
  renderResults();
  try {
    const data = await getJson(browseQuery(append ? b.offset : 0));
    if (seq !== browseSeq) return;
    b.items = append ? b.items.concat(data.items) : data.items;
    b.offset = data.offset + data.items.length;
    b.more = data.more;
    b.truncated = Boolean(data.search_truncated);
    b.error = null;
  } catch (err) {
    if (seq !== browseSeq) return;
    b.error = err.message;
  }
  b.loading = false;
  renderResults();
}
async function loadDetail() {
  const b = state.browse;
  if (!b.sel) { renderDetail(); return; }
  const sel = b.sel;
  b.detail = null;
  renderDetail();
  const [kind, ...rest] = sel.split('/');
  try {
    const data = await getJson('data/items/' + encodeURIComponent(kind) + '/' + encodeURIComponent(rest.join('/')));
    if (b.sel === sel) b.detail = data;
  } catch (err) {
    if (b.sel === sel) b.detail = { error: err.message };
  }
  renderDetail();
}
R.gennemse = () => {
  if (state.summary && !database()) return [head('Gennemse'), storageOff()];
  const b = state.browse;
  const kinds = Object.keys(KINDS).filter((k) => countOf(k) > 0);
  let timer;
  const search = el('input', { class: 'input', id: 'q', type: 'search', placeholder: 'Søg i titler, afsendere og tekst', value: b.q,
    oninput: (e) => { b.q = e.target.value; clearTimeout(timer); timer = setTimeout(() => loadResults(false), 300); } });
  const range = el('select', { class: 'input', id: 'frange', onchange: (e) => { b.range = e.target.value; loadResults(false); } },
    RANGES.map(([v, l]) => el('option', { value: v, selected: b.range === v ? true : null }, l)));
  const chip = (value, label, n) => el('button', { class: 'chip', 'aria-pressed': String(b.kind === value),
    onclick: () => { b.kind = value; document.querySelectorAll('[data-fkind]').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.fkind === value))); loadResults(false); },
    'data-fkind': value }, label, el('span', { class: 'c' }, fmt(n)));
  queueMicrotask(() => { loadResults(false); loadDetail(); });
  return [
    head('Gennemse', 'Alt, aula-mcp har gemt for dig. Søgningen kører på den lokale kopi, så den virker også, når Aula er nede.'),
    el('section', { class: 'panel filters' },
      el('div', { class: 'filter-row' },
        el('div', { class: 'field' }, el('label', { for: 'q' }, 'Søg'), search),
        el('div', { class: 'field' }, el('label', { for: 'frange' }, 'Dato'), range)),
      el('div', { class: 'chips', role: 'group', 'aria-label': 'Type' },
        chip('', 'Alle', totalCount()), kinds.map((k) => chip(k, KINDS[k].label, countOf(k))))),
    el('div', { class: 'browse', id: 'browse' },
      el('section', { class: 'panel result-panel', style: 'padding:0', id: 'results' }),
      el('section', { class: 'panel detail', id: 'detail' })),
  ];
};
function renderResults() {
  const box = $('results'); if (!box) return;
  const b = state.browse;
  const title = b.loading && !b.items.length ? 'Henter…' : b.items.length ? 'Viser ' + fmt(b.items.length) + (b.more ? '+' : '') : 'Ingen resultater';
  const rows = b.items.map((it) => {
    const key = it.kind + '/' + it.id;
    return el('button', { class: 'result', 'aria-current': String(b.sel === key), onclick: () => selectItem(key) },
      typeDot(it.kind),
      el('span', { style: 'min-width:0;display:block' },
        el('span', { class: 'result-top' }, el('span', { class: 'li-title' }, it.unread ? el('span', { class: 'unread-dot' }, '● ') : null, it.title), el('span', { class: 'result-date' }, rel(it.occurredAt || it.updatedAt))),
        it.subtitle ? el('span', { class: 'li-sub', style: 'display:block' }, it.subtitle) : null,
        el('span', { class: 'result-foot' }, el('span', { class: 'tag' }, kindOf(it.kind).one))));
  });
  fill(box, 
    el('div', { class: 'panel-head', style: 'padding:14px 16px 0;margin-bottom:6px' }, el('h2', {}, title)),
    b.error ? el('p', { class: 'empty error-text' }, 'Kunne ikke hente: ' + b.error) : null,
    rows.length ? el('div', { class: 'result-list list' }, rows)
      : !b.loading && !b.error ? el('div', { class: 'empty' }, el('p', {}, el('strong', {}, 'Intet fundet.')), el('p', { class: 'small' }, 'Prøv et andet søgeord, eller vælg "Hele perioden".'),
        el('button', { class: 'btn btn-sm', onclick: () => { Object.assign(b, { q: '', kind: '', range: '' }); route(); } }, 'Nulstil filtre')) : null,
    b.truncated ? el('p', { class: 'muted small', style: 'padding:0 16px' }, 'Søgningen stoppede efter de nyeste 10.000 ting. Vælg en type eller en periode for at søge længere tilbage.') : null,
    b.more ? el('div', { class: 'more-row' }, el('button', { class: 'btn btn-sm', disabled: b.loading, onclick: () => loadResults(true) }, b.loading ? 'Henter…' : 'Vis flere')) : null);
}
function selectItem(key) {
  state.browse.sel = key;
  document.querySelectorAll('.result').forEach((r) => r.setAttribute('aria-current', 'false'));
  renderResults();
  loadDetail();
  if (window.innerWidth < 1100) window.scrollTo(0, $('browse').offsetTop - 80);
}
function attachList(names) {
  return names && names.length ? el('div', { class: 'attachments' }, names.map((n) => el('span', { class: 'attach' }, icon('clip'), n))) : null;
}
function renderDetail() {
  const box = $('detail'); const wrap = $('browse'); if (!box) return;
  const b = state.browse;
  wrap.classList.toggle('has-detail', Boolean(b.sel));
  if (!b.sel) {
    fill(box, el('div', { class: 'detail-empty' }, icon('search'), el('p', { style: 'margin-top:8px' }, 'Vælg en ting i listen for at se den her.')));
    return;
  }
  const back = el('button', { class: 'btn btn-sm back-btn', onclick: () => { b.sel = null; b.detail = null; renderResults(); renderDetail(); } }, icon('left'), 'Tilbage til listen');
  if (!b.detail) { fill(box, back, skeleton()); return; }
  if (b.detail.error) { fill(box, back, el('p', { class: 'error-text' }, 'Kunne ikke hente: ' + b.detail.error)); return; }
  const it = b.detail.item;
  const k = kindOf(it.kind);
  const msgs = b.detail.messages;
  fill(box, 
    back,
    el('p', { class: 'eyebrow' }, k.one),
    el('h2', { style: 'font-size:1.35rem;margin-top:4px;overflow-wrap:anywhere' }, it.title),
    el('div', { class: 'detail-meta' }, it.subtitle ? el('span', {}, it.subtitle) : null, el('span', {}, longDate(it.occurredAt || it.updatedAt))),
    it.fields.length ? el('dl', { class: 'kv' }, it.fields.map(([key, value]) => [el('dt', {}, key), el('dd', {}, value)])) : null,
    it.body ? el('p', { class: 'pre', style: 'max-width:65ch' }, it.body) : null,
    attachList(it.attachments),
    msgs ? (msgs.length
      ? el('div', {}, msgs.map((m) => el('div', { class: 'msg' },
          el('div', { class: 'avatar', 'aria-hidden': 'true' }, (m.from || '?').split(' ').map((w) => w.slice(0, 1)).join('').slice(0, 2)),
          el('div', { style: 'min-width:0' },
            el('div', { class: 'msg-head' }, el('strong', {}, m.from || 'Ukendt afsender'), el('span', { class: 'muted num' }, rel(m.at))),
            el('p', { class: 'msg-body pre' }, m.body),
            attachList(m.attachments)))))
      : el('p', { class: 'muted small' }, 'Beskederne i tråden er ikke hentet endnu. De kommer med næste synkronisering.')) : null,
    it.unread ? el('p', { class: 'muted small', style: 'margin-top:6px' }, 'Tråden står stadig som ulæst i Aula. aula-mcp ændrer det ikke.') : null,
    el('p', { class: 'muted small mono', style: 'margin-top:16px;overflow-wrap:anywhere' }, 'Opdateret ' + rel(it.updatedAt) + ' · id ' + it.kind + ':' + it.id));
}

/* ---------- sync ---------- */
function jobPill(j) {
  if (j.running) return el('span', { class: 'pill run' }, 'Kører');
  if (j.queued) return el('span', { class: 'pill run' }, 'I kø');
  if (!loggedIn()) return el('span', { class: 'pill warn' }, 'Venter på login');
  if (j.ok === null) return el('span', { class: 'pill neutral' }, 'Ikke kørt');
  return j.ok ? el('span', { class: 'pill ok' }, 'Ok') : el('span', { class: 'pill err' }, 'Fejl');
}
async function runJobs(jobs) {
  try {
    await postJson('data/sync/run', jobs ? { jobs } : {});
    await loadSync();
    rerender(current());
    pollSync();
  } catch (err) { toast('Kunne ikke starte: ' + err.message); }
}
R.sync = () => {
  const s = state.sync;
  const busy = s && s.jobs.some((j) => j.running || j.queued);
  const action = s && s.available ? el('button', { class: 'btn', disabled: !loggedIn() || busy, onclick: () => runJobs(null) }, icon('sync'), 'Kør alle nu') : null;
  const top = head('Synkronisering', 'aula-mcp henter nyt fra Aula med faste mellemrum, med dit eget login. Jobbene kører inde i serveren.', action);
  if (!s) return [top, skeleton()];
  if (!s.available) return [top, s.error ? banner('warn', 'warn', el('p', {}, 'Kunne ikke hente: ' + s.error)) : storageOff()];
  return [
    top,
    loggedIn() ? null : banner('warn', 'warn', el('p', {}, el('strong', {}, 'Jobbene venter på, at du logger ind på Aula. '), 'De starter selv, når du er logget ind.'),
      el('div', { class: 'banner-actions' }, mitidButton('Log ind med MitID', true))),
    banner('info', 'info', el('p', {}, el('strong', {}, 'Synkronisering markerer aldrig noget som læst i Aula. '), 'Beskeder og opslag står præcis, som du forlod dem.')),
    el('section', { class: 'panel' },
      el('div', { class: 'job-head' }, ['Job', 'Seneste', 'Næste', 'Hentet / ændret', 'Status', ''].map((t) => el('span', {}, t))),
      el('div', { class: 'jobs' }, s.jobs.map(jobRow))),
  ];
};
function jobRow(j) {
  const open = state.syncOpen.has(j.job);
  const toggle = () => { open ? state.syncOpen.delete(j.job) : state.syncOpen.add(j.job); rerender('sync'); };
  return el('div', { class: 'job', 'data-open': String(open) },
    el('div', { class: 'job-row' },
      el('button', { class: 'job-name', 'aria-expanded': String(open), onclick: toggle }, icon('chev', 'chev'),
        el('span', { style: 'min-width:0' }, el('strong', {}, jobLabel(j.job)), el('br'), el('span', { class: 'every' }, 'hver ' + every(j.intervalMinutes)))),
      el('div', { class: 'job-cells' },
        el('div', { class: 'jcell' }, el('span', { class: 'lbl' }, 'Seneste'), j.lastRunAt ? rel(j.lastRunAt) : '–'),
        el('div', { class: 'jcell' }, el('span', { class: 'lbl' }, 'Næste'), loggedIn() ? (j.nextRunAt ? rel(j.nextRunAt) : 'snart') : el('span', { class: 'muted' }, 'efter login')),
        el('div', { class: 'jcell' }, el('span', { class: 'lbl' }, 'Hentet / ændret'), fmt(j.fetched) + ' / ', el('strong', {}, fmt(j.changed)))),
      el('div', { class: 'job-status' }, jobPill(j)),
      el('div', { class: 'job-act' }, el('button', { class: 'btn btn-sm', disabled: j.running || j.queued || !loggedIn(), onclick: () => runJobs([j.job]) }, j.running || j.queued ? 'Kører…' : 'Kør nu'))),
    open ? el('div', { class: 'job-more' },
      el('p', {}, JOB_TEXT[j.job] || j.description),
      j.ok === false && j.lastError ? el('div', { class: 'errbox' }, el('strong', {}, 'Fejl ved seneste kørsel. '), j.lastError,
        j.failuresInARow > 1 ? ' (' + j.failuresInARow + ' gange i træk)' : '') : null,
      el('p', { class: 'muted small' }, 'Senest gennemført: ' + (j.lastSuccessAt ? rel(j.lastSuccessAt) : 'aldrig') + '. Henter kun nyt og ændret siden sidst.')) : null);
}
let pollTimer = null;
function pollSync() {
  clearTimeout(pollTimer);
  const s = state.sync;
  const busy = s && s.jobs.filter((j) => j.running || j.queued).map((j) => j.job);
  for (const job of state.wasRunning) {
    if (!busy || !busy.includes(job)) {
      const j = s && s.jobs.find((x) => x.job === job);
      if (j) toast(jobLabel(job) + (j.ok === false ? ' fejlede.' : ' er synkroniseret. ' + fmt(j.changed) + ' ændret.'));
    }
  }
  const finished = busy && [...state.wasRunning].some((job) => !busy.includes(job));
  const galleryDone = busy && state.wasRunning.has('gallery') && !busy.includes('gallery');
  state.wasRunning = new Set(busy || []);
  if (galleryDone && current() !== 'galleri') loadGallery();
  else if (galleryDone) state.gallery.stale = true;
  if (finished) { loadSummary().then(() => { renderNav(current()); if (current() !== 'gennemse') route(); }); }
  if (busy && busy.length) pollTimer = setTimeout(async () => { await loadSync(); rerender('sync'); rerender('oversigt'); rerender('galleri'); pollSync(); }, 2500);
}

/* ---------- galleri ---------- */
const GALLERY_LEDE = 'Billeder og videoer fra Aula, hentet i original kvalitet og ordnet pr. barn og år.';
const mediaUrl = (variant, albumId, mediaId, download) =>
  'data/gallery/' + variant + '/' + encodeURIComponent(String(albumId)) + '/' + encodeURIComponent(String(mediaId)) + (download ? '?download=1' : '');
const isVideo = (m) => String(m.type || '').toLowerCase().includes('video');
const galleryStatus = () => (state.gallery.data ? state.gallery.data.status : null);
const galleryJob = () => (state.sync && state.sync.jobs ? state.sync.jobs.find((j) => j.job === 'gallery') : null);
const galleryBusy = () => { const j = galleryJob(); return Boolean(j && (j.running || j.queued)); };
/** 2026-11-18 as 18. nov. 2026, without a trip through time zones. */
function dayText(ymd) {
  const [y, m, d] = String(ymd || '').split('-').map(Number);
  return y && m && d ? d + '. ' + MON[m - 1] + ' ' + y : 'Uden dato';
}
function albumInHash() {
  const part = location.hash.slice(1).split('/')[1];
  const id = Number(part);
  return part && Number.isSafeInteger(id) ? id : null;
}
async function loadGallery() {
  const g = state.gallery;
  g.loading = true;
  g.stale = false;
  const child = g.child;
  try {
    const d = await getJson('data/gallery' + (child ? '?child=' + encodeURIComponent(child) : ''));
    if (child === g.child) { g.data = d; g.error = null; } else g.stale = true;
  } catch (err) {
    g.error = { status: err.status, message: err.message };
  }
  g.loading = false;
  for (const view of ['galleri', 'oversigt', 'slet']) rerender(view);
}
async function loadAlbum(id) {
  const g = state.gallery;
  g.albumLoading = true;
  g.stale = false;
  if (g.albumFor !== id) { g.album = null; g.albumError = null; g.albumFor = id; }
  try {
    const d = await getJson('data/gallery/albums/' + encodeURIComponent(String(id)));
    if (g.albumFor === id) { g.album = d; g.albumError = null; }
  } catch (err) {
    if (g.albumFor === id) g.albumError = { status: err.status, message: err.message };
  }
  g.albumLoading = false;
  rerender('galleri');
}
const coverEmpty = (name) => icon(name || 'image');
/** A thumbnail that turns into the placeholder icon when the file is gone. */
const lazyImg = (src, fallback) => el('img', { src, alt: '', loading: 'lazy', decoding: 'async', onerror: (e) => e.target.replaceWith(coverEmpty(fallback)) });
function galleryStat() {
  const g = state.gallery;
  const st = galleryStatus();
  const link = el('button', { class: 'linkish', 'data-go': 'galleri' }, 'Se galleri');
  if (st) return el('div', { class: 'stat' }, el('span', { class: 'l' }, 'Galleri'), el('span', { class: 'v' }, fmt(st.downloaded)),
    el('span', { class: 'l num' }, 'af ' + fmt(st.media) + ' hentet · ' + size(st.bytes)), link);
  return el('div', { class: 'stat' }, el('span', { class: 'l' }, 'Galleri'),
    el('span', { class: 'v small-v' }, g.error ? el('span', { class: 'pill neutral' }, g.error.status === 404 ? 'Slået fra' : 'Ukendt') : '–'), link);
}
function galleryOff() {
  return el('section', { class: 'panel empty' },
    el('div', { class: 'empty-icon' }, icon('image')),
    el('h2', {}, 'Galleriet er ikke slået til'),
    el('p', { style: 'max-width:50ch' }, 'Galleriet bruger den lokale lagring på serveren. Når den er slået til med ', el('code', {}, 'AULA_MCP_STORAGE=sqlite'), ' eller ', el('code', {}, 'postgres'),
      ', henter aula-mcp billeder og videoer fra Aula og gemmer dem her, til du selv sletter dem.'));
}
function runGallery() {
  return el('button', { class: 'btn btn-primary', disabled: !loggedIn() || galleryBusy() || !(state.sync && state.sync.available),
    title: loggedIn() ? null : 'Log ind på Aula først', onclick: () => { runJobs(['gallery']); toast('Galleriet hentes nu.'); } },
  icon('sync'), galleryBusy() ? 'Henter…' : 'Hent nu');
}
function galleryPill(st) {
  if (galleryBusy()) return el('span', { class: 'pill run' }, 'Henter');
  if (!st.downloads) return el('span', { class: 'pill neutral' }, 'Filer hentes ikke');
  if (st.disk && st.disk.used >= st.stopAt) return el('span', { class: 'pill warn' }, 'Sat på pause');
  if (!loggedIn()) return el('span', { class: 'pill warn' }, 'Venter på login');
  if (st.sync && st.sync.failures > 0) return el('span', { class: 'pill err' }, 'Fejl');
  if (!st.sync) return el('span', { class: 'pill neutral' }, 'Ikke kørt endnu');
  if (st.waiting) return el('span', { class: 'pill neutral' }, fmt(st.waiting) + ' venter');
  return el('span', { class: 'pill ok' }, 'Alt hentet');
}
function storagePanel(st) {
  const disk = st.disk;
  const share = disk && disk.totalBytes ? Math.min(st.bytes / disk.totalBytes, disk.used) : 0;
  const w = (x) => (Math.min(Math.max(x, 0), 1) * 100).toFixed(2) + '%';
  return el('section', { class: 'panel' },
    el('div', { class: 'panel-head', style: 'margin-bottom:0' }, el('h2', {}, 'Plads'),
      el('span', { class: 'num' }, el('strong', {}, size(st.bytes)), el('span', { class: 'muted' }, ' i galleriet'))),
    disk ? [
      el('div', { class: 'storage-bar', role: 'img', 'aria-label': pct(disk.used) + ' af disken er brugt. Hentningen stopper ved ' + pct(st.stopAt) + '.' },
        el('div', { class: 'fill other', style: 'width:' + w(disk.used) }),
        el('div', { class: 'fill', style: 'width:' + w(share) }),
        el('div', { class: 'stop' + (st.stopAt < 0.25 ? ' low' : ''), style: 'left:' + w(st.stopAt) }, el('span', {}, 'stop ' + pct(st.stopAt)))),
      el('div', { class: 'legend' },
        el('span', {}, el('i', { style: 'background:var(--accent)' }), 'Galleri ' + size(st.bytes)),
        el('span', {}, el('i', { style: 'background:color-mix(in srgb, var(--muted) 45%, var(--surface-2))' }), 'Andet ' + size(Math.max(disk.totalBytes - disk.freeBytes - st.bytes, 0))),
        el('span', {}, el('i', { style: 'background:var(--surface-2);border:1px solid var(--line)' }), 'Fri ' + size(disk.freeBytes))),
      el('p', { class: 'muted small', style: 'margin-top:10px' }, 'Disken er ' + pct(disk.used) + ' fuld (' + size(disk.totalBytes - disk.freeBytes) + ' af ' + size(disk.totalBytes) + '). Når ' + pct(st.stopAt) + ' er brugt, holder hentningen pause. Intet slettes af sig selv.'),
    ] : el('p', { class: 'muted small', style: 'margin-top:12px' }, 'Kunne ikke læse, hvor meget plads der er på disken.'));
}
function downloadPanel(st) {
  const sync = st.sync;
  return el('section', { class: 'panel' },
    el('div', { class: 'panel-head' }, el('h2', {}, 'Hentning'), galleryPill(st)),
    el('dl', { class: 'kv' },
      el('dt', {}, 'Album'), el('dd', { class: 'num' }, fmt(st.albums)),
      el('dt', {}, 'Medier'), el('dd', { class: 'num' }, fmt(st.media)),
      el('dt', {}, 'Hentet'), el('dd', { class: 'num' }, el('strong', {}, fmt(st.downloaded)), st.media ? ' (' + pct(st.downloaded / st.media) + ')' : null),
      el('dt', {}, 'Venter'), el('dd', { class: 'num' }, fmt(st.waiting)),
      el('dt', {}, 'Fejlet'), el('dd', { class: 'num' + (st.failed ? ' error-text' : '') }, fmt(st.failed), st.failed ? el('span', { class: 'muted' }, ', prøves igen ved næste kørsel') : null),
      el('dt', {}, 'Seneste'), el('dd', { class: 'num' }, sync && sync.lastRunAt ? rel(sync.lastRunAt) : 'aldrig'),
      el('dt', {}, 'Næste'), el('dd', { class: 'num' }, !loggedIn() ? 'efter login' : sync && sync.nextRunAt ? rel(sync.nextRunAt) : 'snart')),
    sync && sync.failures > 0 && sync.lastError ? el('div', { class: 'errbox', style: 'margin-top:12px' }, el('strong', {}, 'Fejl ved seneste kørsel. '), sync.lastError,
      sync.failures > 1 ? ' (' + sync.failures + ' gange i træk)' : '') : null,
    el('p', { class: 'muted small', style: 'margin-top:12px' }, 'Op til 300 filer pr. kørsel. Et billede, der ligger i flere album, gemmes kun én gang på disken.'));
}
function albumCard(a) {
  const missing = a.mediaCount - a.downloaded;
  return el('button', { class: 'album', onclick: () => { location.hash = 'galleri/' + a.id; } },
    el('span', { class: 'album-cover' },
      a.coverMediaId !== null && a.coverMediaId !== undefined ? lazyImg(mediaUrl('thumb', a.id, a.coverMediaId)) : coverEmpty(),
      missing > 0 ? el('span', { class: 'dl-badge' }, fmt(missing) + ' venter') : null),
    el('span', { class: 'album-title' }, a.title),
    el('span', { class: 'album-sub' }, (a.date ? dayText(a.date) : 'Uden dato') + ' · ' + a.child),
    el('span', { class: 'album-sub num' }, fmt(a.downloaded) + ' af ' + fmt(a.mediaCount) + ' hentet' + (a.bytes ? ' · ' + size(a.bytes) : '')));
}
R.galleri = () => {
  const g = state.gallery;
  if (state.summary && !database()) return [head('Galleri', GALLERY_LEDE), galleryOff()];
  const albumId = albumInHash();
  if (albumId !== null) return albumView(albumId);
  if ((g.stale || (!g.data && !g.error)) && !g.loading) loadGallery();
  const top = head('Galleri', GALLERY_LEDE, g.data ? runGallery() : null);
  if (g.error && !g.data) return [top, g.error.status === 404 ? galleryOff() : banner('warn', 'warn', el('p', {}, 'Kunne ikke hente galleriet: ' + g.error.message))];
  if (!g.data) return [top, el('div', { class: 'grid-2' }, skeleton(), skeleton())];
  const st = g.data.status;
  const paused = st.disk && st.disk.used >= st.stopAt;
  const years = [...new Set(g.data.albums.map((a) => a.year).concat(g.year ? [g.year] : []))].sort().reverse();
  const list = g.data.albums.filter((a) => !g.year || a.year === g.year);
  const kids = st.children.filter((c) => c.albums > 0);
  const chip = (value, label, n) => el('button', { class: 'chip', 'aria-pressed': String(g.child === value),
    onclick: () => { if (g.child === value) return; g.child = value; g.stale = true; rerender('galleri'); } }, label, el('span', { class: 'c' }, fmt(n)));
  const year = el('select', { class: 'input', id: 'gyear', onchange: (e) => { g.year = e.target.value; rerender('galleri'); } },
    el('option', { value: '' }, 'Alle år'), years.map((y) => el('option', { value: y, selected: g.year === y ? true : null }, y)));
  return [
    top,
    !st.downloads ? banner('info', 'info', el('p', {}, el('strong', {}, 'Filerne hentes ikke på denne server. '), 'Albummene vises fra listen i Aula, men billeder og videoer bliver ikke gemt, så længe serveren kører med ', el('code', {}, 'AULA_MCP_GALLERY=0'), '.')) : null,
    st.downloads && paused ? banner('warn', 'warn', el('p', {}, el('strong', {}, 'Hentningen holder pause. '), 'Disken er ' + pct(st.disk.used) + ' fuld, og grænsen er ' + pct(st.stopAt) + '. Slet album her, eller giv serveren mere plads, så fortsætter den ved næste kørsel.')) : null,
    el('div', { class: 'grid-2' }, storagePanel(st), downloadPanel(st)),
    st.albums ? el('section', { class: 'panel filters' },
      el('div', { class: 'filter-row' },
        el('div', { class: 'field', role: 'group', 'aria-labelledby': 'gkidLabel' }, el('label', { id: 'gkidLabel' }, 'Barn'),
          el('div', { class: 'chips' }, chip('', 'Alle', st.albums), kids.map((c) => chip(c.child, c.child, c.albums)))),
        el('div', { class: 'field' }, el('label', { for: 'gyear' }, 'År'), year))) : null,
    !st.albums
      ? el('section', { class: 'panel empty' }, el('div', { class: 'empty-icon' }, icon('image')), el('h2', {}, 'Ingen album endnu'),
        el('p', { style: 'max-width:46ch' }, 'Galleriet bliver fyldt, når synkroniseringen har hentet album fra Aula. Den kører af sig selv, når du er logget ind.'))
      : list.length
        ? el('section', { 'aria-label': 'Album' },
          el('div', { class: 'panel-head' }, el('h2', {}, plural(list.length, 'album', 'album')), g.loading ? el('span', { class: 'muted small' }, 'Henter…') : null),
          el('div', { class: 'albums' }, list.map(albumCard)))
        : el('section', { class: 'panel empty' }, el('p', {}, el('strong', {}, 'Ingen album for det valg.')),
          el('button', { class: 'btn btn-sm', onclick: () => { g.child = ''; g.year = ''; g.stale = true; rerender('galleri'); } }, 'Nulstil filtre')),
    st.albums || st.downloaded ? el('section', { class: 'danger-zone' },
      el('h2', {}, 'Slet hele galleriet'),
      el('p', {}, 'Sletter den lokale kopi af alle ' + plural(st.albums, 'album', 'album') + ' (' + size(st.bytes) + ') på serveren. Intet slettes i Aula, og de slettede album hentes ikke igen.'),
      el('div', {}, el('button', { class: 'btn btn-danger', onclick: () => askGalleryDelete(null) }, icon('trash'), 'Slet hele galleriet'))) : null,
  ];
};
function albumView(id) {
  const g = state.gallery;
  if ((g.stale || g.albumFor !== id) && !g.albumLoading) loadAlbum(id);
  const back = el('div', {}, el('button', { class: 'btn btn-sm', onclick: () => { location.hash = 'galleri'; } }, icon('left'), 'Alle album'));
  if (g.albumFor === id && g.albumError && !g.album) {
    return [back, head('Album'), g.albumError.status === 404
      ? el('section', { class: 'panel empty' }, el('p', {}, el('strong', {}, 'Albummet findes ikke her.')), el('p', { class: 'small' }, 'Det er måske slettet fra Aula, eller linket er forkert.'))
      : banner('warn', 'warn', el('p', {}, 'Kunne ikke hente albummet: ' + g.albumError.message))];
  }
  const d = g.albumFor === id ? g.album : null;
  if (!d) return [back, skeleton()];
  const a = d.album;
  const media = d.media;
  const videos = media.filter(isVideo).length;
  const parts = [a.date ? dayText(a.date) : 'Uden dato', plural(media.length - videos, 'billede', 'billeder')];
  if (videos) parts.push(plural(videos, 'video', 'videoer'));
  if (!a.removed) parts.push(a.downloaded >= a.mediaCount ? 'alt er hentet' : fmt(a.downloaded) + ' af ' + fmt(a.mediaCount) + ' hentet');
  return [
    back,
    el('div', { class: 'view-head' },
      el('div', { style: 'min-width:0' },
        el('p', { class: 'eyebrow' }, a.child + ' · ' + a.year),
        el('h1', { style: 'overflow-wrap:anywhere' }, a.title),
        el('p', { class: 'lede' }, parts.join(' · '))),
      a.removed ? null : el('button', { class: 'btn btn-ghost-danger', onclick: () => askGalleryDelete(a) }, icon('trash'), 'Slet album')),
    a.removed ? banner('info', 'info', el('p', {}, el('strong', {}, 'Du har slettet den lokale kopi af dette album. '), 'Det ligger stadig i Aula, men aula-mcp henter det ikke igen.')) : null,
    el('section', { class: 'panel' },
      el('dl', { class: 'kv' },
        el('dt', {}, 'Oprettet af'), el('dd', {}, a.creator || '–'),
        el('dt', {}, 'Delt med'), el('dd', {}, a.groups.length ? a.groups.join(', ') : '–'),
        el('dt', {}, 'Hentet'), el('dd', { class: 'num' }, fmt(a.downloaded) + ' af ' + fmt(a.mediaCount) + (a.bytes ? ' · ' + size(a.bytes) : '')),
        el('dt', {}, 'Mappe'), el('dd', {}, el('code', {}, a.folder)))),
    media.length
      ? el('div', { class: 'media-grid' }, media.map((m, i) => thumbTile(a, m, i)))
      : el('section', { class: 'panel empty' }, el('p', {}, a.removed ? 'Filerne er slettet her.' : 'Ingen billeder eller videoer i albummet endnu.')),
  ];
}
function thumbTile(a, m, i) {
  const video = isVideo(m);
  const src = m.hasThumb ? mediaUrl('thumb', a.id, m.id) : m.downloaded && !video ? mediaUrl('file', a.id, m.id) : null;
  const what = (video ? 'Video ' : 'Billede ') + (i + 1);
  return el('button', { class: 'thumb', onclick: () => openLightbox(i),
    'aria-label': what + (m.downloaded ? '' : m.error ? ', kunne ikke hentes' : ', ikke hentet'),
    title: m.error ? 'Kunne ikke hentes: ' + m.error : m.title || m.name || null },
  src ? lazyImg(src, video ? 'play' : 'image') : coverEmpty(video ? 'play' : 'image'),
  video ? el('span', { class: 'vid' }, icon('play'), 'Video') : null,
  m.downloaded ? null : el('span', { class: 'queued' + (m.error ? ' failed' : '') }, m.error ? 'Fejlet' : 'Ikke hentet'));
}
function openLightbox(i) {
  state.gallery.lb = i;
  renderLightbox();
  const dlg = $('lightbox');
  if (!dlg.open) dlg.showModal();
}
function stepLightbox(step) {
  const d = state.gallery.album;
  const n = d ? d.media.length : 0;
  if (n < 2) return;
  state.gallery.lb = (state.gallery.lb + step + n) % n;
  renderLightbox();
}
function renderLightbox() {
  const d = state.gallery.album;
  const m = d && d.media[state.gallery.lb];
  if (!m) { $('lightbox').close(); return; }
  const a = d.album;
  const n = d.media.length;
  const video = isVideo(m);
  const file = mediaUrl('file', a.id, m.id);
  const name = m.title || m.name || (video ? 'Video' : 'Billede');
  $('lightbox').setAttribute('aria-label', name);
  const stage = m.downloaded
    ? video
      ? el('video', { src: file, controls: true, preload: 'metadata', playsinline: true })
      : el('img', { src: file, alt: 'Billede ' + (state.gallery.lb + 1) + ' fra ' + a.title })
    : el('div', { class: 'lb-missing' }, icon(video ? 'play' : 'image'),
      el('p', {}, el('strong', {}, m.error ? 'Filen kunne ikke hentes.' : 'Filen er ikke hentet endnu.')),
      el('p', { class: 'small' }, m.error ? m.error + '. Den prøves igen ved næste kørsel.' : 'Den kommer med en af de næste synkroniseringer.'));
  const meta = [m.created ? longDate(m.created) : null, m.downloaded && m.bytes ? size(m.bytes) : null, m.tags.length ? m.tags.join(', ') : null].filter(Boolean);
  fill($('lbBody'),
    el('div', { class: 'lb-stage' }, stage,
      n > 1 ? [el('button', { class: 'lb-nav lb-prev', 'aria-label': 'Forrige', onclick: () => stepLightbox(-1) }, icon('left')),
        el('button', { class: 'lb-nav lb-next', 'aria-label': 'Næste', onclick: () => stepLightbox(1) }, icon('chev'))] : null,
      el('button', { class: 'lb-close', 'aria-label': 'Luk', onclick: () => $('lightbox').close() }, icon('x'))),
    el('div', { class: 'lb-info' },
      el('div', { style: 'min-width:0' }, el('strong', {}, name), el('span', { class: 'muted num' }, ' · ' + (state.gallery.lb + 1) + ' af ' + n),
        meta.length ? el('div', { class: 'muted small' }, meta.join(' · ')) : null),
      m.downloaded ? el('a', { class: 'btn btn-sm', href: mediaUrl('file', a.id, m.id, true), download: true }, icon('download'), 'Hent fil') : null));
}
function askGalleryDelete(album) {
  const st = galleryStatus();
  confirmDialog({
    danger: true, typed: true, icon: 'trash',
    title: album ? 'Slet albummet her?' : 'Slet hele galleriet her?',
    ok: album ? 'Slet album' : 'Slet galleriet',
    body: [
      album
        ? el('p', {}, 'Den lokale kopi af ', el('strong', {}, album.title), ' slettes fra serveren: ' + plural(album.downloaded, 'fil', 'filer') + (album.bytes ? ', ' + size(album.bytes) : '') + '.')
        : el('p', {}, st ? 'Den lokale kopi af alle ' + plural(st.albums, 'album', 'album') + ' og ' + plural(st.downloaded, 'fil', 'filer') + ' (' + size(st.bytes) + ') slettes fra serveren.' : 'Den lokale kopi af alle album og filer slettes fra serveren.'),
      el('p', {}, el('strong', {}, 'Intet slettes i Aula. '), album
        ? 'Albummet er der stadig, men aula-mcp henter det ikke igen.'
        : 'Albummene er der stadig, men de slettede album hentes ikke igen. Nye album i Aula hentes stadig.'),
      el('p', {}, el('strong', {}, 'Det kan ikke fortrydes.')),
    ],
    onok: async () => {
      try {
        const res = await postJson('data/gallery/delete', album ? { confirm: 'SLET', albumId: album.id } : { confirm: 'SLET', all: true });
        toast(plural(res.deleted.albums, 'album', 'album') + ' og ' + plural(res.deleted.files, 'fil', 'filer') + ' slettet her.');
        state.gallery.stale = true;
        state.gallery.albumFor = null;
        await loadSummary();
        if (albumInHash() !== null) location.hash = 'galleri'; else route();
      } catch (err) { toast('Kunne ikke slette: ' + err.message); }
    },
  });
}

/* ---------- værktøjer ---------- */
const ACC = { read: 'læse', write: 'skrive', raw: 'rå' };
const GROUPS = {
  discover: 'Overblik', profiles: 'Overblik', groups: 'Klasser og kontakter', contacts: 'Klasser og kontakter',
  messages: 'Beskeder', calendar: 'Kalender', presence: 'Fremmøde og komme/gå', posts: 'Opslag og notifikationer',
  notifications: 'Opslag og notifikationer', utils: 'Filer', sync: 'Synkronisering', local: 'Lokal data',
  my_data: 'Lokal data', raw_request: 'Rå adgang', login: 'Login',
};
const groupOf = (name) => { const part = name.split(/[._]/)[1] || name; return GROUPS[part] || GROUPS[name.split('.')[1]] || 'Ugeplaner og lektier'; };
R.vaerktoejer = () => {
  if (!state.tools) {
    getJson('data/tools').then((d) => { state.tools = d.tools; rerender('vaerktoejer'); }).catch((err) => { state.tools = []; toast('Kunne ikke hente værktøjer: ' + err.message); });
    return [head('Værktøjer'), skeleton()];
  }
  const all = state.tools;
  const on = all.filter((t) => t.enabled).length;
  const f = state.toolFilter;
  const list = el('div', { id: 'toolList' });
  const search = el('input', { class: 'input', id: 'tq', type: 'search', placeholder: 'Søg i ' + all.length + ' værktøjer, fx kalender eller sick', value: f.q,
    oninput: (e) => { f.q = e.target.value; renderTools(list); } });
  const chips = [['alle', 'Alle'], ['read', 'Læse'], ['write', 'Skrive'], ['raw', 'Rå'], ['off', 'Slået fra']].map(([v, l]) =>
    el('button', { class: 'chip', 'data-tacc': v, 'aria-pressed': String(f.access === v),
      onclick: () => { f.access = v; document.querySelectorAll('[data-tacc]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tacc === v))); renderTools(list); } }, l));
  renderTools(list);
  return [
    el('div', { class: 'view-head' }, el('div', {},
      el('h1', {}, 'Værktøjer'),
      el('p', { class: 'eyebrow', style: 'margin-top:6px' }, on + ' af ' + all.length + ' aktive'),
      el('p', { class: 'lede' }, 'Det er de værktøjer, din AI-assistent kan kalde. Læseværktøjer er altid til, skriveværktøjer kun hvis serveren tillader det.'))),
    el('section', { class: 'panel filters' },
      el('div', { class: 'field' }, el('label', { for: 'tq' }, 'Søg'), search),
      el('div', { class: 'chips', role: 'group', 'aria-label': 'Adgang' }, chips)),
    list,
  ];
};
function renderTools(box) {
  const f = state.toolFilter;
  const q = f.q.trim().toLowerCase();
  const tools = state.tools.filter((t) => (f.access === 'alle' || (f.access === 'off' ? !t.enabled : t.access === f.access)) &&
    (!q || (t.name + ' ' + (t.title || '') + ' ' + t.description).toLowerCase().includes(q)));
  const groups = new Map();
  for (const t of tools) { const g = groupOf(t.name); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(t); }
  if (!tools.length) { fill(box, el('section', { class: 'panel empty' }, el('p', {}, el('strong', {}, 'Ingen værktøjer passer.')), el('p', { class: 'small' }, 'Prøv et andet søgeord.'))); return; }
  fill(box, ...[...groups].map(([label, list]) => el('section', { class: 'tool-group' },
    el('div', { class: 'tool-group-head' }, el('h2', {}, label), el('span', { class: 'muted small' }, list.filter((t) => t.enabled).length + ' af ' + list.length + ' aktive')),
    list.map((t) => toolCard(t, box)))));
}
function toolCard(t, box) {
  const open = state.toolFilter.open.has(t.name);
  const toggle = () => { open ? state.toolFilter.open.delete(t.name) : state.toolFilter.open.add(t.name); renderTools(box); };
  return el('div', { class: 'tool', 'data-open': String(open) },
    el('button', { class: 'tool-sum', 'aria-expanded': String(open), onclick: toggle }, icon('chev', 'chev'),
      el('span', { style: 'min-width:0;display:grid' }, el('span', { class: 'tool-name' }, t.name), t.title ? el('span', { class: 'tool-title' }, t.title) : null),
      el('span', { class: 'tool-badges' }, el('span', { class: 'tag ' + t.access }, ACC[t.access] || t.access), el('span', { class: 'onoff ' + (t.enabled ? 'on' : 'off') }, t.enabled ? '● til' : '○ fra'))),
    open ? el('div', { class: 'tool-body' },
      el('p', { class: 'pre' }, t.description),
      el('div', { class: 'enable-note' }, t.enabled
        ? [el('strong', {}, 'Slået til. '), t.access === 'write' ? 'Værktøjet ændrer noget i Aula.' : t.access === 'raw' ? 'Giver adgang til hele Aulas API.' : 'Læser fra Aula eller den lokale kopi.']
        : [el('strong', {}, 'Slået fra. '), t.enableWith ? ['Serveren skal startes med ', el('code', {}, t.enableWith), '.'] : 'Serveren har ikke slået det til.']),
      t.parameters.length
        ? el('div', { class: 'table-wrap' }, el('table', { class: 'params' },
            el('thead', {}, el('tr', {}, ['Parameter', 'Type', 'Påkrævet', 'Beskrivelse'].map((h) => el('th', {}, h)))),
            el('tbody', {}, t.parameters.map((p) => el('tr', {}, el('td', {}, el('code', {}, p.name)), el('td', { class: 'muted' }, p.type), el('td', {}, p.required ? 'ja' : 'nej'), el('td', {}, p.description || ''))))))
        : el('p', { class: 'muted small' }, 'Ingen parametre.')) : null);
}

/* ---------- live ---------- */
R.live = () => {
  const reload = el('button', { class: 'btn', disabled: !loggedIn(), onclick: async () => { state.live = null; rerender('live'); await loadLive(true); rerender('live'); } }, icon('sync'), 'Hent igen');
  const top = head('Live fra Aula', null, reload);
  top.firstChild.append(el('p', { class: 'lede' }, 'Hentet fra Aula lige nu med dit eget login, præcis som assistenten ser det, når den kalder ', el('code', {}, 'aula.discover'), '. Intet herfra gemmes.'));
  if (state.summary && !loggedIn()) return [top, banner('warn', 'shieldX', el('p', {}, el('strong', {}, 'Kan ikke hente live. '), 'Du er ikke logget ind på Aula.'), el('div', { class: 'banner-actions' }, mitidButton('Log ind med MitID', true)))];
  if (state.liveError) return [top, banner('warn', 'warn', el('p', {}, 'Kunne ikke hente fra Aula: ' + state.liveError))];
  if (!state.live) {
    if (state.summary) loadLive().then(() => rerender('live'));
    return [top, skeleton()];
  }
  const d = state.live;
  return [
    top,
    el('div', { class: 'grid-2' },
      el('section', { class: 'panel' }, el('p', { class: 'eyebrow' }, 'Forælder'), el('h2', { style: 'margin-top:4px' }, d.user.name || 'Ukendt bruger'),
        el('p', { class: 'muted small' }, [d.user.identityName ? 'Identitet: ' + d.user.identityName : null, 'MitID-bruger: ' + d.user.username].filter(Boolean).join(' · '))),
      el('section', { class: 'panel' }, el('p', { class: 'eyebrow' }, 'Børn (' + d.children.length + ')'),
        el('div', { class: 'list', style: 'margin-top:4px' }, d.children.map((c) => el('div', { class: 'li', style: 'grid-template-columns:auto 1fr;padding:8px 0' },
          el('span', { class: 'kid-face', style: 'width:30px;height:30px;font-size:.9rem;border-radius:9px' }, (c.name || '?').slice(0, 1)),
          el('div', {}, el('strong', {}, c.name), c.institution ? el('div', { class: 'li-sub' }, c.institution) : null)))))),
    el('section', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('h2', {}, 'Det kan assistenten læse')),
      el('div', { class: 'list' }, d.capabilities.map((c) => el('div', { class: 'cap' }, el('h3', {}, c.area), el('p', { class: 'muted small' }, c.summary),
        el('div', { class: 'cap-tools' }, c.tools.map((t) => el('code', {}, t)))))),
      d.detected_widgets.length ? el('p', { class: 'muted small', style: 'margin-top:8px' }, 'Skole-widgets fundet: ', d.detected_widgets.join(', ')) : null),
  ];
};

/* ---------- slet ---------- */
R.slet = () => {
  if (!state.summary) return [head('Slet data'), skeleton()];
  if (!database()) return [head('Slet data'), storageOff()];
  const kinds = Object.keys(KINDS).filter((k) => !k.startsWith('gallery_') && (KINDS[k].synced || countOf(k) > 0));
  const g = state.gallery;
  if ((g.stale || (!g.data && !g.error)) && !g.loading) loadGallery();
  const gst = galleryStatus();
  const galleryRow = g.error && !gst ? null : el('div', { class: 'del-row' },
    el('div', { class: 'del-name' }, typeDot('gallery_album'), el('div', { style: 'min-width:0' }, el('strong', {}, 'Galleri'),
      el('div', { class: 'li-sub num' }, !gst ? 'Henter…' : gst.albums ? plural(gst.albums, 'album', 'album') + ' · ' + plural(gst.downloaded, 'fil', 'filer') + ' · ' + size(gst.bytes) + '. Hentes ikke igen.' : 'Intet gemt'))),
    el('button', { class: 'btn btn-sm btn-ghost-danger', disabled: !gst || !(gst.albums || gst.downloaded), onclick: () => askGalleryDelete(null) }, icon('trash'), 'Slet'));
  return [
    head('Slet data', 'Sletter din lokale kopi hos aula-mcp. Det rører ikke noget i Aula. Næste synkronisering henter det, Aula stadig har, igen.'),
    el('section', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('h2', {}, 'Slet en type')),
      el('div', { class: 'list' }, galleryRow, kinds.map((k) => {
        const st = statsOf(k);
        const n = countOf(k);
        return el('div', { class: 'del-row' },
          el('div', { class: 'del-name' }, typeDot(k), el('div', { style: 'min-width:0' }, el('strong', {}, KINDS[k].label),
            el('div', { class: 'li-sub num' }, n ? fmt(n) + ' gemt' + (st.oldest ? ' · ' + longDate(st.oldest) + ' til ' + longDate(st.newest) : '') : 'Intet gemt'))),
          el('button', { class: 'btn btn-sm btn-ghost-danger', disabled: !n, onclick: () => askDelete(k) }, icon('trash'), 'Slet'));
      }))),
    el('section', { class: 'danger-zone' },
      el('h2', {}, 'Slet alt'),
      el('p', {}, 'Sletter alle ' + fmt(totalCount()) + ' gemte ting. Dit Aula-login og dine indstillinger bliver. Det kan ikke fortrydes.'),
      el('div', {}, el('button', { class: 'btn btn-danger', disabled: !totalCount(), onclick: () => askDelete(null) }, icon('trash'), 'Slet alle mine data'))),
  ];
};
function confirmDialog(opts) {
  const form = $('confirmForm');
  const input = opts.typed ? el('input', { class: 'input', id: 'confirmText', autocomplete: 'off', placeholder: 'SLET' }) : null;
  const goBtn = el('button', { class: 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary'), value: 'ok', disabled: Boolean(opts.typed) }, opts.ok);
  if (input) input.addEventListener('input', () => { goBtn.disabled = input.value.trim().toUpperCase() !== 'SLET'; });
  fill(form, 
    el('div', { class: 'dlg-icon' + (opts.danger ? '' : ' calm') }, icon(opts.icon)),
    el('h2', { id: 'confirmTitle' }, opts.title),
    opts.body,
    input ? el('div', { class: 'field' }, el('label', { for: 'confirmText' }, 'Skriv SLET for at bekræfte'), input) : null,
    el('div', { class: 'dlg-actions' }, el('button', { class: 'btn', value: 'cancel', formnovalidate: true }, 'Annuller'), goBtn));
  const dlg = $('confirmDlg');
  dlg.returnValue = '';
  dlg.onclose = () => { if (dlg.returnValue === 'ok') opts.onok(); };
  dlg.showModal();
  setTimeout(() => (input || form.querySelector('button[value="cancel"]')).focus(), 30);
}
function askDelete(kind) {
  const n = kind ? countOf(kind) : totalCount();
  const what = kind ? KINDS[kind].label.toLowerCase() : 'alle dine data';
  const counted = kind && n === 1 ? KINDS[kind].one.toLowerCase() : what;
  confirmDialog({
    danger: true, typed: true, icon: 'trash',
    title: kind ? 'Slet ' + fmt(n) + ' ' + counted + '?' : 'Slet alle dine data?',
    ok: kind ? 'Slet ' + counted : 'Slet alt for altid',
    body: [
      el('p', {}, kind ? (n === 1 ? 'Den gemte kopi slettes fra aula-mcp.' : 'Alle gemte ' + what + ' slettes fra aula-mcp.') : 'Alle ' + fmt(n) + ' gemte ting slettes fra aula-mcp, også galleriets billeder og videoer.'),
      el('p', {}, el('strong', {}, 'Det kan ikke fortrydes. '), 'Det, Aula stadig har, kan hentes igen ved næste synkronisering. Det, Aula har slettet, er væk for altid.'),
    ],
    onok: async () => {
      try {
        const res = await postJson('data/delete', kind ? { kind, confirm: 'SLET' } : { all: true, confirm: 'SLET' });
        await loadSummary();
        state.recent = null;
        state.gallery.stale = true;
        route();
        toast(plural(res.deleted, 'ting', 'ting') + ' slettet.');
      } catch (err) { toast('Kunne ikke slette: ' + err.message); }
    },
  });
}
function askLogout() {
  confirmDialog({
    icon: 'key', title: 'Log ud af Aula?', ok: 'Log ud',
    body: el('p', {}, 'Adgangsnøglerne til din Aula-konto slettes fra serveren. Assistenten og synkroniseringen kan ikke læse fra Aula, før du logger ind med MitID igen. Det, der er gemt, bliver.'),
    onok: async () => {
      await fetch('logout', { method: 'POST' }).catch(() => {});
      state.live = null;
      await Promise.all([loadSummary(), loadSync()]);
      route();
      toast('Du er logget ud af Aula.');
    },
  });
}

/* ---------- MitID login ---------- */
let source = null;
function closeSource() { if (source) { source.close(); source = null; } }
function mitidStep(...nodes) { fill($('mitidBody'), ...nodes); }
const cancelBtn = (label) => el('button', { class: 'btn', onclick: () => $('mitidDlg').close() }, label || 'Annuller');
function openMitid() {
  const login = state.summary && state.summary.login;
  const input = el('input', { class: 'input', id: 'mitidUser', autocomplete: 'username', placeholder: 'dit MitID-brugernavn', value: (login && login.username) || '' });
  const start = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Start login');
  const form = el('form', { style: 'display:grid;gap:14px', onsubmit: (e) => { e.preventDefault(); const u = input.value.trim(); if (!u) { input.focus(); return; } startLogin(u); } },
    el('div', { class: 'field' }, el('label', { for: 'mitidUser' }, 'MitID-brugernavn'), input),
    el('div', { class: 'dlg-actions' }, cancelBtn(), start));
  mitidStep(
    el('div', { class: 'dlg-icon calm' }, icon('key')),
    el('h2', { id: 'mitidTitle' }, 'Log ind med MitID'),
    el('p', {}, 'Du scanner en QR-kode med MitID-appen. Login kører på serveren, og kun adgangsnøglen fra Aula gemmes, krypteret.'),
    form);
  const dlg = $('mitidDlg');
  dlg.onclose = closeSource;
  if (!dlg.open) dlg.showModal();
  setTimeout(() => input.focus(), 30);
}
const svgImg = (svg, alt) => el('img', { src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), alt });
function waiting(text, ...extra) {
  mitidStep(el('div', { class: 'dlg-icon calm' }, icon('key')), el('h2', { id: 'mitidTitle' }, 'Log ind med MitID'),
    ...extra, el('p', { class: 'muted small', style: 'text-align:center' }, el('span', { class: 'pill run' }, text)), el('div', { class: 'dlg-actions' }, cancelBtn()));
}
function loginFailed(message) {
  closeSource();
  mitidStep(el('div', { class: 'dlg-icon' }, icon('warn')), el('h2', { id: 'mitidTitle' }, 'Login fejlede'), el('p', {}, message),
    el('div', { class: 'dlg-actions' }, cancelBtn('Luk'), el('button', { class: 'btn btn-primary', onclick: openMitid }, 'Prøv igen')));
}
async function startLogin(username) {
  closeSource();
  waiting('Starter login…');
  let sessionId;
  try { sessionId = (await postJson('login/start', { username })).sessionId; }
  catch (err) { loginFailed('Kunne ikke starte login: ' + err.message); return; }
  const es = new EventSource('login/events?sessionId=' + encodeURIComponent(sessionId));
  source = es;
  const data = (ev) => { try { return JSON.parse(ev.data); } catch { return {}; } };
  es.addEventListener('qr', (ev) => {
    const d = data(ev);
    waiting('Venter på MitID-appen', el('p', {}, 'Åbn MitID-appen og scan en af koderne. De skifter af sig selv.'),
      el('div', { class: 'qr-pair' }, el('div', { class: 'qr' }, svgImg(d.svg1 || '', 'QR-kode til MitID')), el('div', { class: 'qr' }, svgImg(d.svg2 || '', 'QR-kode til MitID'))));
  });
  es.addEventListener('otp', (ev) => {
    waiting('Venter på MitID-appen', el('p', {}, 'Indtast koden i MitID-appen.'), el('p', { class: 'otp' }, String(data(ev).code || '')));
  });
  es.addEventListener('verified', () => waiting('Godkend i MitID-appen', el('p', {}, 'Godkend login i MitID-appen.')));
  es.addEventListener('identity', (ev) => {
    const options = data(ev).options || [];
    mitidStep(el('div', { class: 'dlg-icon calm' }, icon('person')), el('h2', { id: 'mitidTitle' }, 'Vælg identitet'),
      el('p', {}, 'Du har flere identiteter. Vælg den, der hører til Aula.'),
      el('div', { class: 'identity-options' }, options.map((o) => el('button', { class: 'btn', onclick: async () => {
        waiting('Vælger ' + o.name + '…');
        await fetch('login/identity?sessionId=' + encodeURIComponent(sessionId), {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ index: o.index }),
        }).catch(() => {});
      } }, o.name))),
      el('div', { class: 'dlg-actions' }, cancelBtn()));
  });
  es.addEventListener('identity-selected', () => waiting('Fortsætter…'));
  es.addEventListener('success', async (ev) => {
    const d = data(ev);
    closeSource();
    mitidStep(el('div', { class: 'dlg-icon calm' }, icon('shield')), el('h2', { id: 'mitidTitle' }, 'Du er logget ind'),
      el('p', {}, (d.identityName ? 'Identitet: ' + d.identityName + '. ' : '') + 'Adgangen gælder nu, og synkroniseringen henter nyt om lidt.'),
      el('div', { class: 'dlg-actions' }, el('button', { class: 'btn btn-primary', onclick: () => $('mitidDlg').close() }, 'Færdig')));
    state.live = null; state.liveError = null;
    await Promise.all([loadSummary(), loadSync()]);
    loadLive().then(() => rerender('oversigt'));
    route();
  });
  es.addEventListener('error', (ev) => {
    if (!ev.data) { if (es.readyState === EventSource.CLOSED && source === es) loginFailed('Forbindelsen blev afbrudt.'); return; }
    loginFailed(data(ev).message || 'Ukendt fejl.');
  });
}

/* ---------- misc ---------- */
let toastTimer;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3200); }
function setTheme(t) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  document.querySelectorAll('#themeSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.t === t)));
  fill($('themeBtn'), icon(isDark() ? 'sun' : 'moon'));
  try { localStorage.setItem('aulamcp-theme', t); } catch (e) {}
}
function isDark() { const a = document.documentElement.getAttribute('data-theme'); return a ? a === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; }
function openMore() {
  const cur = current();
  fill($('moreBody'), 
    el('div', { class: 'panel-head', style: 'margin:0' }, el('h2', {}, 'Mere'), el('button', { class: 'icon-btn', 'aria-label': 'Luk', onclick: () => $('moreDlg').close() }, icon('x'))),
    el('div', { class: 'nav-list' }, VIEWS.filter((v) => !v.bottom).map((v) => navButton(v, cur, 'nav-item'))),
    signedInAs ? [el('div', { class: 'nav-sep' }), el('form', { method: 'post', action: '/auth/logout', style: 'margin:0' },
      el('p', { class: 'muted small', style: 'margin-bottom:8px' }, 'Logget ind som ', el('strong', {}, signedInAs)), el('button', { class: 'btn btn-sm', type: 'submit' }, 'Log af'))] : null);
  $('moreDlg').showModal();
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-go], [data-t]'); if (!t) return;
  if (t.dataset.go) { const m = $('moreDlg'); if (m.open) m.close(); go(t.dataset.go); return; }
  if (t.dataset.t) setTheme(t.dataset.t);
});
$('themeBtn').addEventListener('click', () => setTheme(isDark() ? 'light' : 'dark'));
['moreDlg', 'confirmDlg', 'mitidDlg', 'lightbox'].forEach((id) => {
  const dlg = $(id);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close('cancel'); });
});
// Escape closes the dialog by itself; the arrows step through the album.
document.addEventListener('keydown', (e) => {
  if (!$('lightbox').open) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); stepLightbox(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); stepLightbox(1); }
});
// Emptied on close so a playing video stops.
$('lightbox').addEventListener('close', () => fill($('lbBody')));

let theme = 'system';
try { theme = localStorage.getItem('aulamcp-theme') || 'system'; } catch (e) {}
setTheme(theme === 'light' || theme === 'dark' ? theme : 'system');
route();
(async () => {
  await Promise.all([loadSummary(), loadSync()]);
  route();
  pollSync();
  if (database()) {
    if (!state.gallery.data && !state.gallery.loading) loadGallery();
    getJson('data/items?limit=5').then((d) => { state.recent = d.items; }).catch(() => { state.recent = []; }).then(() => rerender('oversigt'));
  }
  if (loggedIn()) { await loadLive(); rerender('oversigt'); }
})();
})();
`;
