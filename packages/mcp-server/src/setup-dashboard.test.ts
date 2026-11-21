/**
 * The dashboard's own JSON routes in single-parent mode: paging and search
 * over the stored items, an item with its thread, deleting and starting a
 * sync. Parent isolation in multi-parent mode is in setup-login.test.ts.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger, StoredTokenRecord, TokenStore } from '@aula-mcp/aula-auth';
import { GalleryFiles, GalleryView } from './gallery.ts';
import { renderDashboard } from './setup-dashboard.ts';
import { createSetupApp } from './setup-ui.ts';
import { createStorage, type ParentStorage, type Storage } from './storage.ts';
import { sqliteDriver } from './storage-sql.ts';
import type { ParentSync, SyncJobName, SyncJobStatus } from './sync.ts';

class MemoryStore implements TokenStore {
  record: StoredTokenRecord | null = null;
  async load() {
    return this.record;
  }
  async save(record: StoredTokenRecord) {
    this.record = record;
  }
  async clear() {
    this.record = null;
  }
}

const now = () => Math.floor(Date.now() / 1000);
const LOGIN: StoredTokenRecord = {
  version: 1,
  username: 'demo',
  tokens: {
    access_token: 'AT',
    refresh_token: 'RT',
    token_type: 'Bearer',
    expires_in: 3600,
    expires_at: now() + 3600,
    obtained_at: now(),
  },
  saved_at: now(),
};

/** A sync that records what it was asked to run and finishes when told. */
function fakeSync() {
  const runs: SyncJobName[][] = [];
  let finish = () => {};
  const sync: ParentSync = {
    async status() {
      return [
        {
          job: 'messages',
          description: 'Beskeder',
          intervalMinutes: 15,
          running: false,
          lastRunAt: null,
          lastSuccessAt: null,
          nextRunAt: null,
          ok: null,
          lastError: null,
          failuresInARow: 0,
          fetched: 0,
          changed: 0,
        } satisfies SyncJobStatus,
      ];
    },
    run(jobs) {
      runs.push(jobs ?? []);
      return new Promise((resolve) => {
        finish = () => resolve([]);
      });
    },
  };
  return { sync, runs, finish: () => finish() };
}

let storage: Storage | undefined;
let galleryDir: string | undefined;
afterEach(async () => {
  await storage?.close();
  storage = undefined;
  if (galleryDir) await rm(galleryDir, { recursive: true, force: true });
  galleryDir = undefined;
});

const PHOTO = 'Anna/2026/2026-11-18 Skovtur/IMG_1.jpg';
const THUMB = '.thumbs/11-1.jpg';

/** One album with a downloaded photo and a video that failed to download. */
async function seedGallery(store: ParentStorage, root: string) {
  await store.put([
    {
      kind: 'gallery_album',
      id: '11',
      occurredAt: 1763453520,
      data: {
        album: {
          id: 11,
          title: 'Skovtur',
          creationDate: '2026-11-18T09:12:00+01:00',
          creator: { name: 'Lærer Lis' },
          sharedWithGroups: [{ id: 3, name: '2.A' }],
        },
        child: 'Anna',
        folder: 'Anna/2026/2026-11-18 Skovtur',
        mediaCount: 2,
      },
    },
    {
      kind: 'gallery_media',
      id: '11:1',
      occurredAt: 1763453520,
      data: {
        albumId: 11,
        media: { id: 1, mediaType: 'image', file: { id: 1, name: 'IMG_1.jpg' } },
        path: PHOTO,
        thumb: THUMB,
        sha256: 'ab',
        bytes: 5,
        downloadedAt: 1763453600,
      },
    },
    {
      kind: 'gallery_media',
      id: '11:2',
      occurredAt: 1763453530,
      data: {
        albumId: 11,
        media: { id: 2, mediaType: 'video', file: { id: 2, name: 'MOV_2.mp4' } },
        path: null,
        thumb: null,
        sha256: null,
        bytes: 0,
        downloadedAt: null,
        error: 'HTTP 403',
      },
    },
  ]);
  await mkdir(join(root, 'Anna/2026/2026-11-18 Skovtur'), { recursive: true });
  await mkdir(join(root, '.thumbs'), { recursive: true });
  await writeFile(join(root, PHOTO), 'photo');
  await writeFile(join(root, THUMB), 'th');
}

