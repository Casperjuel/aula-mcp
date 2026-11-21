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
.view-pick { display: grid; gap: 4px; margin: 0 4px 12px; }
.share-form { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.share-form .input { flex: 1 1 240px; }
.share-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 0; border-top: 1px solid var(--line); }
.share-row:first-child { border-top: 0; }
.share-row .grow { flex: 1 1 200px; min-width: 0; overflow-wrap: anywhere; }

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
.tag.files { display: inline-flex; align-items: center; gap: 4px; }
.tag.files svg { width: 13px; height: 13px; }
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

.kid { display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: center; }
.kid-face { width: 46px; height: 46px; border-radius: 14px; display: grid; place-items: center; font-family: var(--font-display); font-weight: 650; font-size: 1.15rem; background: var(--accent-soft); color: var(--accent); }
.kid-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--muted); font-size: .86rem; }
.kid-meta .pill { font-size: .74rem; }
.kid-today { margin: 10px 0 0; color: var(--muted); font-size: .86rem; }
.menu-li { align-items: center; }
.menu-li .type-dot { background: var(--accent-soft); color: var(--accent); }
.menu-li.danger .type-dot { background: var(--err-soft); color: var(--err); }
.menu-li > svg { width: 16px; height: 16px; color: var(--muted); }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 520px) { .form-grid { grid-template-columns: 1fr; } }

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
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.attach-table { margin-top: 12px; }
.attach-media { margin-top: 12px; }
#detail .attach-media { max-width: 560px; }
.attach-prev { border: 0; padding: 0; cursor: pointer; }
.day-group { margin-top: 18px; display: grid; gap: 8px; justify-items: start; }
.day-group > .list, .day-group > .media-grid { width: 100%; }
.day-group-head { display: flex; gap: 8px; align-items: center; font-size: .95rem; margin: 0; }
.day-group-head svg { width: 16px; height: 16px; flex: none; }
.day-item { width: 100%; }
.attach-table td { overflow-wrap: anywhere; }
.attach-table .prev { width: 64px; }
.attach-prev { width: 56px; height: 56px; border-radius: 8px; overflow: hidden; display: grid; place-items: center; background: var(--surface-2); color: var(--muted); }
.attach-prev img { width: 100%; height: 100%; object-fit: cover; display: block; }
.attach-prev svg, .attach-acts svg { width: 16px; height: 16px; flex: none; }
.attach-acts { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.attach-table td.acts { text-align: right; white-space: nowrap; }
@media (max-width: 560px) { .attach-table .col-type { display: none; } .attach-table td.acts { white-space: normal; } }
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

/* kalender and sender roles: a calm hue per event type and per role */
:root {
  --hue-blue: #2f5f9e; --hue-blue-soft: #e2ebf7; --hue-teal: #1f7373; --hue-teal-soft: #dbefee;
  --hue-violet: #6b4fa0; --hue-violet-soft: #ece6f5; --hue-rose: #a83b56; --hue-rose-soft: #f6e1e7;
  --hue-sand: #76603c; --hue-sand-soft: #efe8db;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --hue-blue: #8fb4e8; --hue-blue-soft: #1c2a3d; --hue-teal: #6cc8c4; --hue-teal-soft: #15302f;
    --hue-violet: #b9a3e3; --hue-violet-soft: #2a2240; --hue-rose: #ec8fa6; --hue-rose-soft: #3b1c25;
    --hue-sand: #cdb88f; --hue-sand-soft: #2f281c;
  }
}
:root[data-theme="dark"] {
  --hue-blue: #8fb4e8; --hue-blue-soft: #1c2a3d; --hue-teal: #6cc8c4; --hue-teal-soft: #15302f;
  --hue-violet: #b9a3e3; --hue-violet-soft: #2a2240; --hue-rose: #ec8fa6; --hue-rose-soft: #3b1c25;
  --hue-sand: #cdb88f; --hue-sand-soft: #2f281c;
}
.ev-blue { --c: var(--hue-blue); --cs: var(--hue-blue-soft); }
.ev-teal { --c: var(--hue-teal); --cs: var(--hue-teal-soft); }
.ev-violet { --c: var(--hue-violet); --cs: var(--hue-violet-soft); }
.ev-rose { --c: var(--hue-rose); --cs: var(--hue-rose-soft); }
.ev-sand { --c: var(--hue-sand); --cs: var(--hue-sand-soft); }
.ev-amber { --c: var(--warn); --cs: var(--warn-soft); }
.ev-green { --c: var(--accent); --cs: var(--accent-soft); }
.ev-grey { --c: var(--muted); --cs: var(--surface-2); }
.ev-pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px; font-size: .76rem; font-weight: 700; white-space: nowrap; background: var(--cs); color: var(--c); }
.ev-pill::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.chip.ev-chip { display: inline-flex; align-items: center; gap: 6px; }
.chip.ev-chip::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
.chip.ev-chip[aria-pressed="true"] { background: var(--cs); border-color: transparent; color: var(--ink); }
.chip.ev-chip[aria-pressed="false"] { color: var(--muted); text-decoration: line-through; }
.cal-tools { display: grid; gap: 12px; }
.cal-bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; }
.cal-nav { display: flex; gap: 6px; align-items: center; }
.cal-filters { display: grid; gap: 8px; }
.cal-filters[hidden] { display: none; }
.cal-body { display: grid; gap: 14px; min-width: 0; }
.cal-title { font-size: 1.15rem; }
.cal-empty { padding-block: 40px; }
.ev-row { width: 100%; display: grid; grid-template-columns: auto 1fr; gap: 12px; align-items: start; padding: 10px 0; background: none; border: 0; text-align: left; cursor: pointer; color: var(--ink); }
.list > .ev-row + .ev-row { border-top: 1px solid var(--line); }
.ev-row:hover .li-title { text-decoration: underline; }
.ev-bar { width: 4px; align-self: stretch; border-radius: 4px; background: var(--c); min-height: 34px; }
.date-tile { width: 46px; border-radius: 12px; background: var(--cs, var(--surface-2)); color: var(--c, var(--ink)); display: grid; justify-items: center; padding: 5px 0 6px; line-height: 1.1; flex: none; }
.date-tile b { font-family: var(--font-display); font-size: 1.25rem; font-variant-numeric: tabular-nums; }
.date-tile span { font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.ev-cards { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); }
.ev-cards .ev-row { border: 1px solid var(--line); border-radius: var(--r-sm); padding: 10px 12px; }
.ag-day { display: grid; grid-template-columns: auto 1fr; gap: 14px; padding: 12px 0; align-items: start; }
.ag-day .date-tile { background: var(--surface-2); color: var(--ink); }
.ag-day .ev-row { padding: 8px 0; }

