import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GalleryAlbum, GalleryMedia } from '@aula-mcp/aula-client';
import {
  childOf,
  GalleryFiles,
  GalleryView,
  galleryConfig,
  SHARED_FOLDER,
  safeName,
  syncGallery,
  withoutUrls,
} from './gallery.ts';
import { createStorage, type Storage } from './storage.ts';
import { sqliteDriver } from './storage-sql.ts';
import type { SyncClient } from './sync.ts';

const KEY = Buffer.alloc(32, 7);
const URL_BASE = 'https://media-prod.aula.dk/file';

let storage: Storage;
let dir: string;
let fetched: string[];
let files: GalleryFiles;

/** Serves `<URL_BASE>/<name>?sig` with the bytes of `<name>`. */
const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  fetched.push(url);
  const name = new URL(url).pathname.split('/').pop() ?? '';
  if (name.startsWith('missing')) return new Response(null, { status: 403 });
  return new Response(`bytes of ${name.replace(/^dup\d/, 'dup')}`);
}) as typeof fetch;

beforeEach(async () => {
  storage = await createStorage(sqliteDriver(':memory:'), KEY, { type: 'sqlite', location: 't' });
  dir = await mkdtemp(join(tmpdir(), 'aula-gallery-'));
  fetched = [];
  files = new GalleryFiles({ dir, downloads: true, stopAt: 1 }, { fetch: fakeFetch });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const media = (id: number, extra: Partial<GalleryMedia> = {}, noThumb = false): GalleryMedia => ({
  id,
  mediaType: 'image',
  conversionStatus: 'completed',
  file: {
    id,
    name: `IMG_${id}.JPEG`,
    url: `${URL_BASE}/m${id}?Signature=s`,
    created: '2026-11-18T10:00:00+01:00',
  },
  ...(noThumb ? {} : { thumbnailUrl: `${URL_BASE}/t${id}?Signature=s` }),
  ...extra,
});

const ALBUM: GalleryAlbum = {
  id: 100,
  title: 'Tur til skoven / efterår',
  creationDate: '2026-11-18T09:12:00+01:00',
  sharedWithGroups: [{ id: 900, name: '2.A' }],
  thumbnailsUrls: [`${URL_BASE}/cover?Signature=s`],
};

function client(albums: Array<{ album: GalleryAlbum; media: GalleryMedia[] }>): SyncClient {
  return {
    rawRequest: async () => [
      { institutionProfile: { id: 5, role: 'guardian' } },
      { institutionProfile: { id: 11, role: 'child' } },
    ],
    getProfilesByLogin: async () => ({
      profiles: [
        {
          children: [
            { id: 11, name: 'Alma' },
            { id: 12, name: 'Bo' },
          ],
        },
      ],
    }),
    getGroups: async (ids: number[]) => (ids[0] === 11 ? [{ id: 900 }] : [{ id: 901 }]),
    getAlbums: async ({ index = 0 }: { index?: number }) =>
      index === 0 ? albums.map((a) => a.album) : [],
    getAlbumMedia: async ({
      albumId,
      index = 0,
      limit = 50,
    }: {
      albumId: number;
      index?: number;
      limit?: number;
    }) => {
      const all = albums.find((a) => a.album.id === albumId)?.media ?? [];
      return {
        totalSize: all.length,
        startIndex: index,
        limit,
        results: all.slice(index, index + limit),
      };
    },
  } as unknown as SyncClient;
}

const run = (c: SyncClient) =>
  syncGallery({
    client: c,
    store: storage.forParent('p'),
    childIds: async () => [11, 12],
    firstRun: true,
    now: new Date('2026-11-20T10:00:00Z'),
    gallery: files.forParent('p'),
  });

describe('gallery job', () => {
  test('downloads originals and thumbnails into child/year/album folders', async () => {
    const result = await run(client([{ album: ALBUM, media: [media(1), media(2)] }]));
    expect(result).toMatchObject({ fetched: 2 });
    const folder = join(dir, 'p', 'Alma', '2026', '2026-11-18 Tur til skoven efterår');
    expect(await readFile(join(folder, '1.jpeg'), 'utf8')).toBe('bytes of m1');
    expect(await readFile(join(dir, 'p', '.thumbs', '2.jpg'), 'utf8')).toBe('bytes of t2');
    expect((await stat(join(folder, '1.jpeg'))).mode & 0o777).toBe(0o600);

    // A second run downloads nothing.
    fetched = [];
    const again = await run(client([{ album: ALBUM, media: [media(1), media(2)] }]));
    expect(fetched).toEqual([]);
    expect(again.changed).toBe(0);
  });

  test('never stores a signed URL', async () => {
    await run(client([{ album: ALBUM, media: [media(1)] }]));
    const rows = [
      ...(await storage.forParent('p').list({ kind: 'gallery_album' })),
      ...(await storage.forParent('p').list({ kind: 'gallery_media' })),
    ];
    expect(rows.length).toBe(2);
    expect(JSON.stringify(rows)).not.toContain('Signature');
    expect(JSON.stringify(rows)).not.toContain('media-prod');
  });

  test('stores the same file once', async () => {
    const other: GalleryAlbum = { ...ALBUM, id: 101, title: 'Kopi' };
    const dup = (id: number, n: number) =>
      media(
        id,
        {
          file: { id, name: 'a.jpg', url: `${URL_BASE}/dup${n}?s` },
        },
        true,
      );
    await run(
      client([
        { album: ALBUM, media: [dup(1, 1)] },
        { album: other, media: [dup(2, 2)] },
      ]),
    );
    const status = await new GalleryView(storage.forParent('p'), files.forParent('p')).status();
    expect(status.downloaded).toBe(2);
    expect(status.bytes).toBe('bytes of dup'.length);
  });

  test('a failed download is kept as an error without the URL and tried again', async () => {
    const bad = media(3, {
      file: { id: 3, name: 'x.jpg', url: `${URL_BASE}/missing3?Signature=secret` },
    });
    await run(client([{ album: ALBUM, media: [bad] }]));
    const [m] = await new GalleryView(storage.forParent('p'), files.forParent('p')).media(100);
    expect(m?.downloaded).toBe(false);
    expect(m?.error).toBe('download failed: HTTP 403');
    fetched = [];
    await run(client([{ album: ALBUM, media: [bad] }]));
    expect(fetched.some((u) => u.includes('missing3'))).toBe(true);
  });

  test('only fetches from Aula hosts', async () => {
    const evil = media(
      4,
      {
        file: { id: 4, name: 'x.jpg', url: 'https://evil.example/x' },
      },
      true,
    );
    await run(client([{ album: ALBUM, media: [evil] }]));
    expect(fetched).toEqual([]);
  });

  test('pauses at the disk limit', async () => {
    files = new GalleryFiles({ dir, downloads: true, stopAt: 0.000001 }, { fetch: fakeFetch });
    const result = await run(client([{ album: ALBUM, media: [media(1), media(2)] }]));
    expect(fetched).toEqual([]);
    expect(result.skipped).toBe(2);
    expect(result.more).toBeUndefined();
  });

  test('a deleted album is not fetched again', async () => {
    const c = client([{ album: ALBUM, media: [media(1)] }]);
    await run(c);
    const view = new GalleryView(storage.forParent('p'), files.forParent('p'));
    expect(await view.remove({ albumId: 100 })).toEqual({ albums: 1, files: 1 });
    expect(await stat(join(dir, 'p', 'Alma')).catch(() => null)).toBeNull();
    fetched = [];
    await run(c);
    expect(fetched).toEqual([]);
    expect(await view.albums()).toEqual([]);
  });

  test('parents never share a folder', async () => {
    await run(client([{ album: ALBUM, media: [media(1)] }]));
    const view = new GalleryView(storage.forParent('q'), files.forParent('q'));
    expect(await view.albums()).toEqual([]);
    expect(await view.file(100, 1, 'original')).toBeNull();
    expect(() => files.forParent('../p')).toThrow();
  });
});

describe('gallery helpers', () => {
  test('withoutUrls drops every url field at any depth', () => {
    expect(
      withoutUrls<unknown>({
        a: 1,
        thumbnailUrl: 'x',
        file: { url: 'y', name: 'n' },
        thumbnailsUrls: ['z'],
      }),
    ).toEqual({
      a: 1,
      file: { name: 'n' },
    });
  });

  test('safeName makes a path segment', () => {
    expect(safeName('../../etc/passwd', 'x')).toBe('etc passwd');
    expect(safeName('  ', 'fallback')).toBe('fallback');
    expect(safeName('a:b*c?', 'x')).toBe('a b c');
  });

  test('childOf: tags first, then groups, else shared', () => {
    const children = [
      { id: 11, name: 'Alma' },
      { id: 12, name: 'Bo' },
    ];
    const groups = new Map([
      [11, new Set([900])],
      [12, new Set([900, 901])],
    ]);
    expect(childOf(ALBUM, [media(1, { tags: [{ id: 12 }] })], children, groups)).toBe('Bo');
    expect(childOf(ALBUM, [media(1)], children, groups)).toBe(SHARED_FOLDER);
    expect(childOf({ ...ALBUM, sharedWithGroups: [{ id: 901 }] }, [], children, groups)).toBe('Bo');
  });

  test('galleryConfig defaults and checks', () => {
    expect(galleryConfig({ AULA_MCP_DIR: '/d' })).toEqual({
      dir: '/d/gallery',
      downloads: true,
      stopAt: 0.9,
    });
    expect(galleryConfig({ AULA_MCP_GALLERY: '0', AULA_MCP_GALLERY_DIR: '/g' }).downloads).toBe(
      false,
    );
    expect(() => galleryConfig({ AULA_MCP_GALLERY_STOP_AT: '2' })).toThrow();
  });
});