async function setup(options: { login?: boolean; logger?: Logger; gallery?: boolean } = {}) {
  storage = await createStorage(sqliteDriver(':memory:'), Buffer.alloc(32, 3), {
    type: 'sqlite',
    location: ':memory:',
  });
  const mine = storage.forParent('default');
  await mine.put([
    {
      kind: 'message_thread',
      id: '7',
      occurredAt: 300,
      data: {
        subject: 'Skovtur fredag',
        read: false,
        lastMessage: { sender: { fullName: 'Lærer Lis' } },
      },
    },
    {
      kind: 'message',
      id: '7:1',
      occurredAt: 100,
      data: { sender: { fullName: 'Lærer Lis' }, text: { plain: 'Husk madpakke' } },
    },
    {
      kind: 'message',
      id: '7:2',
      occurredAt: 200,
      data: { sender: { fullName: 'Far' }, text: { plain: 'Tak, vi husker gummistøvler' } },
    },
    { kind: 'message', id: '70:1', occurredAt: 150, data: { text: { plain: 'en anden tråd' } } },
    ...Array.from({ length: 5 }, (_, i) => ({
      kind: 'post' as const,
      id: `p${i}`,
      occurredAt: 400 + i,
      data: { title: `Opslag nummer ${i}` },
    })),
  ]);
  galleryDir = await mkdtemp(join(tmpdir(), 'aula-gallery-'));
  const files = new GalleryFiles({ dir: galleryDir, downloads: true, stopAt: 1 });
  const parentFiles = files.forParent('default');
  if (options.gallery !== false) await seedGallery(mine, parentFiles.root);
  const store = new MemoryStore();
  if (options.login !== false) await store.save(LOGIN);
  const sync = fakeSync();
  const app = createSetupApp({
    store,
    ...(options.logger ? { logger: options.logger } : {}),
    myData: {
      contextFor: () => {
        throw new Error('unused');
      },
      storage: { info: storage.info, forParent: () => mine },
      sync: { forParent: () => sync.sync },
      ...(options.gallery !== false
        ? { gallery: { forParent: () => new GalleryView(mine, parentFiles) } }
        : {}),
    },
  });
  return { app, mine, sync, galleryRoot: parentFiles.root };
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

type Page = { items: Array<{ kind: string; id: string; title: string }>; more: boolean };

describe('dashboard page', () => {
  test('has no external resources and escapes the signed-in name', () => {
    const html = renderDashboard('Anna <b>Hansen</b>');
    expect(html).not.toContain('<b>Hansen');
    expect(html).toContain('Anna &lt;b&gt;Hansen');
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
    for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      expect(() => new Function(script ?? '')).not.toThrow();
    }
  });

  test('has the Galleri page instead of a placeholder', () => {
    const html = renderDashboard();
    expect(html).not.toContain('Kommer snart');
    for (const route of [
      "'data/gallery'",
      "'data/gallery/albums/'",
      "'data/gallery/delete'",
      "'data/gallery/' + variant",
      "'?download=1'",
      "runJobs(['gallery'])",
    ]) {
      expect(html).toContain(route);
    }
    expect(html).toContain('id="lightbox"');
    expect(html).toContain('Intet slettes i Aula.');
  });
});