.wk-panel { padding: 0; overflow: hidden; }
.wk { display: grid; grid-template-columns: 52px repeat(7, minmax(0, 1fr)); }
.wk-corner, .wk-head { border-bottom: 1px solid var(--line); }
.wk-head { padding: 10px 6px 8px; display: grid; justify-items: center; gap: 2px; font-size: .78rem; color: var(--muted); font-weight: 700; text-transform: uppercase; letter-spacing: .04em; border-left: 1px solid var(--line); }
.wk-head b { font-family: var(--font-display); font-size: 1.2rem; color: var(--ink); width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; font-variant-numeric: tabular-nums; letter-spacing: 0; }
.wk-head.today b { background: var(--accent); color: var(--accent-ink); }
.wk-gut { font-size: .72rem; color: var(--muted); text-align: right; padding-right: 6px; }
.wk-adl { padding-top: 8px; line-height: 1.2; border-bottom: 1px solid var(--line); }
.wk-ad { border-left: 1px solid var(--line); border-bottom: 1px solid var(--line); padding: 4px 3px; display: grid; gap: 3px; align-content: start; min-width: 0; }
.wk-chip, .mo-chip { display: block; width: 100%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; font-size: .74rem; font-weight: 700; padding: 2px 6px; border-radius: 6px; border: 0; background: var(--cs); color: var(--c); cursor: pointer; }
.wk-hours { position: relative; }
.wk-hours span { position: absolute; right: 6px; transform: translateY(-50%); font-variant-numeric: tabular-nums; }
.wk-hours span:first-child { transform: none; }
.wk-col { position: relative; border-left: 1px solid var(--line); background-image: linear-gradient(to bottom, var(--line) 1px, transparent 1px); background-size: 100% 44px; min-width: 0; }
.wk-col.today { background-color: var(--accent-soft); }
.wk-ev { position: absolute; overflow: hidden; display: grid; align-content: start; gap: 1px; padding: 3px 6px; border: 0; border-left: 3px solid var(--c); border-radius: 6px; background: var(--cs); color: var(--ink); text-align: left; cursor: pointer; font-size: .74rem; line-height: 1.25; }
.wk-ev strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wk-ev.short { display: flex; align-items: center; gap: 6px; padding-block: 0; }
.wk-ev.short strong { flex: 1 1 auto; min-width: 0; }
.wk-ev.short span { flex: none; }
.wk-ev span { color: var(--muted); font-variant-numeric: tabular-nums; }
.wk-now { position: absolute; left: 0; right: 0; height: 2px; background: var(--err); z-index: 1; }
.wk-none { grid-column: 1 / -1; padding: 16px; text-align: center; }
.wk-list { display: none; }
.wk-day { padding: 10px 0; display: grid; gap: 2px; }
.wk-day-head { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
.wk-day-head strong::first-letter { text-transform: uppercase; }
@media (max-width: 699px) {
  .wk-panel { display: none; }
  .wk-list { display: block; padding-block: 6px; }
}

.mo-panel { padding: 0; overflow: hidden; }
.mo { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 1px; background: var(--line); }
.mo-dow { background: var(--surface); padding: 8px 6px; font-size: .72rem; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; text-align: center; }
.mo-day { background: var(--surface); border: 0; min-height: 104px; padding: 6px; display: grid; align-content: start; gap: 3px; text-align: left; cursor: pointer; color: var(--ink); min-width: 0; }
.mo-day:hover { background: var(--surface-2); }
.mo-day.out { background: var(--bg); color: var(--muted); }
.mo-day[aria-pressed="true"] { box-shadow: inset 0 0 0 2px var(--accent); }
.mo-num { font-weight: 700; font-size: .86rem; width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; font-variant-numeric: tabular-nums; }
.mo-day.today .mo-num { background: var(--accent); color: var(--accent-ink); }
.mo-more { font-size: .72rem; color: var(--muted); padding-left: 6px; }
.mo-dots { display: none; gap: 3px; flex-wrap: wrap; justify-content: center; }
.mo-dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--c); }
.mo-note { padding: 12px 16px; border-top: 1px solid var(--line); }
.act { display: flex; flex-wrap: wrap; gap: 2px 8px; font-size: .72rem; font-weight: 700; color: var(--muted); font-variant-numeric: tabular-nums; }
.act span { display: inline-flex; align-items: center; gap: 2px; }
.act svg { width: 12px; height: 12px; }
.mo-day .act { margin-top: auto; padding: 0 2px; }
.mo-total { display: none; font-size: .64rem; font-weight: 700; color: var(--muted); font-variant-numeric: tabular-nums; }
.wk-head .act { justify-content: center; text-transform: none; letter-spacing: 0; }
.act-links { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.act-links .chip svg, .cal-filters .chip svg { width: 14px; height: 14px; flex: none; }
@media (max-width: 699px) {
  .mo-day { min-height: 52px; padding: 4px 2px; justify-items: center; }
  .mo-chip, .mo-more, .mo-day .act { display: none; }
  .mo-dots, .mo-total { display: flex; }
  .mo-dow { padding: 6px 2px; font-size: .66rem; }
}

.role-badge { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 6px; font-size: .74rem; font-weight: 700; white-space: nowrap; border: 0; background: var(--surface-2); color: var(--muted); }
.role-guardian { background: var(--hue-blue-soft); color: var(--hue-blue); }
.role-employee { background: var(--accent-soft); color: var(--accent); }
.role-child { background: var(--hue-violet-soft); color: var(--hue-violet); }
button.role-badge { cursor: pointer; }
button.role-badge:hover { text-decoration: underline; }
.role-counts { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
#roleChips[hidden] { display: none; }

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
  external: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
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
// The reads that may show another parent's shared data, read-only.
const OWNER_READS = /^data\\/(stats|items|activity|messages\\/roles|gallery|attachments)(\\/|\\?|$)/;
const withOwner = (path) => (state.owner && OWNER_READS.test(path)
  ? path + (path.includes('?') ? '&' : '?') + 'owner=' + encodeURIComponent(state.owner) : path);
const getJson = async (path) => {
  const res = await fetch(withOwner(path), { headers: { accept: 'application/json' } });
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
/** What can be looked at while viewing another parent's shared data. */
const SHARED_VIEWS = ['gennemse', 'kalender', 'galleri', 'deling'];
const VIEWS = [
  { id: 'oversigt', label: 'Oversigt', icon: 'home', bottom: true },
  { id: 'gennemse', label: 'Gennemse', icon: 'search', bottom: true },
  { id: 'kalender', label: 'Kalender', icon: 'cal' },
  { id: 'sync', label: 'Synkronisering', short: 'Sync', icon: 'sync', bottom: true },
  { id: 'log', label: 'Log', icon: 'task' },
  { id: 'galleri', label: 'Galleri', icon: 'image', bottom: true },
  { id: 'vaerktoejer', label: 'Værktøjer', icon: 'tools' },
  { id: 'live', label: 'Live fra Aula', icon: 'live' },
  { id: 'deling', label: 'Deling', icon: 'group' },
  { id: 'gemt', label: 'Gemt om dig', icon: 'db' },
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
  audit: { loaded: false, loading: false, available: false, events: [], more: false, category: '', failed: false, key: null, error: null },
  live: null,
  liveError: null,
  tools: null,
  recent: null,
  browse: { q: '', kind: '', range: '', items: [], offset: 0, more: false, loading: false, sel: null, detail: null, truncated: false },
  toolFilter: { q: '', access: 'alle', open: new Set() },
  syncOpen: new Set(),
  wasRunning: new Set(),
  gallery: { data: null, error: null, loading: false, stale: true, child: '', year: '', album: null, albumFor: null, albumError: null, albumLoading: false, lb: 0 },
  // Sharing: whom I share with, who shares with me, and whose data is shown
  // ('' is my own; otherwise an owner id, read-only).
  share: null,
  shareLoading: false,
  owner: '',
  sharedKinds: null,
};
const loggedIn = () => Boolean(state.summary && state.summary.login && state.summary.login.logged_in);
const database = () => {
  const db = state.summary ? state.summary.database : null;
  return db && state.owner ? Object.assign({}, db, { kinds: state.sharedKinds || [] }) : db;
};
const sharedWithMe = () => (state.share && state.share.available ? state.share.shared_with_me : []);
const ownerName = () => (sharedWithMe().find((o) => o.owner === state.owner) || { name: 'den anden forælder' }).name;
async function loadShares() {
  if (state.shareLoading) return;
  state.shareLoading = true;
  try { state.share = await getJson('data/shares'); }
  catch (err) { state.share = { available: false, error: err.message }; }
  state.shareLoading = false;
  if (state.owner && !sharedWithMe().some((o) => o.owner === state.owner)) { setOwner(''); return; }
  route();
}
/** Shows my own data ('') or what another parent shares with me. */
async function setOwner(id) {
  if (id === state.owner) return;
  state.owner = id;
  state.sharedKinds = null;
  Object.assign(state.browse, { items: [], offset: 0, more: false, sel: null, detail: null, kind: '' });
  Object.assign(state.gallery, { data: null, error: null, stale: true, child: '', year: '', album: null, albumFor: null, albumError: null });
  state.cal.key = '';
  state.roles = null;
  rolesAt = 0;
  if (id) {
    try { state.sharedKinds = (await getJson('data/stats')).kinds; }
    catch (err) { state.sharedKinds = []; toast('Kunne ikke hente de delte data: ' + err.message); }
    if (state.owner !== id) return;
  }
  if (id && !SHARED_VIEWS.includes(current())) go('gennemse'); else route();
}
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
function visibleViews() {
  return VIEWS.filter((v) => (v.id !== 'deling' || (state.share && state.share.available)) && (!state.owner || SHARED_VIEWS.includes(v.id)));
}
function current() {
  const h = location.hash.slice(1).split('/')[0];
  if (state.owner) return SHARED_VIEWS.includes(h) ? h : 'gennemse';
  if (h === 'slet') return 'gemt';
  return VIEWS.some((v) => v.id === h) ? h : 'oversigt';
}
function ownerPick(id) {
  const owners = sharedWithMe();
  if (!owners.length) return null;
  return el('div', { class: 'view-pick' },
    el('label', { class: 'muted small', for: id }, 'Viser data'),
    el('select', { class: 'input', id, onchange: (e) => setOwner(e.target.value) },
      el('option', { value: '' }, 'Mine data'),
      owners.map((o) => el('option', { value: o.owner, selected: state.owner === o.owner ? true : null }, o.name + ' (kun læse)'))));
}
function sharedBanner() {
  if (!state.owner) return null;
  const name = ownerName();
  return banner('info', 'lock',
    el('p', {}, el('strong', {}, 'Du ser det, ' + name + ' deler med dig. '), 'Kun læse, og kun det, du ikke selv har, fx beskeder sendt til ' + name + ' alene.'),
    el('div', { class: 'banner-actions' }, el('button', { class: 'btn btn-sm', onclick: () => setOwner('') }, 'Tilbage til mine data')));
}
function go(id) { if (location.hash.slice(1) === id) route(); else location.hash = id; }
function navButton(v, cur, cls) {
  const count = v.id === 'gennemse' && database() ? el('span', { class: 'count' }, fmt(totalCount()))
    : v.id === 'sync' && state.summary && !loggedIn() ? el('span', { class: 'count', style: 'color:var(--warn)' }, 'venter') : null;
  return el('button', { class: cls + (v.danger ? ' danger' : ''), 'data-go': v.id, 'aria-current': v.id === cur ? 'page' : null },
    icon(v.icon), el('span', {}, v.label), count);
}
function renderNav(cur) {
  const side = [ownerPick('ownerPick')];
  for (const v of visibleViews()) {
    if (v.id === 'gemt') side.push(el('div', { class: 'nav-sep' }));
    side.push(navButton(v, cur, 'nav-item'));
  }
  fill($('sideNav'), ...side);
  const bottoms = visibleViews().filter((v) => v.bottom);
  const inMore = !bottoms.some((v) => v.id === cur);
  fill($('bottomNav'), 
    ...bottoms.map((v) => el('button', { 'data-go': v.id, 'aria-current': v.id === cur ? 'page' : null }, icon(v.icon), el('span', {}, v.short || v.label))),
    el('button', { id: 'moreBtn', 'aria-current': inMore ? 'page' : null, onclick: openMore }, icon('more'), el('span', {}, 'Mere')),
  );
  $('topSub').textContent = VIEWS.find((v) => v.id === cur).label;
}
function route() {
  const cur = current();
  if (cur === 'galleri' || cur === 'gemt') state.gallery.stale = true;
  renderNav(cur);
  fill(main, el('div', { class: 'view' }, sharedBanner(), R[cur]()));
  if (location.hash === '#slet' && $('sletData')) $('sletData').scrollIntoView();
  else if (window.innerWidth < 900) window.scrollTo(0, 0);
}
function rerender(view) { if (current() === view) { renderNav(view); fill(main, el('div', { class: 'view' }, sharedBanner(), R[view]())); } }
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
/* ---------- genveje for et barn: syg, komme/gå, plan ---------- */
const REPEAT = [['never', 'Kun denne dag'], ['weekly', 'Hver uge'], ['every_2_weeks', 'Hver anden uge']];
/** The last day before the summer holiday (30 June) or Christmas (19 December) after a day. */
const endOfTerm = (k) => {
  const y = +k.slice(0, 4);
  const md = k.slice(5);
  return md <= '06-30' ? y + '-06-30' : md <= '12-19' ? y + '-12-19' : (y + 1) + '-06-30';
};
const HENTEFORM = [['picked_up_by', 'Hentes af'], ['go_home_with', 'Går hjem med'], ['send_home', 'Sendes hjem'], ['self_decider', 'Selvbestemmer']];

const GO_VERB = { picked_up_by: 'Hentes', go_home_with: 'Går hjem', send_home: 'Sendes hjem' };
const goText = (a, time, who) => (GO_VERB[a] || 'Går') + ' ' + tm(time) + (who ? (a === 'go_home_with' ? ' med ' : ' af ') + who : '');
const tm = (s) => { const m = s ? String(s).match(/([0-9]{2}):([0-9]{2})/) : null; return m ? m[1] + ':' + m[2] : ''; };
const todayKey = () => { const t = new Date(); return keyOf(t.getFullYear(), t.getMonth() + 1, t.getDate()); };
const KID_ERR = { unknown_child: 'Barnet hører ikke til din login i Aula.', not_reported_sick: 'Aula melder ikke barnet sygt lige nu.', 'not your child': 'Barnet hører ikke til din login i Aula.' };
const kidErr = (err) => KID_ERR[err.message] || err.message;
state.kids = null;
let kidsAt = 0;
async function loadKids(force) {
  if (state.owner || (!force && Date.now() - kidsAt < 60000)) return;
  kidsAt = Date.now();
  try { state.kids = { list: (await getJson('data/children')).children }; }
  catch (err) { state.kids = { error: err.message }; }
  rerender('oversigt');
}
/** Checkboxes for a child's brothers and sisters that pass ok(k), for doing the same for them. */
function siblingPicker(c, ok) {
  const kids = state.kids && state.kids.list ? state.kids.list.filter((k) => k.id !== c.id && ok(k)) : [];
  const boxes = kids.map((k) => ({ k, box: el('input', { type: 'checkbox', id: 'sib-' + k.id }) }));
  return {
    node: boxes.length ? el('div', { class: 'field' }, boxes.map(({ k, box }) => el('label', { for: 'sib-' + k.id, style: 'display:flex;gap:8px;align-items:center;font-weight:400' }, box, 'Også ' + k.name))) : null,
    picked: () => boxes.filter(({ box }) => box.checked).map(({ k }) => k),
  };
}
const kidToday = (id) => (state.kids && state.kids.list ? state.kids.list.find((k) => k.id === id) : null);
function kidPill(k) {
  const cls = k.status === 1 ? 'err' : k.status === 3 || k.status === 5 ? 'ok' : k.status === 2 ? 'warn' : k.status === 4 || k.status === 6 ? 'run' : 'neutral';
  return el('span', { class: 'pill ' + cls }, k.label);
}
function kidTodayLine(k) {
  const come = k.checkInTime ? 'Kom ' + tm(k.checkInTime) : k.entryTime ? 'Kommer ' + tm(k.entryTime) : '';
  const leave = k.checkOutTime ? 'Gik ' + tm(k.checkOutTime)
    : k.exitTime ? goText(k.activityType, k.exitTime, k.exitWith) : '';
  const line = [come, leave].filter(Boolean).join(' · ');
  return line ? el('p', { class: 'kid-today' }, 'I dag: ' + line) : null;
}
function kidsPanel() {
  if (!loggedIn()) return null;
  if (state.liveError) return el('p', { class: 'muted small' }, 'Kunne ikke hente dine børn fra Aula: ' + state.liveError);
  if (!state.live) return el('div', { class: 'grid-2' }, skeleton(), skeleton());
  if (!state.live.children.length) return null;
  loadKids();
  return el('div', { class: 'grid-2' }, state.live.children.map((c) => {
    const k = kidToday(c.id);
    return el('section', { class: 'panel' },
      el('div', { class: 'kid' }, el('div', { class: 'kid-face', 'aria-hidden': 'true' }, (c.name || '?').slice(0, 1)),
        el('div', { style: 'min-width:0' }, el('h2', {}, c.name), el('div', { class: 'kid-meta' }, c.institution ? el('span', {}, c.institution) : null, k ? kidPill(k) : null)),
        state.owner ? null : el('button', { class: 'btn', 'aria-haspopup': 'dialog', onclick: () => openKid(c) }, icon('more'), 'Genveje')),
      k ? kidTodayLine(k) : null);
  }));
}
function kidDialog() {
  let d = $('kidDlg');
  if (!d) {
    d = el('dialog', { id: 'kidDlg', 'aria-labelledby': 'kidDlgTitle' }, el('div', { class: 'dlg', id: 'kidDlgBody' }));
    document.body.append(d);
    d.addEventListener('click', (ev) => { if (ev.target === d) d.close(); });
  }
  return d;
}
function openKid(c) {
  const d = kidDialog();
  const body = $('kidDlgBody');
  const first = (c.name || '').split(' ')[0] || c.name;
  const head = (title, back) => el('div', { class: 'panel-head', style: 'margin:0;gap:8px' },
    back ? el('button', { class: 'icon-btn', 'aria-label': 'Tilbage', onclick: () => menu() }, icon('left')) : null,
    el('h2', { id: 'kidDlgTitle', style: 'font-size:1.2rem;margin-right:auto' }, title),
    el('button', { class: 'icon-btn', 'aria-label': 'Luk', onclick: () => d.close() }, icon('x')));
  const item = (ic, title, sub, onclick, danger) => el('button', { class: 'li menu-li' + (danger ? ' danger' : ''), onclick },
    el('span', { class: 'type-dot' }, icon(ic)),
    el('span', { style: 'min-width:0;display:block' }, el('span', { class: 'li-title', style: 'display:block' }, title), el('span', { class: 'li-sub', style: 'display:block' }, sub)),
    icon('chev'));
  const askSick = (sick) => {
    d.close();
    const also = siblingPicker(c, (k) => sick ? k.status !== 1 : k.status === 1);
    confirmDialog({
      danger: sick, icon: sick ? 'warn' : 'sun',
      title: sick ? 'Meld ' + first + ' syg i dag?' : 'Meld ' + first + ' rask igen?',
      ok: sick ? 'Meld syg' : 'Meld rask',
      body: [
        el('p', {}, sick ? c.name + ' meldes syg i Aula for i dag. Institutionen får besked med det samme.'
          : 'Sygemeldingen tages tilbage i Aula, og ' + first + ' står som ikke kommet.'),
        also.node,
        el('p', { class: 'muted small' }, 'Det står i din log under Handlinger i Aula.'),
      ],
      onok: async () => {
        const kids = [c].concat(also.picked());
        const names = kids.map((k) => (k.name || '').split(' ')[0]).join(' og ');
        try { await postJson('data/children/sick', { children: kids.map((k) => k.id), sick }); toast(sick ? names + ' er meldt syg i Aula' : names + ' er meldt rask i Aula'); }
        catch (err) { toast('Kunne ikke: ' + kidErr(err)); }
        loadKids(true);
      },
    });
  };
  const menu = () => {
    const k = kidToday(c.id);
    fill(body, head(c.name),
      k ? el('p', { class: 'muted small', style: 'margin:0' }, 'I dag i Aula: ', kidPill(k)) : null,
      el('div', { class: 'list' },
        k && k.status === 1
          ? item('sun', 'Meld rask igen', 'Tag sygemeldingen tilbage i Aula', () => askSick(false))
          : item('warn', 'Meld syg i dag', 'Institutionen får besked i Aula med det samme', () => askSick(true), true),
        item('door', 'Ændr komme/gå', 'For én dag, hver uge eller hver anden uge', () => planForm(todayKey())),
        item('sun', 'Meld ferie/fri', 'Hele dage, en eller flere i træk', () => vacationForm()),
        item('week', 'Se komme/gå-plan', 'De næste 14 dage', () => planList()),
        item('cal', 'Åbn kalender', 'Begivenheder for familien', () => { d.close(); go('kalender'); })));
  };
  const planRow = (p) => el('button', { class: 'li menu-li', onclick: () => planForm(p.date) },
    el('span', { class: 'type-dot' }, icon(p.onVacation ? 'sun' : 'door')),
    el('span', { style: 'min-width:0;display:block' },
      el('span', { class: 'li-title', style: 'display:block' }, longDay(p.date)),
      el('span', { class: 'li-sub', style: 'display:block' }, p.onVacation ? 'Ferie/fri'
        : [p.entryTime ? 'Kommer ' + tm(p.entryTime) : '',
          p.activityType === 'self_decider' ? 'Selvbestemmer ' + tm(p.selfDeciderStartTime) + '–' + tm(p.selfDeciderEndTime)
            : p.exitTime ? goText(p.activityType, p.exitTime, p.exitWith) : '',
          p.comment || ''].filter(Boolean).join(' · ') || 'Intet registreret')),
    icon('chev'));
  const planList = async () => {
    fill(body, head('Komme/gå for ' + first, true), skeleton());
    try {
      const plan = await getJson('data/children/plan?child=' + c.id);
      fill(body, head('Komme/gå for ' + first, true),
        plan.days.length ? el('div', { class: 'list', style: 'max-height:55vh;overflow:auto' }, plan.days.map(planRow))
          : el('p', { class: 'muted' }, 'Intet registreret i Aula de næste 14 dage.'),
        el('div', { class: 'dlg-actions' }, el('button', { class: 'btn btn-primary', onclick: () => planForm(todayKey()) }, 'Ændr en dag')));
    } catch (err) { fill(body, head('Komme/gå for ' + first, true), el('p', { class: 'error-text' }, 'Kunne ikke hente: ' + kidErr(err))); }
  };
  const planForm = async (date) => {
    const f = {};
    const field = (id, label, input) => { f[id] = input; return el('div', { class: 'field', 'data-f': id }, el('label', { for: 'kf-' + id }, label), input); };
    const inp = (id, type, value) => el('input', { class: 'input', id: 'kf-' + id, type, value: value || '' });
    const status = el('p', { class: 'muted small', style: 'margin:0' }, 'Henter det, der står i Aula …');
    const save = el('button', { class: 'btn btn-primary', disabled: true }, 'Gem i Aula');
    const sel = el('select', { class: 'input', id: 'kf-activityType' }, HENTEFORM.map(([v, l]) => el('option', { value: v }, l)));
    const grid = el('div', { class: 'form-grid' },
      field('date', 'Dag', inp('date', 'date', date)),
      field('activityType', 'Henteform', sel),
      field('entryTime', 'Afleveres', inp('entryTime', 'time')),
      field('exitTime', 'Hentes / går', inp('exitTime', 'time')),
      field('selfDeciderStartTime', 'Må gå fra', inp('selfDeciderStartTime', 'time')),
      field('selfDeciderEndTime', 'Senest', inp('selfDeciderEndTime', 'time')),
      field('pickedUpBy', 'Hvem', inp('pickedUpBy', 'text')));
    const comment = field('comment', 'Besked til personalet', el('input', { class: 'input', id: 'kf-comment', type: 'text', maxlength: '500' }));
    const repeat = el('select', { class: 'input', id: 'kf-repeat' }, REPEAT.map(([v, l]) => el('option', { value: v }, l)));
    const untilWrap = field('repeatUntil', 'Til og med', inp('repeatUntil', 'date'));
    const repeatGrid = el('div', { class: 'form-grid' }, field('repeat', 'Gentag', repeat), untilWrap);
    const showRepeat = () => {
      untilWrap.hidden = repeat.value === 'never';
      f.repeatUntil.min = f.date.value;
      if (!untilWrap.hidden && !f.repeatUntil.value) f.repeatUntil.value = endOfTerm(f.date.value);
    };
    repeat.addEventListener('change', showRepeat);
    const shown = () => {
      const a = sel.value;
      const vis = { exitTime: a !== 'self_decider', selfDeciderStartTime: a === 'self_decider', selfDeciderEndTime: a === 'self_decider', pickedUpBy: a === 'picked_up_by' || a === 'go_home_with' };
      grid.querySelectorAll('[data-f]').forEach((n) => { const k = n.getAttribute('data-f'); n.hidden = k in vis ? !vis[k] : false; });
    };
    sel.addEventListener('change', shown);
    const prefill = async () => {
      save.disabled = true;
      status.textContent = 'Henter det, der står i Aula …';
      try {
        const day = f.date.value;
        const plan = await getJson('data/children/plan?child=' + c.id + '&from=' + day + '&to=' + day);
        const p = plan.days.find((x) => x.date === day);
        sel.value = (p && p.activityType) || 'picked_up_by';
        f.entryTime.value = p ? tm(p.entryTime) : '';
        f.exitTime.value = p ? tm(p.exitTime) : '';
        f.selfDeciderStartTime.value = p ? tm(p.selfDeciderStartTime) : '';
        f.selfDeciderEndTime.value = p ? tm(p.selfDeciderEndTime) : '';
        f.pickedUpBy.value = (p && p.exitWith) || '';
        f.comment.value = (p && p.comment) || '';
        status.textContent = p ? (p.onVacation ? 'Står som ferie/fri i Aula.' : 'Udfyldt med det, der står i Aula nu.') : 'Intet registreret for dagen endnu.';
      } catch (err) { status.textContent = 'Kunne ikke hente: ' + kidErr(err); }
      shown();
      save.disabled = false;
    };
    f.date.addEventListener('change', () => { showRepeat(); prefill(); });
    save.addEventListener('click', async () => {
      const data = { child: c.id, date: f.date.value, activityType: sel.value };
      for (const k of ['entryTime', 'exitTime', 'selfDeciderStartTime', 'selfDeciderEndTime', 'pickedUpBy', 'comment']) {
        const n = f[k];
        if (n && !n.closest('[data-f]').hidden && n.value.trim()) data[k] = n.value.trim();
      }
      const send = async () => {
        save.disabled = true;
        try {
          await postJson('data/children/plan', data);
          toast('Komme/gå for ' + first + ' er gemt i Aula');
          loadKids(true);
          planList();
        } catch (err) { status.textContent = 'Kunne ikke gemme: ' + kidErr(err); save.disabled = false; }
      };
      if (repeat.value === 'never') { send(); return; }
      if (!f.repeatUntil.value || f.repeatUntil.value < data.date) { status.textContent = 'Vælg en slutdato, der ikke ligger før dagen.'; return; }
      data.repeat = repeat.value;
      data.repeatUntil = f.repeatUntil.value;
      const every = repeat.value === 'weekly' ? 'hver ' : 'hver anden ';
      confirmDialog({
        icon: 'week',
        title: 'Gentag komme/gå for ' + first + '?',
        ok: 'Gem i Aula',
        body: [
          el('p', {}, 'Planen gemmes i Aula ' + every + WEEKDAY[dow(data.date)] + ' fra ' + longDay(data.date) + ' til og med ' + longDay(data.repeatUntil) + '. Den erstatter det, der står i Aula de dage.'),
          el('p', { class: 'muted small' }, 'Det står i din log under Handlinger i Aula.'),
        ],
        onok: send,
      });
    });
    fill(body, head('Ændr komme/gå for ' + first, true),
      el('p', { class: 'muted small', style: 'margin:0' }, 'Det ændres i Aula, og personalet kan se det med det samme.'),
      grid, comment, repeatGrid, status,
      el('div', { class: 'dlg-actions' }, el('button', { class: 'btn', onclick: () => menu() }, 'Annuller'), save));
    shown();
    showRepeat();
    await prefill();
  };
  const vacationForm = () => {
    const inp = (id, type, value) => el('input', { class: 'input', id: 'kv-' + id, type, value: value || '' });
    const from = inp('from', 'date', todayKey());
    const to = inp('to', 'date', todayKey());
    const note = el('input', { class: 'input', id: 'kv-comment', type: 'text', maxlength: '250' });
    from.min = todayKey();
    to.min = todayKey();
    from.addEventListener('change', () => { to.min = from.value; if (to.value < from.value) to.value = from.value; });
    const status = el('p', { class: 'muted small', style: 'margin:0' });
    const also = siblingPicker(c, () => true);
    const save = el('button', { class: 'btn btn-primary' }, 'Meld ferie/fri');
    const span = () => from.value === to.value ? longDay(from.value) : longDay(from.value) + ' til ' + longDay(to.value);
    save.addEventListener('click', () => {
      if (!from.value || !to.value || to.value < from.value) { status.textContent = 'Vælg en første og en sidste dag.'; return; }
      const comment = note.value.trim();
      const kids = [c].concat(also.picked());
      const names = kids.map((k) => (k.name || '').split(' ')[0]).join(' og ');
      d.close();
      confirmDialog({
        icon: 'sun',
        title: 'Meld ' + names + ' på ferie/fri?',
        ok: 'Meld ferie/fri',
        body: [
          el('p', {}, kids.map((k) => k.name).join(' og ') + ' meldes' + ' på ferie/fri i Aula ' + span() + '. Institutionen kan se det med det samme.'),
          comment ? el('p', {}, 'Besked: ' + comment) : null,
          el('p', { class: 'muted small' }, 'Du kan ikke slette ferien herfra. Er den forkert, slettes den i Aula. Det står i din log under Handlinger i Aula.'),
        ],
        onok: async () => {
          try {
            await postJson('data/children/vacation', { children: kids.map((k) => k.id), startDate: from.value, endDate: to.value, comment });
            toast(names + ' er meldt på ferie/fri i Aula');
          } catch (err) { toast('Kunne ikke: ' + kidErr(err)); }
          loadKids(true);
        },
      });
    });
    fill(body, head('Ferie/fri for ' + first, true),
      el('p', { class: 'muted small', style: 'margin:0' }, 'Hele dage, fra i dag og op til et år frem.'),
      el('div', { class: 'form-grid' },
        el('div', { class: 'field' }, el('label', { for: 'kv-from' }, 'Første dag'), from),
        el('div', { class: 'field' }, el('label', { for: 'kv-to' }, 'Sidste dag'), to)),
      el('div', { class: 'field' }, el('label', { for: 'kv-comment' }, 'Besked til personalet (valgfri)'), note),
      also.node,
      status,
      el('div', { class: 'dlg-actions' }, el('button', { class: 'btn', onclick: () => menu() }, 'Annuller'), save));
  };
  menu();
  if (!d.open) d.showModal();
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
      el('div', { class: 'stat' }, el('span', { class: 'l' }, 'Beskedtråde'), el('span', { class: 'v' }, fmt(countOf('message_thread'))), roleCounts(), el('button', { class: 'linkish', 'data-go': 'gennemse' }, 'Gennemse')),
      el('div', { class: 'stat' }, el('span', { class: 'l' }, 'Synkronisering'), el('span', { class: 'v small-v' }, syncPill()), el('button', { class: 'linkish', 'data-go': 'sync' }, 'Se jobs')),
      galleryStat())
      : state.summary ? storageOff() : null,
    nextEventsPanel(),
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
          el('div', {}, icon('db'), el('p', {}, el('strong', {}, 'Gemt, til du sletter det. '), 'Intet slettes automatisk. Du bestemmer selv under ', el('button', { class: 'linkish', onclick: () => $('sletData').scrollIntoView({ behavior: 'smooth' }) }, 'Slet data'), '.')),
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
    db ? deleteSections() : null,
  ];
};

/* ---------- gennemse ---------- */
const RANGES = [['', 'Hele perioden'], ['7', 'Seneste 7 dage'], ['30', 'Seneste 30 dage'], ['kommende', 'Kommende']];
function browseQuery(offset) {
  const b = state.browse;
  const p = new URLSearchParams({ offset: String(offset), limit: '30' });
  if (b.kind) p.set('kind', b.kind);
  if (b.q.trim()) p.set('q', b.q.trim());
  if (b.role && isMsgKind(b.kind)) p.set('role', b.role);
  const now = Math.floor(Date.now() / 1000);
  if (b.range === '7') { p.set('since', String(now - 7 * 86400)); p.set('until', String(now)); }
  if (b.range === '30') { p.set('since', String(now - 30 * 86400)); p.set('until', String(now)); }
  if (b.range === 'kommende') p.set('since', String(now));
  if (b.range.startsWith('dag:')) {
    const k = b.range.slice(4);
    p.set('since', String(Math.floor(midnight(k) / 1000))); p.set('until', String(Math.floor(midnight(addDays(k, 1)) / 1000) - 1));
  }
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
    (b.range.startsWith('dag:') ? [[b.range, longDay(b.range.slice(4))]] : []).concat(RANGES).map(([v, l]) => el('option', { value: v, selected: b.range === v ? true : null }, l)));
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
        chip('', 'Alle', totalCount()), kinds.map((k) => chip(k, KINDS[k].label, countOf(k)))),
      el('div', { class: 'chips', id: 'roleChips', role: 'group', 'aria-label': 'Afsender', hidden: true })),
    el('div', { class: 'browse', id: 'browse' },
      el('section', { class: 'panel result-panel', style: 'padding:0', id: 'results' }),
      el('section', { class: 'panel detail', id: 'detail' })),
  ];
};
const FILE_TYPES = [['image', 'billede', 'billeder', 'image'], ['video', 'video', 'videoer', 'play'], ['pdf', 'PDF', 'PDF', 'clip'],
  ['document', 'dokument', 'dokumenter', 'clip'], ['spreadsheet', 'regneark', 'regneark', 'clip'], ['other', 'fil', 'filer', 'clip']];
