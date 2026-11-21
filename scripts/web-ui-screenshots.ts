// Screenshots of the dashboard for docs/web-ui.md, taken from the sample-data
// demo (scripts/web-ui-demo.ts) with headless Chrome. Needs Google Chrome;
// set CHROME to its binary if it is not in the usual place.
//
//   bun scripts/web-ui-screenshots.ts
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemo } from './web-ui-demo.ts';

const OUT = join(import.meta.dir, '..', 'docs', 'web-ui');
const CHROME =
  process.env.CHROME ??
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome');
const DEBUG_PORT = 9333;

const demo = await startDemo(8766);
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--lang=da',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${await mkdtemp(join(tmpdir(), 'aula-web-ui-chrome-'))}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let page: { type: string; webSocketDebuggerUrl: string } | undefined;
for (let i = 0; i < 50 && !page; i++) {
  await Bun.sleep(200);
  try {
    const targets = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()) as Array<{
      type: string;
      webSocketDebuggerUrl: string;
    }>;
    page = targets.find((t) => t.type === 'page');
  } catch {}
}
if (!page) throw new Error('Chrome did not start');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener('open', resolve));

let seq = 0;
const pending = new Map<number, (value: { result?: Record<string, unknown> }) => void>();
const errors: string[] = [];
ws.addEventListener('message', (event) => {
  const m = JSON.parse(String(event.data));
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  }
  if (m.method === 'Runtime.exceptionThrown')
    errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300));
});
const send = (method: string, params: object = {}) =>
  new Promise<{ result?: Record<string, unknown> }>((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const run = async (expression: string) => {
  const res = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return (res.result?.result as { value?: unknown } | undefined)?.value;
};
await send('Runtime.enable');
await send('Page.enable');

/** A click on the first button whose text is `text`. */
const click = (text: string) =>
  `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click()`;

type Shot = {
  hash: string;
  width: number;
  theme: 'light' | 'dark';
  steps?: string[];
  full?: boolean;
};

async function shot(name: string, s: Shot) {
  const phone = s.width < 600;
  await send('Emulation.setDeviceMetricsOverride', {
    width: s.width,
    height: phone ? 844 : 900,
    deviceScaleFactor: phone ? 2 : 1,
    mobile: phone,
  });
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: s.theme }],
  });
  await send('Page.navigate', { url: 'about:blank' });
  await Bun.sleep(200);
  await send('Page.navigate', { url: `${demo.url}#${s.hash}` });
  await Bun.sleep(1500);
  for (const step of s.steps ?? []) {
    await run(step);
    await Bun.sleep(800);
  }
  const overflow = (await run(
    'document.documentElement.scrollWidth - document.documentElement.clientWidth',
  )) as number;
  if (overflow > 0) console.warn(`${name}: ${overflow}px horizontal overflow`);
  const height = s.full
    ? Math.min((await run('document.documentElement.scrollHeight')) as number, 3200)
    : 0;
  const res = await send('Page.captureScreenshot', {
    format: 'png',
    ...(s.full
      ? { clip: { x: 0, y: 0, width: s.width, height, scale: 1 }, captureBeyondViewport: true }
      : {}),
  });
  await writeFile(join(OUT, `${name}.png`), Buffer.from(String(res.result?.data), 'base64'));
  console.log(`docs/web-ui/${name}.png`);
}

await mkdir(OUT, { recursive: true });
// The calendar remembers its view in localStorage; start each shot on the month.
const month = "localStorage.removeItem('aulamcp-cal-view')";
const openAlbum = "document.querySelector('.album').click()";

await shot('oversigt', { hash: 'oversigt', width: 1440, theme: 'dark', full: true });
await shot('oversigt-phone', { hash: 'oversigt', width: 390, theme: 'dark' });
await shot('genveje-phone', {
  hash: 'oversigt',
  width: 390,
  theme: 'dark',
  steps: [click('Genveje')],
});
await shot('kalender-maaned', { hash: 'kalender', width: 1440, theme: 'dark', steps: [month] });
await shot('kalender-uge', {
  hash: 'kalender',
  width: 1440,
  theme: 'dark',
  steps: [click('Uge'), 'document.querySelector(\'[aria-label="Næste"]\').click()'],
});
await shot('kalender-ferie', {
  hash: 'kalender',
  width: 1440,
  theme: 'dark',
  steps: [
    click('Uge'),
    'document.querySelector(\'[aria-label="Næste"]\').click()',
    "[...document.querySelectorAll('.wk-chip')].find((b) => b.textContent === 'Ferie/fri').click()",
  ],
});
await shot('kalender-phone', { hash: 'kalender', width: 390, theme: 'dark', steps: [month] });
await shot('gennemse', { hash: 'gennemse', width: 1440, theme: 'dark' });
await shot('sync', { hash: 'sync', width: 1440, theme: 'dark' });
await shot('log', { hash: 'log', width: 1440, theme: 'dark' });
await shot('galleri', { hash: 'galleri', width: 1440, theme: 'dark' });
await shot('galleri-album-phone', {
  hash: 'galleri',
  width: 390,
  theme: 'dark',
  steps: [openAlbum],
});
await shot('galleri-billede', {
  hash: 'galleri',
  width: 1440,
  theme: 'dark',
  steps: [openAlbum, "document.querySelector('.thumb').click()"],
});
await shot('vaerktoejer', { hash: 'vaerktoejer', width: 1440, theme: 'dark' });
await shot('live', { hash: 'live', width: 1440, theme: 'dark' });
await shot('gemt', { hash: 'gemt', width: 1440, theme: 'dark' });

if (errors.length) console.warn(`page errors:\n${errors.join('\n')}`);
ws.close();
chrome.kill();
demo.stop();
process.exit(0);