describe('dashboard data routes', () => {
  test('lists items newest first, a page at a time', async () => {
    const { app } = await setup();
    const first = (await (await app.request('/data/items?kind=post&limit=2')).json()) as Page;
    expect(first.items.map((item) => item.id)).toEqual(['p4', 'p3']);
    expect(first.more).toBe(true);
    const last = (await (
      await app.request('/data/items?kind=post&limit=2&offset=4')
    ).json()) as Page;
    expect(last.items.map((item) => item.id)).toEqual(['p0']);
    expect(last.more).toBe(false);
  });

  test('searches the text the parent sees', async () => {
    const { app } = await setup();
    const hits = (await (await app.request('/data/items?q=GUMMISTØVLER')).json()) as Page;
    expect(hits.items.map((item) => `${item.kind}:${item.id}`)).toEqual(['message:7:2']);
    const none = (await (await app.request('/data/items?q=ingen%20s%C3%A5dan')).json()) as Page;
    expect(none.items).toEqual([]);
  });

  test('refuses an unknown kind and odd numbers', async () => {
    const { app } = await setup();
    expect((await app.request('/data/items?kind=secrets')).status).toBe(400);
    expect((await app.request('/data/items?limit=ten')).status).toBe(400);
    expect((await app.request('/data/items/secrets/1')).status).toBe(400);
  });

  test('shows a thread with its own messages, oldest first', async () => {
    const { app } = await setup();
    const res = await app.request('/data/items/message_thread/7');
    const body = (await res.json()) as {
      item: { title: string; unread?: boolean };
      messages: Array<{ id: string; from: string; body: string }>;
    };
    expect(body.item).toMatchObject({ title: 'Skovtur fredag', unread: true });
    // 70:1 shares the leading digits but belongs to another thread.
    expect(body.messages.map((m) => m.id)).toEqual(['7:1', '7:2']);
    expect(body.messages[0]).toMatchObject({ from: 'Lærer Lis', body: 'Husk madpakke' });
    expect((await app.request('/data/items/message_thread/8')).status).toBe(404);
  });

  test('deletes one kind or everything, only with a JSON SLET', async () => {
    const { app, mine, galleryRoot } = await setup();
    const form = await app.request('/data/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'confirm=SLET&all=true',
    });
    expect(form.status).toBe(415);
    expect((await app.request('/data/delete', json({ all: true }))).status).toBe(400);
    expect((await app.request('/data/delete', json({ confirm: 'SLET', kind: 'x' }))).status).toBe(
      400,
    );

    const posts = await app.request('/data/delete', json({ confirm: 'SLET', kind: 'post' }));
    expect(await posts.json()).toEqual({ deleted: 5 });
    expect((await mine.stats()).map((s) => s.kind).sort()).toEqual([
      'gallery_album',
      'gallery_media',
      'message',
      'message_thread',
    ]);

    // Everything includes the gallery's rows and its files on disk.
    const all = await app.request('/data/delete', json({ confirm: 'SLET', all: true }));
    expect(await all.json()).toEqual({ deleted: 7 });
    expect(await mine.stats()).toEqual([]);
    expect(await readdir(galleryRoot)).toEqual([]);
  });

  test('starts a sync in the background and shows it queued', async () => {
    const { app, sync } = await setup();
    expect((await app.request('/data/sync/run', json({ jobs: ['nope'] }))).status).toBe(400);
    expect((await app.request('/data/sync/run', { method: 'POST', body: '{}' })).status).toBe(415);

    const res = await app.request('/data/sync/run', json({ jobs: ['messages'] }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ started: ['messages'] });
    expect(sync.runs).toEqual([['messages']]);

    const status = (await (await app.request('/data/sync')).json()) as {
      available: boolean;
      logged_in: boolean;
      jobs: Array<{ job: string; queued: boolean }>;
    };
    expect(status).toMatchObject({ available: true, logged_in: true });
    expect(status.jobs[0]).toMatchObject({ job: 'messages', queued: true });

    sync.finish();
    await Bun.sleep(0);
    const after = (await (await app.request('/data/sync')).json()) as {
      jobs: Array<{ queued: boolean }>;
    };
    expect(after.jobs[0]?.queued).toBe(false);
  });

  test('does not start a sync without an Aula login', async () => {
    const { app, sync } = await setup({ login: false });
    expect((await app.request('/data/sync/run', json({}))).status).toBe(409);
    expect(sync.runs).toEqual([]);
  });

  test('refuses a cross-site POST from the browser', async () => {
    const { app, mine } = await setup();
    const res = await app.request(
      '/data/delete',
      json({ confirm: 'SLET', all: true }, { 'sec-fetch-site': 'cross-site' }),
    );
    expect(res.status).toBe(403);
    expect((await mine.stats()).length).toBeGreaterThan(0);
    const run = await app.request('/data/sync/run', json({}, { 'sec-fetch-site': 'same-site' }));
    expect(run.status).toBe(403);
  });

  test('never logs the Aula content it serves', async () => {
    const lines: string[] = [];
    const record = (message: string, meta?: Record<string, unknown>) => {
      lines.push(`${message} ${JSON.stringify(meta ?? {})}`);
    };
    const logger: Logger = { debug: record, info: record, warn: record, error: record };
    const { app } = await setup({ logger });
    await app.request('/data/items?q=madpakke');
    await app.request('/data/items/message_thread/7');
    await app.request('/data/items');
    const logged = lines.join('\n');
    expect(logged).not.toContain('madpakke');
    expect(logged).not.toContain('Skovtur');
    expect(logged).not.toContain('Lærer Lis');
  });
});

type GalleryBody = {
  status: { albums: number; media: number; downloaded: number; waiting: number; failed: number };
  albums: Array<{
    id: number;
    title: string;
    child: string;
    downloaded: number;
    coverMediaId: number | null;
  }>;
};