/** What is attached to a message or post: one tag per file type with its count. */
const fileTags = (files) => (files ? FILE_TYPES.filter(([t]) => files[t])
  .map(([t, one, many, ic]) => el('span', { class: 'tag files', title: 'Vedhæftet' }, icon(ic), plural(files[t], one, many))) : null);
function renderResults() {
  const box = $('results'); if (!box) return;
  const b = state.browse;
  renderRoleChips();
  const title = b.loading && !b.items.length ? 'Henter…' : b.items.length ? 'Viser ' + fmt(b.items.length) + (b.more ? '+' : '') : 'Ingen resultater';
  const rows = b.items.map((it) => {
    const key = it.kind + '/' + it.id;
    return el('button', { class: 'result', 'aria-current': String(b.sel === key), onclick: () => selectItem(key) },
      typeDot(it.kind),
      el('span', { style: 'min-width:0;display:block' },
        el('span', { class: 'result-top' }, el('span', { class: 'li-title' }, it.unread ? el('span', { class: 'unread-dot' }, '● ') : null, it.title), el('span', { class: 'result-date' }, rel(it.occurredAt || it.updatedAt))),
        it.subtitle ? el('span', { class: 'li-sub', style: 'display:block' }, it.subtitle) : null,
        el('span', { class: 'result-foot' }, el('span', { class: 'tag' }, kindOf(it.kind).one), roleBadge(it.senderRole), fileTags(it.files))));
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
// Matches the types the server shows inline; anything else is a download.
const INLINE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/mp4', 'text/plain'];
const attachUrl = (kind, id, index, download) => withOwner(
  'data/attachments/' + kind + '/' + encodeURIComponent(String(id)) + '/' + index + (download ? '?download=1' : ''));
const isPicture = (t) => /^image\\/(jpeg|png|gif|webp)$/.test(t);
function typeLabel(t) {
  if (t.startsWith('image/')) return 'Billede';
  if (t.startsWith('video/')) return 'Video';
  if (t.startsWith('audio/')) return 'Lyd';
  if (t === 'application/pdf') return 'PDF';
  if (t === 'text/plain') return 'Tekst';
  if (/word/.test(t)) return 'Word';
  if (/excel|spreadsheet/.test(t)) return 'Excel';
  if (/powerpoint|presentation/.test(t)) return 'PowerPoint';
  return 'Fil';
}
const isPlayable = (t) => t === 'video/mp4' || t === 'video/webm';
/** The saved photos and videos of an item, as the viewer takes them. */
const viewable = (kind, id, files) => (files || []).filter((f) => f.saved && (isPicture(f.mediaType) || isPlayable(f.mediaType)))
  .map((f) => ({ index: f.index, src: attachUrl(kind, id, f.index), download: attachUrl(kind, id, f.index, true), video: isPlayable(f.mediaType), name: f.name, size: f.size }));
/** Photos and videos as gallery tiles that open the viewer. */
function attachMedia(kind, id, files) {
  const list = viewable(kind, id, files);
  if (!list.length) return null;
  return el('div', { class: 'media-grid attach-media' }, list.map((m, i) =>
    el('button', { class: 'thumb', title: m.name, 'aria-label': (m.video ? 'Video ' : 'Billede ') + (i + 1) + ': ' + m.name, onclick: () => openLightbox(i, list) },
      m.video ? coverEmpty('play') : lazyImg(m.src, 'image'),
      m.video ? el('span', { class: 'vid' }, icon('play'), 'Video') : null)));
}
function attachTable(kind, id, files) {
  if (!files || !files.length) return null;
  const media = viewable(kind, id, files);
  const view = (f) => media.findIndex((m) => m.index === f.index);
  const rows = files.map((f) => {
    const open = attachUrl(kind, id, f.index);
    const at = view(f);
    const preview = at >= 0
      ? el('button', { class: 'attach-prev', 'aria-label': 'Vis ' + f.name, onclick: () => openLightbox(at, media) }, isPicture(f.mediaType) ? lazyImg(open, 'image') : icon('play'))
      : el('span', { class: 'attach-prev', 'aria-hidden': 'true' }, icon(f.mediaType.startsWith('video/') ? 'play' : f.mediaType.startsWith('image/') ? 'image' : 'clip'));
    const acts = f.saved
      ? el('span', { class: 'attach-acts' },
        at >= 0 ? el('button', { class: 'btn btn-sm', onclick: () => openLightbox(at, media) }, icon('external'), 'Vis')
          : INLINE_TYPES.includes(f.mediaType) ? el('a', { class: 'btn btn-sm', href: open, target: '_blank', rel: 'noopener' }, icon('external'), 'Åbn') : null,
        el('a', { class: 'btn btn-sm', href: attachUrl(kind, id, f.index, true), download: f.name }, icon('download'), 'Hent'))
      : el('span', { class: 'muted small', title: 'Filen gemmes ved næste synkronisering, så længe Aula stadig har den.' }, 'Ikke gemt endnu');
    return el('tr', {},
      el('td', { class: 'prev' }, preview),
      el('td', {}, f.name),
      el('td', { class: 'col-type' }, typeLabel(f.mediaType)),
      el('td', { class: 'n' }, f.size ? size(f.size) : '–'),
      el('td', { class: 'acts' }, acts));
  });
  return el('div', { class: 'table-wrap attach-table' }, el('table', { class: 'count-table' },
    el('caption', { class: 'sr-only' }, 'Vedhæftede filer'),
    el('thead', {}, el('tr', {},
      el('th', { class: 'prev' }, el('span', { class: 'sr-only' }, 'Vist')),
      el('th', {}, plural(files.length, 'Vedhæftet fil', 'Vedhæftede filer')),
      el('th', { class: 'col-type' }, 'Type'),
      el('th', { class: 'n' }, 'Størrelse'),
      el('th', {}, el('span', { class: 'sr-only' }, 'Handling')))),
    el('tbody', {}, rows)));
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
    el('div', { class: 'detail-meta' }, it.subtitle ? el('span', {}, it.subtitle) : null, roleBadge(it.senderRole), el('span', {}, longDate(it.occurredAt || it.updatedAt))),
    it.fields.length ? el('dl', { class: 'kv' }, it.fields.map(([key, value]) => [el('dt', {}, key), el('dd', {}, value)])) : null,
    it.body ? el('p', { class: 'pre', style: 'max-width:65ch' }, it.body) : null,
    attachMedia(it.kind, it.id, it.attachments),
    attachTable(it.kind, it.id, it.attachments),
    msgs ? (msgs.length
      ? el('div', {}, msgs.map((m) => el('div', { class: 'msg' },
          el('div', { class: 'avatar', 'aria-hidden': 'true' }, (m.from || '?').split(' ').map((w) => w.slice(0, 1)).join('').slice(0, 2)),
          el('div', { style: 'min-width:0' },
            el('div', { class: 'msg-head' }, el('span', { style: 'display:inline-flex;gap:8px;align-items:center;flex-wrap:wrap' }, el('strong', {}, m.from || 'Ukendt afsender'), roleBadge(m.role)), el('span', { class: 'muted num' }, rel(m.at))),
            el('p', { class: 'msg-body pre' }, m.body),
            attachMedia('message', m.id, m.attachments),
            attachTable('message', m.id, m.attachments)))))
      : el('p', { class: 'muted small' }, 'Beskederne i tråden er ikke hentet endnu. De kommer med næste synkronisering.')) : null,
    it.unread ? el('p', { class: 'muted small', style: 'margin-top:6px' }, 'Tråden står stadig som ulæst i Aula. aula-mcp ændrer det ikke.') : null,
    el('p', { class: 'muted small mono', style: 'margin-top:16px;overflow-wrap:anywhere' }, 'Opdateret ' + rel(it.updatedAt) + ' · id ' + it.kind + ':' + it.id));
}

/* ---------- kalender ---------- */
// Times are Danish wall time whatever the browser's zone is; days are
// 'YYYY-MM-DD' keys, which also sort as strings.
const CPH = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const cphParts = (ms) => { const o = {}; for (const p of CPH.formatToParts(new Date(ms))) o[p.type] = p.value; return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, min: +o.minute }; };
const keyOf = (y, m, d) => y + '-' + pad(m) + '-' + pad(d);
const dayKey = (ms) => { const p = cphParts(ms); return keyOf(p.y, p.m, p.d); };
const keyUtc = (k) => Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10));
const addDays = (k, n) => { const t = new Date(keyUtc(k) + n * 864e5); return keyOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); };
const dow = (k) => new Date(keyUtc(k)).getUTCDay();
const weekStart = (k) => addDays(k, -((dow(k) + 6) % 7));
function cphWall(y, m, d, h, min) {
  const want = Date.UTC(y, m - 1, d, h, min);
  let t = want;
  for (let i = 0; i < 2; i++) { const p = cphParts(t); t = want - (Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - t); }
  return t;
}
const clock = (sec) => { if (!sec) return ''; const p = cphParts(sec * 1000); return pad(p.h) + ':' + pad(p.min); };
const midnight = (k) => cphWall(+k.slice(0, 4), +k.slice(5, 7), +k.slice(8, 10), 0, 0);
function evMs(s) {
  if (typeof s !== 'string' || s.length < 10) return null;
  if (/(Z|[+-][0-9]{2}:?[0-9]{2})$/i.test(s)) { const t = Date.parse(s); return Number.isNaN(t) ? null : t; }
  const n = (a, b) => +s.slice(a, b) || 0;
  return cphWall(n(0, 4), n(5, 7), n(8, 10), n(11, 13), n(14, 16));
}
const cphHm = (ms) => { const p = cphParts(ms); return pad(p.h) + ':' + pad(p.min); };
const MONTH = ['januar', 'februar', 'marts', 'april', 'maj', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'december'];
const WEEKDAY = ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag'];
const shortDay = (k) => DAY[dow(k)] + ' ' + +k.slice(8, 10) + '. ' + MON[+k.slice(5, 7) - 1];
const longDay = (k) => WEEKDAY[dow(k)] + ' ' + +k.slice(8, 10) + '. ' + MONTH[+k.slice(5, 7) - 1];
function isoWeek(k) {
  const t = new Date(keyUtc(k));
  t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7));
  const jan4 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((t - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
}

// Aula's event types: a Danish label and a colour each.
const EV_TYPES = {
  event: ['Begivenhed', 'blue'],
  excursion: ['Udflugt', 'teal'],
  birthday: ['Fødselsdag', 'green'],
  school_home_meeting: ['Skole-hjem-samtale', 'violet'],
  parental_meeting: ['Forældremøde', 'violet'],
  performance_meeting: ['Udviklingssamtale', 'violet'],
  holiday: ['Helligdag/fridag', 'rose'],
  presence_holiday: ['Ferie/fri (fremmøde)', 'amber'],
  vacation_registration: ['Ferieregistrering', 'sand'],
  lesson: ['Lektion', 'grey'],
  other: ['Andet', 'grey'],
};
const NOT_IN_AGENDA = ['lesson', 'holiday', 'presence_holiday'];
const evHue = (type) => (EV_TYPES[type] ? EV_TYPES[type][1] : 'grey');
const typePill = (e) => el('span', { class: 'ev-pill ev-' + evHue(e.type) }, e.label);

/** A stored calendar_event summary as something the views can place. */
function calEv(it) {
  const e = it.event || {};
  let start = evMs(e.start);
  if (start === null && it.occurredAt) start = it.occurredAt * 1000;
  if (start === null) return null;
  let end = evMs(e.end);
  if (end === null || end < start) end = start;
  const sk = dayKey(start);
  const ek = end > start ? dayKey(end - 1) : sk;
  const type = e.type || 'event';
  return {
    id: it.id, title: it.title || 'Begivenhed', type, label: (EV_TYPES[type] && EV_TYPES[type][0]) || e.typeLabel || type,
    start, end, sk, ek, allDay: Boolean(e.allDay) || sk !== ek, place: e.place || '',
    profiles: Array.isArray(e.profiles) ? e.profiles : [], rr: Boolean(e.responseRequired), resp: e.response || '', deadline: e.responseDeadline || '',
  };
}
const byStart = (a, b) => a.start - b.start || a.title.localeCompare(b.title, 'da');
function evTime(e) {
  if (!e.allDay) return cphHm(e.start) + (e.end > e.start ? '–' + cphHm(e.end) : '');
  return e.sk === e.ek ? 'Hele dagen' : shortDay(e.sk) + ' til ' + shortDay(e.ek);
}
function responseBadges(e) {
  if (!e.rr) return null;
  const open = !e.resp || e.resp === 'Ikke besvaret';
  const dl = evMs(e.deadline);
  return [
    open ? el('span', { class: 'pill warn' }, 'Svar påkrævet')
      : el('span', { class: 'pill ' + (e.resp === 'Deltager' ? 'ok' : e.resp === 'Deltager ikke' ? 'err' : 'neutral') }, e.resp),
    dl ? el('span', { class: 'tag' + (open && dl < Date.now() ? ' raw' : '') }, 'Svarfrist ' + shortDay(dayKey(dl))) : null,
  ];
}
const dateTile = (k) => el('span', { class: 'date-tile', 'aria-hidden': 'true' }, el('b', {}, +k.slice(8, 10)), el('span', {}, DAY[dow(k)]));
function evRow(e, withDate) {
  return el('button', { class: 'ev-row ev-' + evHue(e.type), onclick: () => openEvent(e) },
    withDate ? dateTile(e.sk) : el('span', { class: 'ev-bar', 'aria-hidden': 'true' }),
    el('span', { style: 'min-width:0;display:grid;gap:2px' },
      el('span', { class: 'li-title' }, e.title),
      el('span', { class: 'li-sub' }, [withDate ? shortDay(e.sk) : null, evTime(e), e.place].filter(Boolean).join(' · ')),
      el('span', { class: 'result-foot', style: 'margin-top:3px' }, typePill(e), responseBadges(e))));
}

/** Every stored event that starts in [since, until], 100 at a time. */
async function calFetch(since, until) {
  const out = [];
  for (let offset = 0; offset < 5000; offset += 100) {
    const p = new URLSearchParams({ kind: 'calendar_event', since: String(since), until: String(until), offset: String(offset), limit: '100' });
    const d = await getJson('data/items?' + p.toString());
    out.push(...d.items);
    if (d.items.length < 100 || d.more === false) break;
  }
  return out;
}

const CAL_VIEWS = [['maaned', 'Måned'], ['uge', 'Uge'], ['liste', 'Begivenheder']];
// What arrived in Aula each day, counted beside the events.
const ACT_KINDS = [['message', 'beskeder', 'besked', 'Beskeder'], ['gallery_media', 'billeder og videoer', 'billede eller video', 'Billeder'], ['post', 'opslag', 'opslag', 'Opslag'], ['notification', 'notifikationer', 'notifikation', 'Notifikationer']];
const saved = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch (e) { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(key, value); } catch (e) {} };
state.cal = {
  view: CAL_VIEWS.some(([v]) => v === saved('aulamcp-cal-view', '')) ? saved('aulamcp-cal-view', '') : 'maaned',
  anchor: '', hidden: new Set(), child: '', key: '', items: null, error: null, day: '',
  act: null, actOff: new Set(saved('aulamcp-cal-act-off', '').split(',').filter(Boolean)),
};
function calRange(c) {
  if (c.view === 'maaned') {
    const from = weekStart(c.anchor.slice(0, 8) + '01');
    const next = addDays(c.anchor.slice(0, 8) + '28', 4).slice(0, 8) + '01';
    return [from, addDays(weekStart(addDays(next, -1)), 7)];
  }
  if (c.view === 'liste') return [c.anchor, addDays(c.anchor, 56)];
  const from = weekStart(c.anchor);
  return [from, addDays(from, 7)];
}
function calStep(dir) {
  const c = state.cal;
  if (c.view === 'maaned') {
    const first = c.anchor.slice(0, 8) + '01';
    c.anchor = dir > 0 ? addDays(first, 32).slice(0, 8) + '01' : addDays(first, -1).slice(0, 8) + '01';
    c.day = '';
  } else c.anchor = addDays(c.anchor, dir * (c.view === 'liste' ? 28 : 7));
  calLoad();
}
function calTitle(c) {
  const [from, to] = calRange(c);
  if (c.view === 'maaned') return MONTH[+c.anchor.slice(5, 7) - 1] + ' ' + c.anchor.slice(0, 4);
  const last = addDays(to, -1);
  const span = +from.slice(8, 10) + '. ' + (from.slice(5, 7) !== last.slice(5, 7) ? MON[+from.slice(5, 7) - 1] + ' ' : '') + '– ' + +last.slice(8, 10) + '. ' + MON[+last.slice(5, 7) - 1] + ' ' + last.slice(0, 4);
  return c.view === 'uge' ? 'Uge ' + isoWeek(from) + ' · ' + span : span;
}
let calSeq = 0;
async function calLoad() {
  const c = state.cal;
  const [from, to] = calRange(c);
  const key = c.view + '|' + from;
  if (c.key !== key) {
    c.key = key; c.items = null; c.error = null;
    renderCal();
    c.act = null;
    const seq = ++calSeq;
    const until = Math.floor(midnight(to) / 1000) - 1;
    const act = c.view === 'liste' ? Promise.resolve({ days: [] })
      : getJson('data/activity?since=' + Math.floor(midnight(from) / 1000) + '&until=' + until).catch(() => ({ days: [] }));
    try {
      // Starts up to two weeks earlier, so a holiday that began before still shows.
      const [rows, a] = await Promise.all([calFetch(Math.floor(midnight(addDays(from, -14)) / 1000), until), act]);
      if (seq !== calSeq) return;
      c.items = rows.map(calEv).filter((e) => e && e.ek >= from && e.sk < to).sort(byStart);
      c.act = new Map((a.days || []).map((d) => [d.day, d.counts]));
    } catch (err) {
      if (seq !== calSeq) return;
      c.items = []; c.error = err.message; c.act = new Map();
    }
  }
  renderCal();
}
const childNames = () => {
  const m = new Map();
  for (const ch of (state.live && state.live.children) || []) if (typeof ch.id === 'number') m.set(String(ch.id), ch.name);
  return m;
};
function calVisible(c) {
  return (c.items || []).filter((e) => !c.hidden.has(e.type) &&
    (!c.child || !e.profiles.length || e.profiles.some((p) => String(p) === c.child)) &&
    (c.view !== 'liste' || !NOT_IN_AGENDA.includes(e.type)));
}

