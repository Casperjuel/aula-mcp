/**
 * Attachments of posts and messages: what is read from Aula's data, saving
 * them while the links are fresh, the dashboard routes and the albums made
 * from posts with photos.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StoredTokenRecord, TokenStore } from '@aula-mcp/aula-auth';
import { attachmentFiles, attachmentRel, saveAttachments } from './attachments.ts';
import { GalleryFiles, GalleryView } from './gallery.ts';
import { createSetupApp } from './setup-ui.ts';
import { createStorage, type ItemInput, type Storage } from './storage.ts';
import { sqliteDriver } from './storage-sql.ts';

const URL_BASE = 'https://media-prod.aula.dk/file';

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

let storage: Storage;
let dir: string;
let fetched: string[];
let files: GalleryFiles;

const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  fetched.push(url);
  const name = new URL(url).pathname.split('/').pop() ?? '';
  if (name.startsWith('missing')) return new Response(null, { status: 403 });
  return new Response(`bytes of ${name}`);
}) as typeof fetch;

const post: ItemInput = {
  kind: 'post',
  id: '42',
  occurredAt: '2026-11-20T09:00:00+01:00',
  data: {
    title: 'Skovtur',
    ownerProfile: { fullName: 'Lærer' },
    attachments: [
      { file: { name: 'foto.JPG', url: `${URL_BASE}/a?Signature=s` } },
      { file: { name: 'brev.pdf', url: `${URL_BASE}/b?Signature=s`, size: 12 } },
      { name: 'liste.docx', url: `${URL_BASE}/c?Signature=s` },
      { file: { name: 'gone.png', url: `${URL_BASE}/missing?Signature=s` } },
    ],
  },
};

const message: ItemInput = {
  kind: 'message',
  id: '7:1',
  occurredAt: 1,
  data: {
    threadId: '7',
    text: 'Se billedet',
    attachments: [
      {
        media: {
          file: {
            name: '<script>.html',
            url: `${URL_BASE}/d?Signature=s`,
            mediaType: 'text/html',
          },
        },
      },
    ],
  },
};

beforeEach(async () => {
  storage = await createStorage(sqliteDriver(':memory:'), Buffer.alloc(32, 9), {
    type: 'sqlite',
    location: 't',
  });
  dir = await mkdtemp(join(tmpdir(), 'aula-attach-'));
  fetched = [];
  files = new GalleryFiles({ dir, downloads: true, stopAt: 1 }, { fetch: fakeFetch });
  await storage.forParent('a').put([post, message]);
});
afterEach(async () => {
  await storage.close();
  await rm(dir, { recursive: true, force: true });
});

function app() {
  const own = storage.forParent('a');
  return createSetupApp({
    store: new MemoryStore(),
    myData: {
      contextFor: () => {
        throw new Error('unused');
      },
      storage: { info: storage.info, forParent: () => own },
      gallery: { forParent: () => new GalleryView(own, files.forParent('a')) },
    },
  });
}

describe('attachmentFiles', () => {
  test('reads file, media.file and the attachment itself, with a type', () => {
    const list = attachmentFiles(post.data);
    expect(list.map((f) => [f.name, f.mediaType])).toEqual([
      ['foto.JPG', 'image/jpeg'],
      ['brev.pdf', 'application/pdf'],
      ['liste.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['gone.png', 'image/png'],
    ]);
    expect(list[1]?.size).toBe(12);
    expect(attachmentFiles(message.data)[0]?.mediaType).toBe('text/html');
    expect(attachmentFiles({})).toEqual([]);
  });

  test('the stored path uses the id and index, never the file name', () => {
    const [file] = attachmentFiles(message.data);
    expect(attachmentRel('message', '7:1', file as never)).toBe('attachments/message/7_3A1/0.html');
  });
});

describe('saveAttachments', () => {
  test('saves each file once and counts the ones Aula refused', async () => {
    const gallery = files.forParent('a');
    expect(await saveAttachments(gallery, [post, message])).toEqual({ saved: 4, failed: 1 });
    fetched = [];
    expect(await saveAttachments(gallery, [post, message])).toEqual({ saved: 0, failed: 1 });
    expect(fetched).toHaveLength(1);
  });
});

describe('dashboard routes', () => {
  beforeEach(async () => {
    await saveAttachments(files.forParent('a'), [post, message]);
  });

  test('the item lists its attachments, saved or not, without links', async () => {
    const res = await app().request('/data/items/post/42');
    const text = await res.text();
    expect(text).not.toContain('Signature');
    const { item } = JSON.parse(text);
    expect(item.attachments.map((a: { saved: boolean }) => a.saved)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  test('a picture or PDF is shown inline, anything else is a download', async () => {
    const a = app();
    const photo = await a.request('/data/attachments/post/42/0');
    expect(photo.headers.get('content-type')).toBe('image/jpeg');
    expect(photo.headers.get('content-disposition')).toStartWith('inline');
    expect(photo.headers.get('content-security-policy')).toBe('sandbox');
    expect(await photo.text()).toBe('bytes of a');
    const pdf = await a.request('/data/attachments/post/42/1');
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    const asked = await a.request('/data/attachments/post/42/1?download=1');
    expect(asked.headers.get('content-disposition')).toStartWith('attachment');
    const word = await a.request('/data/attachments/post/42/2');
    expect(word.headers.get('content-type')).toBe('application/octet-stream');
    expect(word.headers.get('content-disposition')).toStartWith('attachment');
    // HTML from Aula is never served as a page on this origin.
    const html = await a.request('/data/attachments/message/7%3A1/0');
    expect(html.headers.get('content-type')).toBe('application/octet-stream');
  });

  test('a file that is not saved, or not there, is a 404', async () => {
    const a = app();
    expect((await a.request('/data/attachments/post/42/3')).status).toBe(404);
    expect((await a.request('/data/attachments/post/42/9')).status).toBe(404);
    expect((await a.request('/data/attachments/post/nope/0')).status).toBe(404);
    expect((await a.request('/data/attachments/post/42/-1')).status).toBe(400);
  });

  test('a post with saved photos is an album in the gallery', async () => {
    const res = await app().request('/data/gallery');
    const { posts } = (await res.json()) as {
      posts: Array<{ postId: string; title: string; date: string; media: unknown[] }>;
    };
    expect(posts).toEqual([
      {
        postId: '42',
        title: 'Skovtur',
        date: '2026-11-20',
        author: 'Lærer',
        media: [{ index: 0, name: 'foto.JPG', mediaType: 'image/jpeg', size: null, saved: true }],
      },
    ] as never);
  });

  test('deleting the posts deletes their saved files', async () => {
    const res = await app().request('/data/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'post', confirm: 'SLET' }),
    });
    expect(res.status).toBe(200);
    expect(await files.forParent('a').exists('attachments/post/42/0.jpg')).toBe(false);
    expect(await files.forParent('a').exists('attachments/message/7_3A1/0.html')).toBe(true);
  });
});