describe('dashboard gallery routes', () => {
  test('shows the status and albums, filtered by child', async () => {
    const { app } = await setup();
    const res = await app.request('/data/gallery');
    expect(res.status).toBe(200);
    const body = (await res.json()) as GalleryBody;
    expect(body.status).toMatchObject({
      albums: 1,
      media: 2,
      downloaded: 1,
      waiting: 1,
      failed: 1,
    });
    expect(body.albums).toEqual([
      expect.objectContaining({
        id: 11,
        title: 'Skovtur',
        child: 'Anna',
        downloaded: 1,
        coverMediaId: 1,
      }),
    ]);
    const none = (await (await app.request('/data/gallery?child=Bo')).json()) as GalleryBody;
    expect(none.albums).toEqual([]);
  });

  test('shows an album with its media', async () => {
    const { app } = await setup();
    const res = await app.request('/data/gallery/albums/11');
    const body = (await res.json()) as {
      album: { title: string; creator: string; groups: string[] };
      media: Array<{ id: number; type: string; downloaded: boolean; error: string | null }>;
    };
    expect(body.album).toMatchObject({ title: 'Skovtur', creator: 'Lærer Lis', groups: ['2.A'] });
    expect(body.media.map((m) => [m.id, m.type, m.downloaded, m.error])).toEqual([
      [1, 'image', true, null],
      [2, 'video', false, 'HTTP 403'],
    ]);
    expect((await app.request('/data/gallery/albums/12')).status).toBe(404);
    expect((await app.request('/data/gallery/albums/elleve')).status).toBe(400);
  });

  test('serves a stored file and its thumbnail, inline or as a download', async () => {
    const { app } = await setup();
    const file = await app.request('/data/gallery/file/11/1');
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/jpeg');
    expect(file.headers.get('content-disposition')).toStartWith('inline;');
    expect(await file.text()).toBe('photo');
    const download = await app.request('/data/gallery/file/11/1?download=1');
    expect(download.headers.get('content-disposition')).toBe(
      "attachment; filename*=UTF-8''IMG_1.jpg",
    );
    expect(await (await app.request('/data/gallery/thumb/11/1')).text()).toBe('th');
    // Not downloaded, or not there at all.
    expect((await app.request('/data/gallery/file/11/2')).status).toBe(404);
    expect((await app.request('/data/gallery/file/11/9')).status).toBe(404);
    expect((await app.request('/data/gallery/file/x/1')).status).toBe(400);
  });

  test('deletes an album only with a JSON SLET, and keeps it from coming back', async () => {
    const { app, galleryRoot } = await setup();
    const form = await app.request('/data/gallery/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'confirm=SLET&albumId=11',
    });
    expect(form.status).toBe(415);
    expect((await app.request('/data/gallery/delete', json({ albumId: 11 }))).status).toBe(400);
    expect(
      (await app.request('/data/gallery/delete', json({ confirm: 'slet', all: true }))).status,
    ).toBe(400);
    expect((await app.request('/data/gallery/delete', json({ confirm: 'SLET' }))).status).toBe(400);
    expect(
      (
        await app.request(
          '/data/gallery/delete',
          json({ confirm: 'SLET', all: true }, { 'sec-fetch-site': 'cross-site' }),
        )
      ).status,
    ).toBe(403);
    expect((await app.request('/data/gallery/file/11/1')).status).toBe(200);

    const res = await app.request('/data/gallery/delete', json({ confirm: 'SLET', albumId: 11 }));
    expect(await res.json()).toEqual({ deleted: { albums: 1, files: 1 } });
    expect((await app.request('/data/gallery/file/11/1')).status).toBe(404);
    expect(await readdir(galleryRoot)).toEqual([]);
    const after = (await (await app.request('/data/gallery')).json()) as GalleryBody;
    expect(after.albums).toEqual([]);
    // Still shown on its own page, marked as deleted here.
    const album = (await (await app.request('/data/gallery/albums/11')).json()) as {
      album: { removed: boolean };
      media: unknown[];
    };
    expect(album).toEqual({ album: expect.objectContaining({ removed: true }), media: [] });
  });

  test('the generic delete leaves gallery rows to the gallery route', async () => {
    const { app } = await setup();
    const res = await app.request('/data/delete', json({ confirm: 'SLET', kind: 'gallery_album' }));
    expect(res.status).toBe(400);
    expect((await app.request('/data/gallery/file/11/1')).status).toBe(200);
  });

  test('is a 404 when the gallery is off', async () => {
    const { app } = await setup({ gallery: false });
    expect((await app.request('/data/gallery')).status).toBe(404);
    expect((await app.request('/data/gallery/albums/11')).status).toBe(404);
    expect((await app.request('/data/gallery/file/11/1')).status).toBe(404);
    expect(
      (await app.request('/data/gallery/delete', json({ confirm: 'SLET', all: true }))).status,
    ).toBe(404);
  });
});