R.kalender = () => {
  if (state.summary && !database()) return [head('Kalender'), storageOff()];
  const c = state.cal;
  if (!c.anchor) c.anchor = dayKey(Date.now());
  queueMicrotask(calLoad);
  return [
    head('Kalender', 'Begivenheder, ferie og fridage fra Aula, gemt af synkroniseringen. Tiderne er dansk tid.'),
    el('section', { class: 'panel cal-tools' },
      el('div', { class: 'cal-bar' },
        el('div', { class: 'seg', role: 'group', 'aria-label': 'Visning' }, CAL_VIEWS.map(([v, l]) => el('button', { 'aria-pressed': String(c.view === v),
          onclick: () => { c.view = v; c.day = ''; save('aulamcp-cal-view', v); if (v === 'liste') c.anchor = dayKey(Date.now()); route(); } }, l))),
        el('div', { class: 'cal-nav' },
          el('button', { class: 'icon-btn', 'aria-label': 'Forrige', onclick: () => calStep(-1) }, icon('left')),
          el('button', { class: 'btn btn-sm', onclick: () => { c.anchor = dayKey(Date.now()); c.day = ''; calLoad(); } }, 'I dag'),
          el('button', { class: 'icon-btn', 'aria-label': 'Næste', onclick: () => calStep(1) }, icon('chev')))),
      el('div', { id: 'calFilters', class: 'cal-filters' })),
    el('div', { id: 'calBody', class: 'cal-body' }),
    state.owner ? null : feedPanel(),
  ];
};
/* The secret link a calendar app subscribes to. The link is shown once, right after it is made. */
state.feed = null;
function feedPanel() {
  const box = el('section', { class: 'panel', id: 'feedPanel' });
  const draw = (fresh) => {
    const f = state.feed;
    const made = el('button', { class: 'btn btn-primary btn-sm', onclick: () => askFeed(Boolean(f && f.active)) }, f && f.active ? 'Lav et nyt link' : 'Lav et link');
    fill(box,
      el('div', { class: 'panel-head' }, el('h2', {}, 'Abonnér i din egen kalender')),
      el('p', { class: 'muted small', style: 'margin:0' }, 'Et hemmeligt link, som din telefon eller kalender kan abonnere på. Det viser begivenheder, ferie og fridage fra de sidste 30 dage og frem, ikke skemaet. Kalenderen henter det selv, cirka en gang i timen.'),
      fresh ? el('div', { class: 'field' },
        el('label', { for: 'feedUrl' }, 'Dit link. Kopiér det nu, det vises kun én gang'),
        el('input', { class: 'input', id: 'feedUrl', readonly: true, value: fresh, onclick: (e) => e.target.select() }),
        el('p', { class: 'muted small' }, 'Vil du også have skemaet med, så sæt ?skema=1 bag på linket.')) : null,
      el('p', { class: 'muted small' }, !f ? 'Henter …' : f.active ? 'Linket virker. Lavet ' + rel(f.since) + (f.lastUsedAt ? ', sidst hentet ' + rel(f.lastUsedAt) : ', ikke hentet endnu') + '.' : 'Du har ikke noget link.'),
      el('p', { class: 'muted small' }, 'Alle med linket kan læse din kalender uden at logge ind. Del det ikke. Lav et nyt link, hvis det er kommet ud, så holder det gamle op med at virke.'),
      el('div', { class: 'dlg-actions', style: 'justify-content:flex-start' }, made,
        f && f.active ? el('button', { class: 'btn btn-sm', onclick: removeFeed }, 'Fjern linket') : null));
  };
  const askFeed = (replace) => confirmDialog({
    icon: 'cal', title: replace ? 'Lav et nyt link?' : 'Lav et kalenderlink?', ok: replace ? 'Lav nyt link' : 'Lav link',
    body: [el('p', {}, replace ? 'Det gamle link holder op med at virke med det samme. Du skal sætte det nye ind i din kalender.' : 'Alle med linket kan læse din Aula-kalender. Abonnerer du i Google eller Outlook, henter deres servere den.'),
      el('p', { class: 'muted small' }, 'Det står i din log under Deling.')],
    onok: async () => {
      try { const r = await postJson('data/calendar-feed', {}); state.feed = null; await load(); draw(r.url); }
      catch (err) { toast('Kunne ikke: ' + err.message); }
    },
  });
  const removeFeed = () => confirmDialog({
    danger: true, icon: 'trash', title: 'Fjern kalenderlinket?', ok: 'Fjern linket',
    body: [el('p', {}, 'Kalendere, der abonnerer på det, får ikke flere opdateringer.')],
    onok: async () => {
      try { await postJson('data/calendar-feed/remove', {}); await load(); draw(); toast('Kalenderlinket er fjernet'); }
      catch (err) { toast('Kunne ikke: ' + err.message); }
    },
  });
  const load = async () => { try { state.feed = await getJson('data/calendar-feed'); } catch (err) { state.feed = { active: false }; } };
  draw();
  load().then(() => draw());
  return box;
}
function renderCalFilters(c) {
  const box = $('calFilters'); if (!box) return;
  const present = new Set((c.items || []).map((e) => e.type));
  const types = Object.keys(EV_TYPES).filter((t) => (present.has(t) || c.hidden.has(t)) && (c.view !== 'liste' || !NOT_IN_AGENDA.includes(t)));
  for (const t of present) if (!EV_TYPES[t] && !types.includes(t)) types.push(t);
  const label = (t) => (EV_TYPES[t] ? EV_TYPES[t][0] : ((c.items || []).find((e) => e.type === t) || {}).label || t);
  const kids = childNames();
  const ids = [...new Set((c.items || []).flatMap((e) => e.profiles.map(String)))].filter((id) => kids.has(id));
  const acts = c.view === 'liste' ? [] : ACT_KINDS.filter(([k]) => c.actOff.has(k) || [...(c.act || new Map()).values()].some((n) => n[k]));
  const toggleAct = (k) => { c.actOff.has(k) ? c.actOff.delete(k) : c.actOff.add(k); save('aulamcp-cal-act-off', [...c.actOff].join(',')); renderCal(); };
  fill(box,
    acts.length ? el('div', { class: 'chips', role: 'group', 'aria-label': 'Aktivitet' },
      el('span', { class: 'muted small', style: 'align-self:center' }, 'Vis antal:'),
      acts.map(([k, , , label]) => el('button', { class: 'chip', 'aria-pressed': String(!c.actOff.has(k)), onclick: () => toggleAct(k) }, icon(kindOf(k).icon), ' ' + label))) : null,
    types.length ? el('div', { class: 'chips', role: 'group', 'aria-label': 'Type' },
      el('button', { class: 'chip', 'aria-pressed': String(!c.hidden.size), onclick: () => { c.hidden.clear(); renderCal(); } }, 'Alle typer'),
      types.map((t) => el('button', { class: 'chip ev-chip ev-' + evHue(t), 'aria-pressed': String(!c.hidden.has(t)),
        onclick: () => { c.hidden.has(t) ? c.hidden.delete(t) : c.hidden.add(t); renderCal(); } }, label(t)))) : null,
    ids.length > 1 || (c.child && ids.length) ? el('div', { class: 'chips', role: 'group', 'aria-label': 'Barn' },
      el('button', { class: 'chip', 'aria-pressed': String(!c.child), onclick: () => { c.child = ''; renderCal(); } }, 'Alle børn'),
      ids.map((id) => el('button', { class: 'chip', 'aria-pressed': String(c.child === id), onclick: () => { c.child = id; renderCal(); } }, kids.get(id)))) : null);
  box.hidden = !box.childNodes.length;
}
function renderCal() {
  const box = $('calBody'); if (!box) return;
  const c = state.cal;
  renderCalFilters(c);
  const title = el('h2', { class: 'cal-title' }, calTitle(c));
  if (c.items === null) { fill(box, title, skeleton()); return; }
  const evs = calVisible(c);
  fill(box, title,
    c.error ? banner('warn', 'warn', el('p', {}, 'Kunne ikke hente kalenderen: ' + c.error)) : null,
    c.view === 'maaned' ? calMonth(c, evs) : c.view === 'liste' ? calAgenda(c, evs) : calWeek(c, evs));
}
function calEmpty(title, text) {
  return el('div', { class: 'empty cal-empty' }, el('div', { class: 'empty-icon' }, icon('cal')), el('h3', {}, title),
    el('p', { class: 'small', style: 'max-width:44ch' }, text));
}
const SYNC_NOTE = 'Synkroniseringen henter kalenderen fra en uge tilbage til otte uger frem.';

