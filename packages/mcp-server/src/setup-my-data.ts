/**
 * The "Mine data" page of the setup UI: what aula-mcp keeps about the
 * signed-in parent, what it can read live from Aula, and every MCP tool.
 * Read-only. The page fetches data/summary, data/live and data/tools and
 * builds the DOM with textContent, so nothing from Aula is ever parsed as HTML.
 */

import { escapeHtml, ICON_SVG } from './setup-ui.ts';

export function renderMyDataPage(signedInAs?: string): string {
  const account = signedInAs
    ? `<p class="muted">Logget ind som <strong>${escapeHtml(signedInAs)}</strong></p>`
    : '';
  return `<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>aula-mcp — mine data</title>
<style>
  :root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6b7280; --bg: #ffffff; --card: #f7f7f8; --border: #e5e7eb; --accent: #03a9f4; --error: #b00020; --success: #117a3a; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --muted: #a1a1aa; --bg: #111114; --card: #1c1c1f; --border: #2a2a2e; } }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--fg); background: var(--bg); margin: 0; padding: 2rem 1rem; }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 0.5rem; display: flex; align-items: center; gap: 0.5rem; }
  h1 svg { color: var(--accent); }
  h2 { font-size: 1.05rem; margin: 0 0 0.5rem; }
  h3 { font-size: 0.95rem; margin: 0 0 0.25rem; }
  p { margin: 0 0 0.75rem; }
  a { color: var(--accent); }
  .muted { color: var(--muted); font-size: 0.85rem; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1.25rem; margin: 1rem 0; overflow-wrap: anywhere; }
  .tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--border); margin-top: 1rem; flex-wrap: wrap; }
  .tabs button { font: inherit; background: none; border: 0; border-bottom: 2px solid transparent; padding: 0.5rem 0.75rem; color: var(--muted); cursor: pointer; }
  .tabs button[aria-selected=true] { color: var(--fg); border-bottom-color: var(--accent); font-weight: 500; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; margin: 0; }
  dt { color: var(--muted); }
  dd { margin: 0; }
  ul { margin: 0.25rem 0 0; padding-left: 1.25rem; }
  .item { border-top: 1px solid var(--border); padding: 0.75rem 0; }
  .item:first-child { border-top: 0; padding-top: 0; }
  .badge { display: inline-block; font-size: 0.75rem; padding: 0 0.45rem; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); margin-left: 0.35rem; vertical-align: 1px; }
  .badge.on { color: var(--success); border-color: var(--success); }
  .badge.off { color: var(--error); border-color: var(--error); }
  code { background: var(--bg); border: 1px solid var(--border); padding: 0.05rem 0.3rem; border-radius: 4px; font-size: 0.9em; }
  .desc { white-space: pre-wrap; color: var(--muted); font-size: 0.85rem; margin: 0.35rem 0; }
  .error { color: var(--error); }
  input[type=search] { width: 100%; padding: 0.5rem 0.75rem; font: inherit; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--fg); }
</style>
</head>
<body>
<main>
  <h1>${ICON_SVG} Mine data</h1>
  ${account}
  <p><a href="./">← Tilbage til login</a></p>
  <p class="muted">Kun visning. Her kan du se, hvad aula-mcp gemmer om dig, hvad den kan læse fra Aula, og hvilke værktøjer AI-assistenten har.</p>

  <div class="tabs" role="tablist">
    <button role="tab" aria-selected="true" data-tab="stored">Gemt om dig</button>
    <button role="tab" aria-selected="false" data-tab="live">Live fra Aula</button>
    <button role="tab" aria-selected="false" data-tab="tools">Værktøjer</button>
  </div>

  <section id="tab-stored"><div class="card">Indlæser…</div></section>
  <section id="tab-live" hidden><div class="card">Indlæser…</div></section>
  <section id="tab-tools" hidden><div class="card">Indlæser…</div></section>
</main>
<script>
(() => {
  const el = (tag, props, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') node.className = v; else node.setAttribute(k, v);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child);
    }
    return node;
  };
  const card = (...children) => el('div', { class: 'card' }, ...children);
  const fill = (id, ...nodes) => { const s = document.getElementById(id); s.replaceChildren(...nodes); };
  const when = (epoch) => epoch ? new Date(epoch * 1000).toLocaleString('da-DK') : '–';
  const getJson = async (path) => {
    const res = await fetch(path, { headers: { accept: 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    return body;
  };

  const KIND_LABELS = {
    message_thread: 'Beskedtråde', message: 'Beskeder', post: 'Opslag', notification: 'Notifikationer',
    calendar_event: 'Kalender', presence: 'Komme/gå', weekly_plan: 'Ugeplaner', task: 'Opgaver og lektier',
    contact: 'Kontakter', group: 'Grupper', gallery_album: 'Fotoalbum', gallery_media: 'Billeder og video',
  };
  const loaded = {};
  const loaders = {
    async stored() {
      const data = await getJson('data/summary');
      const login = data.login;
      const rows = login.logged_in
        ? [
            ['Aula-login', 'Ja'],
            ['MitID-bruger', login.username || '–'],
            ['Identitet', login.identity_name || '–'],
            ['Logget ind', when(login.saved_at)],
            ['Adgang udløber', when(login.expires_at)],
            ['Automatisk fornyelse', login.auto_renew ? 'Slået til' : 'Slået fra'],
            ...(login.auto_renew && login.renews_at ? [['Næste fornyelse', when(login.renews_at)]] : []),
          ]
        : [['Aula-login', 'Nej, du er ikke logget ind']];
      fill('tab-stored',
        card(el('h2', {}, 'Dit login'), el('dl', {}, rows.map(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]))),
        data.database ? card(el('h2', {}, 'Lokal database'),
          el('p', { class: 'muted' }, (data.database.type === 'postgres' ? 'PostgreSQL' : 'SQLite') + ' · krypteret'),
          data.database.kinds.length
            ? el('dl', {}, data.database.kinds.map((k) => [
                el('dt', {}, KIND_LABELS[k.kind] || k.kind),
                el('dd', {}, k.count + (k.newest ? ' · nyeste ' + when(k.newest) : '')),
              ]))
            : el('p', {}, 'Ingen data gemt endnu.')) : null,
        card(el('h2', {}, 'Det gemmer aula-mcp om dig'),
          data.stored.map((item) => el('div', { class: 'item' },
            el('h3', {}, item.what), el('p', { class: 'muted' }, 'Hvor: ', item.where), el('p', {}, item.detail)))),
        card(el('h2', {}, 'Det gemmes ikke'), el('ul', {}, data.not_stored.map((t) => el('li', {}, t)))),
      );
    },
    async live() {
      const data = await getJson('data/live');
      fill('tab-live',
        card(el('p', { class: 'muted' }, 'Hentet fra Aula lige nu med dit eget login. Intet herfra gemmes.'),
          el('h2', {}, data.user.name || 'Ukendt bruger'),
          data.user.identityName ? el('p', { class: 'muted' }, 'Identitet: ', data.user.identityName) : null),
        card(el('h2', {}, 'Børn (' + data.children.length + ')'),
          el('ul', {}, data.children.map((c) => el('li', {}, c.name, c.institution ? ' · ' + c.institution : '')))),
        card(el('h2', {}, 'Det kan assistenten læse'),
          data.capabilities.map((c) => el('div', { class: 'item' },
            el('h3', {}, c.area), el('p', { class: 'muted' }, c.summary),
            el('p', {}, c.tools.map((t) => [el('code', {}, t), ' '])))),
          data.detected_widgets.length
            ? el('p', { class: 'muted' }, 'Skole-widgets fundet: ', data.detected_widgets.join(', '))
            : null),
      );
    },
    async tools() {
      const data = await getJson('data/tools');
      const list = el('div', {});
      const render = (q) => {
        const query = q.trim().toLowerCase();
        list.replaceChildren(...data.tools
          .filter((t) => !query || (t.name + ' ' + (t.title || '') + ' ' + t.description).toLowerCase().includes(query))
          .map((t) => card(
            el('h3', {}, el('code', {}, t.name),
              el('span', { class: 'badge' }, t.access === 'read' ? 'læse' : t.access === 'write' ? 'skrive' : 'rå'),
              el('span', { class: 'badge ' + (t.enabled ? 'on' : 'off') }, t.enabled ? 'aktiv' : 'slået fra')),
            t.title ? el('p', {}, t.title) : null,
            t.enabled ? null : el('p', { class: 'muted' }, 'Slås til med ', el('code', {}, t.enableWith)),
            el('div', { class: 'desc' }, t.description),
            t.parameters.length
              ? el('ul', {}, t.parameters.map((p) => el('li', {},
                  el('code', {}, p.name), ' (' + p.type + (p.required ? ', påkrævet' : '') + ')',
                  p.description ? ': ' + p.description : '')))
              : el('p', { class: 'muted' }, 'Ingen parametre.'),
          )));
      };
      const search = el('input', { type: 'search', placeholder: 'Søg i ' + data.tools.length + ' værktøjer…' });
      search.addEventListener('input', () => render(search.value));
      render('');
      fill('tab-tools', search, list);
    },
  };

  const show = async (name) => {
    for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
    for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== 'tab-' + name;
    if (loaded[name]) return;
    loaded[name] = true;
    try { await loaders[name](); }
    catch (err) { loaded[name] = false; fill('tab-' + name, card(el('p', { class: 'error' }, 'Kunne ikke hente: ' + err.message))); }
  };
  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => show(b.dataset.tab));
  show('stored');
})();
</script>
</body>
</html>`;
}