/** The day's counts that are switched on, as [kind, n, many, one, label]. */
function actOf(c, k) {
  const n = (c.act && c.act.get(k)) || {};
  return ACT_KINDS.filter(([kind]) => n[kind] && !c.actOff.has(kind)).map(([kind, many, one, label]) => [kind, n[kind], many, one, label]);
}
const actText = (list) => list.map(([, n, many, one]) => plural(n, one, many)).join(', ');
function actRow(list) {
  if (!list.length) return null;
  return el('span', { class: 'act', title: actText(list) }, list.map(([kind, n]) => el('span', {}, icon(kindOf(kind).icon), fmt(n))));
}
/** Opens one stored item in Gennemse, with the day's list of its kind beside it. */
function openStored(kind, id, k) {
  const thread = kind === 'message' && id.includes(':');
  const key = thread ? 'message_thread/' + id.split(':')[0] : kind + '/' + id;
  state.browse = Object.assign(state.browse, { q: '', kind: thread ? 'message' : kind, range: 'dag:' + k, role: '', items: [], offset: 0, more: false, sel: key, detail: null });
  go('gennemse');
}
function openMedia(media) {
  state.gallery.focus = media.mediaId;
  location.hash = 'galleri/' + media.albumId;
}
/** The day's messages, photos, posts and notifications, for the list under the month. */
async function loadDayItems(c, k, kinds) {
  const key = k + '|' + kinds.join(',');
  if (c.dayItems && c.dayItems.key === key) return;
  c.dayItems = { key, items: null, error: null };
  const since = String(Math.floor(midnight(k) / 1000));
  const until = String(Math.floor(midnight(addDays(k, 1)) / 1000) - 1);
  try {
    const pages = await Promise.all(kinds.map((kind) => getJson('data/items?' + new URLSearchParams({ kind, since, until, limit: '100' }))));
    if (c.dayItems.key === key) c.dayItems.items = pages.flatMap((p) => p.items);
  } catch (err) {
    if (c.dayItems.key === key) c.dayItems.error = err.message;
  }
  if (c.dayItems.key === key) renderCal();
}
function dayItemList(c, k, act) {
  if (!act.length) return null;
  const kinds = act.map(([kind]) => kind);
  const d = c.dayItems && c.dayItems.key === k + '|' + kinds.join(',') ? c.dayItems : null;
  if (!d) queueMicrotask(() => loadDayItems(c, k, kinds));
  if (!d || (!d.items && !d.error)) return el('p', { class: 'muted small' }, 'Henter dagens ting…');
  if (d.error) return el('p', { class: 'error-text small' }, 'Kunne ikke hente dagens ting: ' + d.error);
  return act.map(([kind, n, many, , label]) => {
    const list = d.items.filter((it) => it.kind === kind);
    if (!list.length) return null;
    const more = n > list.length ? el('button', { class: 'btn btn-sm', onclick: () => browseDay(kind, k) }, 'Vis alle ' + fmt(n) + ' ' + many) : null;
    const body = kind === 'gallery_media'
      ? el('div', { class: 'media-grid day-media' }, list.map((it) => it.media
        ? el('button', { class: 'thumb', title: it.title, 'aria-label': it.subtitle + ': ' + it.title, onclick: () => openMedia(it.media) },
          lazyImg(mediaUrl('thumb', it.media.albumId, it.media.mediaId), it.subtitle === 'Video' ? 'play' : 'image'),
          it.subtitle === 'Video' ? el('span', { class: 'vid' }, icon('play'), 'Video') : null)
        : el('span', { class: 'thumb', title: it.title }, coverEmpty('image'))))
      : el('div', { class: 'list' }, list.map((it) => el('button', { class: 'result day-item', onclick: () => openStored(it.kind, it.id, k) },
        typeDot(it.kind),
        el('span', { style: 'min-width:0;display:block' },
          el('span', { class: 'result-top' }, el('span', { class: 'li-title' }, it.title), el('span', { class: 'result-date' }, clock(it.occurredAt))),
          it.subtitle ? el('span', { class: 'li-sub', style: 'display:block' }, it.subtitle) : null))));
    return el('div', { class: 'day-group' },
      el('h3', { class: 'day-group-head' }, icon(kindOf(kind).icon), label, el('span', { class: 'muted small num' }, fmt(n))),
      body, more);
  });
}
function browseDay(kind, k) {
  state.browse = Object.assign(state.browse, { q: '', kind, range: 'dag:' + k, role: '', items: [], offset: 0, more: false, sel: null, detail: null });
  go('gennemse');
}

/* uge: an all-day row, then timed events placed by the clock */
const HOUR = 44;
function calWeek(c, evs) {
  const [from] = calRange(c);
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const today = dayKey(Date.now());
  const allDay = new Map(days.map((k) => [k, []]));
  const timed = new Map(days.map((k) => [k, []]));
  for (const e of evs) {
    if (e.allDay) { for (const k of days) if (k >= e.sk && k <= e.ek) allDay.get(k).push(e); }
    else if (timed.has(e.sk)) timed.get(e.sk).push(e);
  }
  const anyAll = days.some((k) => allDay.get(k).length);
  const anyTimed = days.some((k) => timed.get(k).length);
  if (!anyAll && !anyTimed && !days.some((k) => actOf(c, k).length)) {
    return el('section', { class: 'panel' }, calEmpty('Ingen begivenheder i denne uge', 'Der er ikke gemt noget i kalenderen for uge ' + isoWeek(from) + '. ' + SYNC_NOTE));
  }
  const mins = (ms, k) => { const p = cphParts(ms); return dayKey(ms) === k ? p.h * 60 + p.min : 24 * 60; };
  let h0 = 8; let h1 = 16;
  for (const k of days) for (const e of timed.get(k)) { h0 = Math.min(h0, Math.floor(mins(e.start, k) / 60)); h1 = Math.max(h1, Math.ceil(Math.max(mins(e.end, k), mins(e.start, k) + 30) / 60)); }
  h1 = Math.min(h1, 24);
  const col = (k) => {
    const list = timed.get(k).map((e) => ({ e, s: mins(e.start, k), f: Math.max(mins(e.end, k), mins(e.start, k) + 30) }));
    // Side by side when they overlap: a lane each within a cluster.
    let cluster = []; let lanes = []; let reach = -1;
    const close = () => { for (const x of cluster) x.n = lanes.length; cluster = []; lanes = []; };
    for (const x of list.sort((a, b) => a.s - b.s)) {
      if (x.s >= reach) { close(); reach = -1; }
      let lane = lanes.findIndex((f) => f <= x.s);
      if (lane < 0) { lane = lanes.length; lanes.push(0); }
      lanes[lane] = x.f; x.lane = lane; reach = Math.max(reach, x.f); cluster.push(x);
    }
    close();
    const now = Date.now();
    return el('div', { class: 'wk-col' + (k === today ? ' today' : ''), style: 'height:' + (h1 - h0) * HOUR + 'px' },
      k === today && mins(now, k) >= h0 * 60 && mins(now, k) <= h1 * 60 ? el('span', { class: 'wk-now', style: 'top:' + ((mins(now, k) - h0 * 60) / 60) * HOUR + 'px' }) : null,
      list.map((x) => el('button', { class: 'wk-ev ev-' + evHue(x.e.type) + (x.f - x.s < 50 ? ' short' : ''), onclick: () => openEvent(x.e), title: x.e.title + ' · ' + evTime(x.e),
        style: 'top:' + ((x.s - h0 * 60) / 60) * HOUR + 'px;height:' + Math.max(((x.f - x.s) / 60) * HOUR - 2, 20) + 'px;left:calc(' + (x.lane * 100) / x.n + '% + 2px);width:calc(' + 100 / x.n + '% - 4px)' },
        el('strong', {}, x.e.title), el('span', {}, cphHm(x.e.start)))));
  };
  const grid = el('section', { class: 'panel wk-panel' }, el('div', { class: 'wk' },
    el('div', { class: 'wk-corner' }),
    days.map((k) => el('div', { class: 'wk-head' + (k === today ? ' today' : '') }, el('span', {}, DAY[dow(k)]), el('b', {}, +k.slice(8, 10)), actRow(actOf(c, k)))),
    anyAll ? [el('div', { class: 'wk-gut wk-adl' }, 'Hele dagen'), days.map((k) => el('div', { class: 'wk-ad' },
      allDay.get(k).map((e) => el('button', { class: 'wk-chip ev-' + evHue(e.type), onclick: () => openEvent(e), title: e.title }, e.title))))] : null,
    anyTimed ? [el('div', { class: 'wk-gut wk-hours', style: 'height:' + (h1 - h0) * HOUR + 'px' },
      Array.from({ length: h1 - h0 }, (_, i) => el('span', { style: 'top:' + i * HOUR + 'px' }, pad(h0 + i) + ':00'))), days.map(col)]
      : el('p', { class: 'wk-none muted small' }, 'Ingen begivenheder med klokkeslæt i denne uge.')));
  const phone = el('section', { class: 'panel wk-list' }, el('div', { class: 'list' }, days.map((k) => {
    const list = allDay.get(k).concat(timed.get(k));
    return el('div', { class: 'wk-day' },
      el('div', { class: 'wk-day-head' }, el('strong', {}, longDay(k)), k === today ? el('span', { class: 'pill run' }, 'I dag') : null, actRow(actOf(c, k))),
      list.length ? list.map((e) => evRow(e, false)) : el('p', { class: 'muted small' }, 'Ingen begivenheder'));
  })));
  return [grid, phone];
}

/* måned: a grid of days; click one for its list */
function calMonth(c, evs) {
  const [from, to] = calRange(c);
  const month = c.anchor.slice(0, 7);
  const today = dayKey(Date.now());
  const by = new Map();
  for (const e of evs) {
    for (let k = e.sk > from ? e.sk : from, i = 0; k <= e.ek && k < to && i < 62; k = addDays(k, 1), i++) {
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(e);
    }
  }
  if (!c.day && today.slice(0, 7) === month) c.day = today;
  const days = [];
  for (let k = from; k < to; k = addDays(k, 1)) days.push(k);
  const cell = (k) => {
    const list = by.get(k) || [];
    const act = actOf(c, k);
    const total = act.reduce((sum, [, n]) => sum + n, 0);
    return el('button', { class: 'mo-day' + (k.slice(0, 7) !== month ? ' out' : '') + (k === today ? ' today' : ''), 'aria-pressed': String(c.day === k),
      'aria-label': [longDay(k), plural(list.length, 'begivenhed', 'begivenheder'), actText(act)].filter(Boolean).join(', '), onclick: () => { c.day = k; renderCal(); } },
      el('span', { class: 'mo-num' }, +k.slice(8, 10)),
      list.slice(0, 3).map((e) => el('span', { class: 'mo-chip ev-' + evHue(e.type) }, e.title)),
      list.length > 3 ? el('span', { class: 'mo-more' }, '+' + (list.length - 3) + ' flere') : null,
      list.length ? el('span', { class: 'mo-dots', 'aria-hidden': 'true' }, list.slice(0, 4).map((e) => el('i', { class: 'ev-' + evHue(e.type) }))) : null,
      actRow(act),
      total ? el('span', { class: 'mo-total', 'aria-hidden': 'true' }, fmt(total)) : null);
  };
  const sel = c.day ? (by.get(c.day) || []) : null;
  const selAct = c.day ? actOf(c, c.day) : [];
  return [
    el('section', { class: 'panel mo-panel' }, el('div', { class: 'mo' },
      ['man.', 'tir.', 'ons.', 'tor.', 'fre.', 'lør.', 'søn.'].map((d) => el('div', { class: 'mo-dow' }, d)),
      days.map(cell)),
      !evs.length && !c.act?.size ? el('p', { class: 'muted small mo-note' }, 'Ingen begivenheder i ' + MONTH[+month.slice(5, 7) - 1] + '. ' + SYNC_NOTE) : null),
    sel ? el('section', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('h2', {}, longDay(c.day).replace(/^./, (ch) => ch.toUpperCase())), el('span', { class: 'muted small' }, plural(sel.length, 'begivenhed', 'begivenheder'))),
      selAct.length ? el('div', { class: 'act-links', role: 'group', 'aria-label': 'Aktivitet denne dag' },
        selAct.map(([kind, n, many, one]) => el('button', { class: 'chip', onclick: () => browseDay(kind, c.day), title: 'Vis dagens ' + many }, icon(kindOf(kind).icon), ' ' + plural(n, one, many)))) : null,
      sel.length ? el('div', { class: 'list' }, sel.map((e) => evRow(e, false))) : el('p', { class: 'muted small' }, 'Ingen begivenheder denne dag.'),
      dayItemList(c, c.day, selAct))
      : el('p', { class: 'muted small' }, 'Vælg en dag for at se dens begivenheder.'),
  ];
}

/* begivenheder: what is coming, by day, with what needs an answer */
function calAgenda(c, evs) {
  const [from] = calRange(c);
  if (!evs.length) {
    return el('section', { class: 'panel' }, calEmpty('Ingen kommende begivenheder', 'Der er ingen begivenheder, møder eller udflugter de næste otte uger. Ferie, fridage og lektioner ses under Uge og Måned.'));
  }
  const groups = new Map();
  for (const e of evs) { const k = e.sk > from ? e.sk : from; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
  const open = evs.filter((e) => e.rr && (!e.resp || e.resp === 'Ikke besvaret')).length;
  return [
    open ? banner('warn', 'warn', el('p', {}, el('strong', {}, plural(open, 'begivenhed', 'begivenheder') + ' venter på dit svar. '), 'Svar i Aula; aula-mcp svarer ikke for dig.')) : null,
    el('section', { class: 'panel' }, el('div', { class: 'list' }, [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, list]) => el('div', { class: 'ag-day' },
      dateTile(k),
      el('div', { style: 'min-width:0' }, el('p', { class: 'eyebrow' }, longDay(k)), el('div', { class: 'list' }, list.map((e) => evRow(e, false)))))))),
  ];
}

function calDialog() {
  let d = $('calDlg');
  if (!d) {
    d = el('dialog', { id: 'calDlg', 'aria-labelledby': 'calDlgTitle' }, el('div', { class: 'dlg', id: 'calDlgBody' }));
    document.body.append(d);
    d.addEventListener('click', (ev) => { if (ev.target === d) d.close(); });
  }
  return d;
}
async function openEvent(e) {
  const d = calDialog();
  const body = $('calDlgBody');
  const draw = (extra) => fill(body,
    el('div', { class: 'panel-head', style: 'margin:0;align-items:flex-start' }, typePill(e), el('button', { class: 'icon-btn', 'aria-label': 'Luk', onclick: () => d.close() }, icon('x'))),
    el('h2', { id: 'calDlgTitle', style: 'font-size:1.3rem;overflow-wrap:anywhere' }, e.title),
    el('p', { class: 'muted' }, (e.allDay && e.sk === e.ek ? longDay(e.sk) + ', hele dagen' : e.allDay ? evTime(e) : longDay(e.sk) + ', ' + evTime(e)) + (e.place ? ' · ' + e.place : '')),
    e.rr ? el('div', { class: 'result-foot' }, responseBadges(e)) : null,
    extra,
    el('div', { class: 'dlg-actions' }, el('button', { class: 'btn', onclick: () => { d.close(); openItem({ kind: 'calendar_event', id: e.id }); } }, 'Åbn i Gennemse'),
      el('button', { class: 'btn btn-primary', onclick: () => d.close() }, 'Luk')));
  draw(skeleton());
  if (!d.open) d.showModal();
  try {
    const it = (await getJson('data/items/calendar_event/' + encodeURIComponent(e.id))).item;
    const fields = it.fields.filter(([k]) => k !== 'Starter' && k !== 'Slutter' && k !== 'Type' && k !== 'Sted' && k !== 'Svar' && k !== 'Svarfrist');
    draw([fields.length ? el('dl', { class: 'kv' }, fields.map(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])) : null,
      it.body ? el('p', { class: 'pre', style: 'max-height:40vh;overflow:auto' }, it.body) : null]);
  } catch (err) { draw(el('p', { class: 'error-text' }, 'Kunne ikke hente: ' + err.message)); }
}

/* oversigt: the next few things on the calendar */
state.calNext = null;
let calNextAt = 0;
async function loadNextEvents() {
  const now = Date.now();
  try {
    const rows = await calFetch(Math.floor(now / 1000) - 14 * 86400, Math.floor(now / 1000) + 60 * 86400);
    state.calNext = rows.map(calEv).filter((e) => e && e.end >= now && e.type !== 'lesson').sort(byStart).slice(0, 4);
  } catch { state.calNext = []; }
  rerender('oversigt');
}
function nextEventsPanel() {
  if (!database()) return null;
  if (Date.now() - calNextAt > 60000) { calNextAt = Date.now(); loadNextEvents(); }
  const list = state.calNext;
  return el('section', { class: 'panel' },
    el('div', { class: 'panel-head' }, el('h2', {}, 'Næste begivenheder'), el('button', { class: 'linkish', 'data-go': 'kalender' }, 'Åbn kalender')),
    list === null ? el('div', { class: 'skel-panel' }, el('div', { class: 'skeleton', style: 'width:60%' }), el('div', { class: 'skeleton', style: 'width:40%' }))
      : list.length ? el('div', { class: 'ev-cards' }, list.map((e) => evRow(e, true)))
        : el('p', { class: 'muted small' }, 'Intet i kalenderen de næste otte uger.'));
}

/* ---------- afsendere: forælder, personale, barn eller system ---------- */
const ROLES = [['guardian', 'Forældre', 'Forælder'], ['employee', 'Personale', 'Personale'], ['child', 'Børn', 'Barn'], ['other', 'System', 'System']];
const roleOne = (r) => (ROLES.find((x) => x[0] === r) || [])[2];
const roleBadge = (r) => (roleOne(r) ? el('span', { class: 'role-badge role-' + r }, roleOne(r)) : null);
const isMsgKind = (k) => k === 'message' || k === 'message_thread';
state.roles = null;
let rolesAt = 0;
function ensureRoles(after) {
  if (!database() || Date.now() - rolesAt < 60000) return;
  rolesAt = Date.now();
  getJson('data/messages/roles').then((d) => { state.roles = d; after(); }).catch(() => {});
}
function browseRole(kind, role) {
  state.browse = Object.assign(state.browse, { q: '', kind, range: '', role, items: [], offset: 0, more: false, sel: null, detail: null });
  go('gennemse');
}
function roleCounts() {
  ensureRoles(() => rerender('oversigt'));
  const n = state.roles && state.roles.threads;
  if (!n) return null;
  return el('span', { class: 'role-counts' }, ROLES.filter(([r]) => r !== 'other' || n.other).map(([r, many]) =>
    el('button', { class: 'role-badge role-' + r, onclick: () => browseRole('message_thread', r), title: 'Vis tråde, hvor ' + many.toLowerCase() + ' skrev sidst' }, many + ' ', el('span', { class: 'num' }, fmt(n[r])))));
}
function renderRoleChips() {
  const box = $('roleChips'); if (!box) return;
  const b = state.browse;
  box.hidden = !isMsgKind(b.kind);
  if (box.hidden) { fill(box); return; }
  ensureRoles(renderRoleChips);
  const n = state.roles && (b.kind === 'message' ? state.roles.messages : state.roles.threads);
  const cur = b.role || '';
  fill(box, el('span', { class: 'muted small', style: 'align-self:center;margin-right:2px' }, 'Afsender'),
    [['', 'Alle']].concat(ROLES).map(([r, many]) => el('button', { class: 'chip', 'aria-pressed': String(cur === r),
      onclick: () => { b.role = r; loadResults(false); } }, many, n && r ? el('span', { class: 'c' }, fmt(n[r])) : null)));
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

/* ---------- log ---------- */
const AUDIT_LABEL = { sync: 'Synkronisering', aula: 'Handlinger i Aula', account: 'Login', sharing: 'Deling', data: 'Sletning', storage: 'Lagring' };
const AUDIT_DETAIL = {
  trigger: 'Startet af', fetched: 'Hentet', changed: 'Ændret', skipped: 'Sprunget over', more: 'Mere at hente', failuresInARow: 'Fejl i træk',
  deleted: 'Slettet', kind: 'Type', email: 'E-mail', claimed: 'Hentet ind', threadId: 'Tråd', messageId: 'Besked', subscriptionId: 'Abonnement',
  children: 'Børn', date: 'Dato', characters: 'Tegn', reencrypted: 'Krypteret igen', unreadable: 'Ulæselige', keyId: 'Nøgle',
  parents: 'Forældre', itemsRead: 'Læst', itemsCopied: 'Kopieret', renamedTo: 'Gammel fil',
};
const TRIGGER = { schedule: 'tidsplan', manual: 'dig, Kør nu', tool: 'AI-assistent', dashboard: 'dashboard' };
const auditAction = (e) => (e.category === 'sync' ? (e.action === 'check' ? 'Tjek af login' : jobLabel(e.action)) : e.action.replace(/_/g, ' '));
async function loadAudit(more) {
  const a = state.audit;
  if (a.loading) return;
  a.loading = true;
  const q = new URLSearchParams({ limit: '100' });
  if (a.category) q.set('category', a.category);
  if (a.failed) q.set('ok', 'false');
  const last = more && a.events.length ? a.events[a.events.length - 1] : null;
  if (last) q.set('before', String(last.at));
  try {
    const data = await getJson('data/audit?' + q);
    a.available = data.available;
    a.key = data.key || null;
    a.events = last ? a.events.concat(data.events) : data.events;
    a.more = data.events.length === 100;
    a.error = null;
  } catch (err) { a.error = err.message; }
  a.loading = false;
  a.loaded = true;
  rerender('log');
}
function auditFilter(patch) { Object.assign(state.audit, patch, { events: [], more: false }); loadAudit(false); rerender('log'); }
R.log = () => {
  const a = state.audit;
  const top = head('Log', 'Hvad aula-mcp har gjort for dig de seneste 30 dage: synkroniseringer, handlinger i Aula, login, deling og sletning. Kun antal og numre, aldrig indholdet af beskeder.',
    el('button', { class: 'btn', disabled: a.loading, onclick: () => auditFilter({}) }, icon('sync'), 'Opdater'));
  if (!a.loaded) { loadAudit(false); return [top, skeleton()]; }
  if (a.error && !a.events.length) return [top, banner('warn', 'warn', el('p', {}, 'Kunne ikke hente loggen: ' + a.error))];
  if (!a.available) return [top, storageOff()];
  const k = a.key;
  const chip = (label, pressed, onclick) => el('button', { class: 'chip', 'aria-pressed': String(pressed), onclick }, label);
  return [
    top,
    k ? banner(k.stale ? 'warn' : 'info', k.stale ? 'warn' : 'lock', el('p', {},
      el('strong', {}, 'Lagringsnøgle ' + k.keyId + '. '),
      k.stale ? fmt(k.stale) + ' rækker er stadig krypteret med en tidligere nøgle og krypteres igen ved næste genstart.' : 'Alle dine data er krypteret med den nuværende nøgle.',
      k.previousKeys ? ' ' + k.previousKeys + ' tidligere nøgle' + (k.previousKeys > 1 ? 'r' : '') + ' kan stadig læses.' : '')) : null,
    el('div', { class: 'chips', style: 'margin-bottom:12px' },
      chip('Alle', !a.category, () => auditFilter({ category: '' })),
      Object.keys(AUDIT_LABEL).map((c) => chip(AUDIT_LABEL[c], a.category === c, () => auditFilter({ category: c }))),
      chip('Kun fejl', a.failed, () => auditFilter({ failed: !a.failed }))),
    el('section', { class: 'panel' },
      a.events.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'count-table' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Tid'), el('th', {}, 'Hvad'), el('th', {}, 'Status'), el('th', { class: 'hide-sm' }, 'Detaljer'))),
        el('tbody', {}, a.events.map((e) => el('tr', {},
          el('td', { style: 'white-space:nowrap' }, rel(new Date(e.at)), el('br'), el('span', { class: 'muted small' }, hm(new Date(e.at)) + ':' + pad(new Date(e.at).getSeconds()))),
          el('td', {}, el('strong', {}, auditAction(e)), el('br'), el('span', { class: 'muted small' }, AUDIT_LABEL[e.category] || e.category)),
          el('td', {}, el('span', { class: 'pill ' + (e.ok ? 'ok' : 'err') }, e.ok ? 'OK' : 'Fejl'),
            e.durationMs ? el('div', { class: 'muted small' }, e.durationMs < 1000 ? e.durationMs + ' ms' : (e.durationMs / 1000).toFixed(1) + ' s') : null),
          el('td', { class: 'hide-sm small' },
            e.details.error ? el('div', { class: 'errbox' }, String(e.details.error)) : null,
            Object.keys(e.details).filter((d) => d !== 'error').map((d) => el('span', { style: 'margin-right:12px;white-space:nowrap' },
              el('span', { class: 'muted' }, (AUDIT_DETAIL[d] || d) + ': '),
              d === 'trigger' ? (TRIGGER[e.details[d]] || String(e.details[d])) : typeof e.details[d] === 'boolean' ? (e.details[d] ? 'ja' : 'nej') : String(e.details[d])))))))))
        : el('p', { class: 'muted' }, a.failed ? 'Ingen fejl i perioden.' : 'Intet i loggen endnu.'),
      a.more ? el('div', { style: 'margin-top:12px' }, el('button', { class: 'btn btn-sm', disabled: a.loading, onclick: () => loadAudit(true) }, a.loading ? 'Henter…' : 'Vis ældre')) : null),
  ];
};

/* ---------- galleri ---------- */
const GALLERY_LEDE = 'Billeder og videoer fra Aula, hentet i original kvalitet og ordnet pr. barn og år.';
const mediaUrl = (variant, albumId, mediaId, download) => withOwner(
  'data/gallery/' + variant + '/' + encodeURIComponent(String(albumId)) + '/' + encodeURIComponent(String(mediaId)) + (download ? '?download=1' : ''));
const isVideo = (m) => String(m.type || '').toLowerCase().includes('video');
const galleryStatus = () => (state.gallery.data ? state.gallery.data.status : null);
const galleryJob = () => (state.sync && state.sync.jobs ? state.sync.jobs.find((j) => j.job === 'gallery') : null);
const galleryBusy = () => { const j = galleryJob(); return Boolean(j && (j.running || j.queued)); };
/** 2026-11-18 as 18. nov. 2026, without a trip through time zones. */
function dayText(ymd) {
  const [y, m, d] = String(ymd || '').split('-').map(Number);
  return y && m && d ? d + '. ' + MON[m - 1] + ' ' + y : 'Uden dato';
}
function postInHash() {
  const parts = location.hash.slice(1).split('/');
  return parts[1] === 'opslag' && parts[2] ? decodeURIComponent(parts[2]) : null;
}
function postAlbumCard(p) {
  const cover = p.media.find((m) => isPicture(m.mediaType));
  return el('button', { class: 'album', onclick: () => { location.hash = 'galleri/opslag/' + encodeURIComponent(p.postId); } },
    el('span', { class: 'album-cover' }, cover ? lazyImg(attachUrl('post', p.postId, cover.index), 'image') : coverEmpty('image')),
    el('span', { class: 'album-title' }, p.title),
    el('span', { class: 'album-sub' }, (p.date ? dayText(p.date) : 'Uden dato') + (p.author ? ' · ' + p.author : '')),
    el('span', { class: 'album-sub num' }, plural(p.media.length, 'fil', 'filer') + ' · fra opslag'));
}
function postAlbumView(id) {
  const g = state.gallery;
  const back = el('div', {}, el('button', { class: 'btn btn-sm', onclick: () => { location.hash = 'galleri'; } }, icon('left'), 'Alle album'));
  if ((g.stale || (!g.data && !g.error)) && !g.loading) loadGallery();
  if (!g.data) return [back, skeleton()];
  const p = (g.data.posts || []).find((x) => x.postId === id);
  if (!p) return [back, head('Album'), el('section', { class: 'panel empty' }, el('p', {}, el('strong', {}, 'Opslaget har ingen gemte billeder.')))];
  return [
    back,
    el('div', { class: 'view-head' },
      el('div', { style: 'min-width:0' },
        el('p', { class: 'eyebrow' }, 'Fra opslag'),
        el('h1', { style: 'overflow-wrap:anywhere' }, p.title),
        el('p', { class: 'lede' }, [p.date ? dayText(p.date) : 'Uden dato', p.author, plural(p.media.length, 'fil', 'filer')].filter(Boolean).join(' · ')))),
    banner('info', 'info', el('p', {}, 'Albummet er lavet her ud fra billederne i opslaget. Det findes ikke i Aulas galleri.')),
    attachMedia('post', p.postId, p.media) || el('section', { class: 'panel empty' }, el('p', {}, 'Ingen billeder, browseren kan vise.')),
  ];
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
  const owner = state.owner;
  try {
    const d = await getJson('data/gallery' + (child ? '?child=' + encodeURIComponent(child) : ''));
    if (child === g.child && owner === state.owner) { g.data = d; g.error = null; } else g.stale = true;
  } catch (err) {
    if (owner === state.owner) g.error = { status: err.status, message: err.message };
  }
  g.loading = false;
  for (const view of ['galleri', 'oversigt', 'gemt']) rerender(view);
}
async function loadAlbum(id) {
  const g = state.gallery;
  const owner = state.owner;
  g.albumLoading = true;
  g.stale = false;
  if (g.albumFor !== id) { g.album = null; g.albumError = null; g.albumFor = id; }
  try {
    const d = await getJson('data/gallery/albums/' + encodeURIComponent(String(id)));
    if (owner !== state.owner) { g.albumLoading = false; g.stale = true; rerender('galleri'); return; }
    if (g.albumFor === id) { g.album = d; g.albumError = null; }
    // Came from a day in the calendar: show that photo straight away.
    const focus = g.focus;
    g.focus = null;
    const at = focus != null && g.albumFor === id ? d.media.findIndex((m) => m.id === focus) : -1;
    if (at >= 0) queueMicrotask(() => openLightbox(at));
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
    ] : el('p', { class: 'muted small', style: 'margin-top:12px' }, st.store === 's3' ? 'Filerne gemmes i ' + st.location + '. S3 har ingen fast grænse, så hentningen holder aldrig pause for plads.' : 'Kunne ikke læse, hvor meget plads der er på disken.'));
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
  const postId = postInHash();
  if (postId !== null) return postAlbumView(postId);
  const albumId = albumInHash();
  if (albumId !== null) return albumView(albumId);
  if ((g.stale || (!g.data && !g.error)) && !g.loading) loadGallery();
  const top = head('Galleri', state.owner ? 'Album og billeder, som ' + ownerName() + ' har, og som du ikke selv har.' : GALLERY_LEDE, g.data && !state.owner ? runGallery() : null);
  if (g.error && !g.data) return [top, g.error.status === 404 ? galleryOff() : banner('warn', 'warn', el('p', {}, 'Kunne ikke hente galleriet: ' + g.error.message))];
  if (!g.data) return [top, el('div', { class: 'grid-2' }, skeleton(), skeleton())];
  const st = g.data.status;
  const paused = st.disk && st.disk.used >= st.stopAt;
  const years = [...new Set(g.data.albums.map((a) => a.year)
    .concat((g.data.posts || []).map((p) => (p.date || '').slice(0, 4)).filter(Boolean), g.year ? [g.year] : []))].sort().reverse();
  const list = g.data.albums.filter((a) => !g.year || a.year === g.year);
  const posts = (g.data.posts || []).filter((p) => !g.year || (p.date || '').startsWith(g.year));
  const kids = st.children.filter((c) => c.albums > 0);
  const chip = (value, label, n) => el('button', { class: 'chip', 'aria-pressed': String(g.child === value),
    onclick: () => { if (g.child === value) return; g.child = value; g.stale = true; rerender('galleri'); } }, label, el('span', { class: 'c' }, fmt(n)));
  const year = el('select', { class: 'input', id: 'gyear', onchange: (e) => { g.year = e.target.value; rerender('galleri'); } },
    el('option', { value: '' }, 'Alle år'), years.map((y) => el('option', { value: y, selected: g.year === y ? true : null }, y)));
  return [
    top,
    !st.downloads ? banner('info', 'info', el('p', {}, el('strong', {}, 'Filerne hentes ikke på denne server. '), 'Albummene vises fra listen i Aula, men billeder og videoer bliver ikke gemt, så længe serveren kører med ', el('code', {}, 'AULA_MCP_GALLERY=0'), '.')) : null,
    st.downloads && paused ? banner('warn', 'warn', el('p', {}, el('strong', {}, 'Hentningen holder pause. '), 'Disken er ' + pct(st.disk.used) + ' fuld, og grænsen er ' + pct(st.stopAt) + '. Slet album her, eller giv serveren mere plads, så fortsætter den ved næste kørsel.')) : null,
    state.owner ? null : el('div', { class: 'grid-2' }, storagePanel(st), downloadPanel(st)),
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
    posts.length ? el('section', { 'aria-label': 'Album fra opslag' },
      el('div', { class: 'panel-head' }, el('h2', {}, 'Fra opslag'), el('span', { class: 'muted small' }, plural(posts.length, 'opslag', 'opslag') + ' med billeder')),
      el('div', { class: 'albums' }, posts.map(postAlbumCard))) : null,
    !state.owner && (st.albums || st.downloaded) ? el('section', { class: 'danger-zone' },
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
      a.removed || state.owner ? null : el('button', { class: 'btn btn-ghost-danger', onclick: () => askGalleryDelete(a) }, icon('trash'), 'Slet album')),
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
/** Opens the viewer on an album's media, or on a list of {src, video, name, download} from a post or message. */
function openLightbox(i, list) {
  state.gallery.lbList = list || null;
  state.gallery.lb = i;
  renderLightbox();
  const dlg = $('lightbox');
  if (!dlg.open) dlg.showModal();
}
function stepLightbox(step) {
  const d = state.gallery.album;
  const list = state.gallery.lbList;
  const n = list ? list.length : d ? d.media.length : 0;
  if (n < 2) return;
  state.gallery.lb = (state.gallery.lb + step + n) % n;
  renderLightbox();
}
function renderListLightbox(list) {
  const i = state.gallery.lb;
  const m = list[i];
  if (!m) { $('lightbox').close(); return; }
  const n = list.length;
  $('lightbox').setAttribute('aria-label', m.name);
  fill($('lbBody'),
    el('div', { class: 'lb-stage' },
      m.video ? el('video', { src: m.src, controls: true, preload: 'metadata', playsinline: true }) : el('img', { src: m.src, alt: m.name }),
      n > 1 ? [el('button', { class: 'lb-nav lb-prev', 'aria-label': 'Forrige', onclick: () => stepLightbox(-1) }, icon('left')),
        el('button', { class: 'lb-nav lb-next', 'aria-label': 'Næste', onclick: () => stepLightbox(1) }, icon('chev'))] : null,
      el('button', { class: 'lb-close', 'aria-label': 'Luk', onclick: () => $('lightbox').close() }, icon('x'))),
    el('div', { class: 'lb-info' },
      el('div', { style: 'min-width:0' }, el('strong', { style: 'overflow-wrap:anywhere' }, m.name), el('span', { class: 'muted num' }, ' · ' + (i + 1) + ' af ' + n),
        m.size ? el('div', { class: 'muted small' }, size(m.size)) : null),
      el('a', { class: 'btn btn-sm', href: m.download, download: m.name }, icon('download'), 'Hent fil')));
}
function renderLightbox() {
  if (state.gallery.lbList) { renderListLightbox(state.gallery.lbList); return; }
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
/* ---------- deling ---------- */
R.deling = () => {
  const s = state.share;
  const lede = 'Del dine gemte Aula-data med den anden forælder. De kan kun læse dem og ser kun det, de ikke selv har, fx beskeder sendt til dig alene.';
  if (!s) { loadShares(); return [head('Deling', lede), skeleton()]; }
  if (!s.available) {
    return [head('Deling', lede), banner('info', 'info', el('p', {}, el('strong', {}, 'Deling findes ikke på denne server. '), s.error ? 'Kunne ikke hente: ' + s.error : 'Den kræver flere forældre med hver sit login og lokal lagring.'))];
  }
  const email = el('input', { class: 'input', id: 'shareEmail', type: 'email', autocomplete: 'off', placeholder: 'den.anden@forælder.dk', 'aria-label': 'Email' });
  const add = async (e) => {
    e.preventDefault();
    const value = email.value.trim();
    if (!value) return;
    try {
      s.granted = (await postJson('data/shares', { email: value })).granted;
      toast('Delt med ' + value + '.');
      rerender('deling');
    } catch (err) { toast('Kunne ikke dele: ' + err.message); }
  };
  const remove = async (g) => {
    try {
      s.granted = (await postJson('data/shares/remove', { email: g.email })).granted;
      toast('Deling med ' + g.email + ' er fjernet.');
      rerender('deling');
    } catch (err) { toast('Kunne ikke fjerne: ' + err.message); }
  };
  if (state.owner) {
    return [head('Deling'), el('section', { class: 'panel' }, el('p', {}, 'Du ser lige nu det, ' + ownerName() + ' deler med dig. Gå tilbage til dine egne data for at styre, hvem du deler med.'))];
  }
  return [
    head('Deling', lede),
    s.email ? null : banner('warn', 'warn', el('p', {}, el('strong', {}, 'Din konto har ingen bekræftet email. '), 'Du kan dele dine data, men andre kan ikke dele med dig, før din email er bekræftet i login-systemet.')),
    el('section', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('h2', {}, 'Del med en forælder')),
      el('div', { class: 'lock-list' },
        el('div', {}, icon('key'), el('p', {}, el('strong', {}, 'Med deres email. '), 'Skriv den email, de logger ind her med. Delingen starter, første gang de logger ind på dette dashboard.')),
        el('div', {}, icon('lock'), el('p', {}, el('strong', {}, 'Kun læse. '), 'De kan se dine gemte beskeder, opslag, kalender og billeder, men ikke synkronisere, slette eller skrive i Aula. Dit Aula-login deles aldrig.')),
        el('div', {}, icon('tools'), el('p', {}, el('strong', {}, 'Også for deres assistent. '), 'Deres AI-assistent kan læse det samme, read-only, via ', el('code', {}, 'aula.local.shared_with_me'), '.'))),
      el('form', { class: 'share-form', onsubmit: add }, email, el('button', { class: 'btn btn-primary', type: 'submit' }, icon('group'), 'Del'))),
    el('section', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('h2', {}, 'Du deler med')),
      s.granted.length
        ? el('div', {}, s.granted.map((g) => el('div', { class: 'share-row' },
          el('div', { class: 'grow' }, el('strong', {}, g.email), el('div', { class: 'muted small' }, 'Siden ' + longDate(g.since))),
          g.active ? el('span', { class: 'pill ok' }, 'Aktiv') : el('span', { class: 'pill neutral' }, 'Venter på login'),
          el('button', { class: 'btn btn-sm btn-ghost-danger', onclick: () => remove(g) }, 'Fjern'))))
        : el('p', { class: 'muted' }, 'Du deler ikke med nogen.')),
    el('section', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('h2', {}, 'Delt med dig')),
      s.shared_with_me.length
        ? el('div', {}, s.shared_with_me.map((o) => el('div', { class: 'share-row' },
          el('div', { class: 'grow' }, el('strong', {}, o.name), el('div', { class: 'muted small' }, 'Siden ' + longDate(o.since))),
          el('button', { class: 'btn btn-sm', onclick: () => setOwner(o.owner) }, 'Vis'))))
        : el('p', { class: 'muted' }, 'Ingen deler med dig endnu.')),
  ];
};

/** Slet data, at the bottom of Gemt om dig. */
function deleteSections() {
  const kinds = Object.keys(KINDS).filter((k) => !k.startsWith('gallery_') && (KINDS[k].synced || countOf(k) > 0));
  const g = state.gallery;
  if ((g.stale || (!g.data && !g.error)) && !g.loading) loadGallery();
  const gst = galleryStatus();
  const galleryRow = g.error && !gst ? null : el('div', { class: 'del-row' },
    el('div', { class: 'del-name' }, typeDot('gallery_album'), el('div', { style: 'min-width:0' }, el('strong', {}, 'Galleri'),
      el('div', { class: 'li-sub num' }, !gst ? 'Henter…' : gst.albums ? plural(gst.albums, 'album', 'album') + ' · ' + plural(gst.downloaded, 'fil', 'filer') + ' · ' + size(gst.bytes) + '. Hentes ikke igen.' : 'Intet gemt'))),
    el('button', { class: 'btn btn-sm btn-ghost-danger', disabled: !gst || !(gst.albums || gst.downloaded), onclick: () => askGalleryDelete(null) }, icon('trash'), 'Slet'));
  return [
    el('div', { class: 'view-head', id: 'sletData', style: 'margin-top:12px' },
      el('div', {}, el('h2', {}, 'Slet data'), el('p', { class: 'lede' }, 'Sletter din lokale kopi hos aula-mcp. Det rører ikke noget i Aula. Næste synkronisering henter det, Aula stadig har, igen.'))),
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
}
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
    ownerPick('ownerPickMore'),
    el('div', { class: 'nav-list' }, visibleViews().filter((v) => !v.bottom).map((v) => navButton(v, cur, 'nav-item'))),
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
  if (signedInAs && database()) loadShares();
  pollSync();
  if (database()) {
    if (!state.gallery.data && !state.gallery.loading) loadGallery();
    getJson('data/items?limit=5').then((d) => { state.recent = d.items; }).catch(() => { state.recent = []; }).then(() => rerender('oversigt'));
  }
  if (loggedIn()) { await loadLive(); rerender('oversigt'); rerender('kalender'); }
})();
})();
`;
