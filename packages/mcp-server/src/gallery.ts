/**
 * Gallery downloads: every photo and video in the parent's Aula albums, kept
 * in original quality with a thumbnail, ordered per child and year.
 *
 *   <dir>/<parentId>/<child>/<year>/<yyyy-mm-dd album title>/<mediaId>.<ext>
 *   <dir>/<parentId>/.thumbs/<mediaId>.jpg
 *
 * - Each parent has their own folder; nothing is read across parents.
 * - Aula's file URLs are signed and expire after about 30 minutes, so they
 *   are fetched fresh by every run and never stored or logged.
 * - The same file in two albums is stored once (sha256).
 * - Downloads pause when the disk is 90% full.
 * - Kept until the parent deletes it. A deleted album stays deleted: sync
 *   does not fetch it again.
 *
 * Env:
 *   AULA_MCP_GALLERY_DIR      — where files go (default <AULA_MCP_DIR>/gallery)
 *   AULA_MCP_GALLERY=0        — no downloads; albums are still listed
 *   AULA_MCP_GALLERY_STOP_AT  — disk use that pauses downloads, 0–1 (default 0.9)
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, readdir, rename, rm, rmdir, stat, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { GalleryAlbum, GalleryMedia } from '@aula-mcp/aula-client';
import { resolveFamilyProfileIds } from './family-profiles.ts';
import type { ParentStorage, StoredItem, SyncState } from './storage.ts';
import type { SyncJob } from './sync.ts';

const MINUTE = 60 * 1000;

/** Files fetched per run; the next run comes sooner while more are waiting. */
export const GALLERY_DOWNLOADS_PER_RUN = 300;
/** Signed URLs last about 30 minutes: list again before they run out. */
const LISTING_FRESH_MS = 20 * MINUTE;
const PAGE_SIZE = 50;
/** Folder for albums that are not one child's alone. */
export const SHARED_FOLDER = 'Fælles';

export interface GalleryConfig {
  dir: string;
  /** False with AULA_MCP_GALLERY=0: albums are listed, nothing is downloaded. */
  downloads: boolean;
  /** Disk use (0–1) at which downloads pause. */
  stopAt: number;
}

export function galleryConfig(env: NodeJS.ProcessEnv = process.env): GalleryConfig {
  const base = env.AULA_MCP_DIR ?? join(homedir(), '.config', 'aula-mcp');
  const stopAt = Number(env.AULA_MCP_GALLERY_STOP_AT ?? 0.9);
  if (!(stopAt > 0 && stopAt <= 1)) {
    throw new Error(
      `AULA_MCP_GALLERY_STOP_AT must be between 0 and 1, not "${env.AULA_MCP_GALLERY_STOP_AT}".`,
    );
  }
  return {
    dir: env.AULA_MCP_GALLERY_DIR ?? join(base, 'gallery'),
    downloads: env.AULA_MCP_GALLERY !== '0',
    stopAt,
  };
}

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
  /** 0–1. */
  used: number;
}

/** The gallery folders of every parent. */
export class GalleryFiles {
  readonly config: GalleryConfig;
  private readonly fetchFn: typeof fetch;

  constructor(config: GalleryConfig, options: { fetch?: typeof fetch } = {}) {
    this.config = config;
    this.fetchFn = options.fetch ?? fetch;
  }

  forParent(parentId: string): ParentGallery {
    if (!/^[A-Za-z0-9._-]+$/.test(parentId) || parentId.startsWith('.')) {
      throw new Error('gallery: unusable parent id');
    }
    return new ParentGallery(join(resolve(this.config.dir), parentId), this.config, this.fetchFn);
  }
}

/** One parent's gallery folder. Every path is relative to it and checked to stay inside. */
export class ParentGallery {
  constructor(
    readonly root: string,
    readonly config: GalleryConfig,
    private readonly fetchFn: typeof fetch,
  ) {}

  /** The absolute path of `rel`, or null when it would leave the parent's folder. */
  resolve(rel: string): string | null {
    const full = resolve(this.root, rel);
    return full.startsWith(this.root + sep) ? full : null;
  }

  async disk(): Promise<DiskUsage> {
    await mkdir(this.root, { recursive: true });
    const s = await statfs(this.root);
    const totalBytes = s.blocks * s.bsize;
    const freeBytes = s.bavail * s.bsize;
    return { totalBytes, freeBytes, used: totalBytes > 0 ? 1 - freeBytes / totalBytes : 1 };
  }

  async exists(rel: string): Promise<boolean> {
    const full = this.resolve(rel);
    if (!full) return false;
    return stat(full).then(
      (s) => s.isFile(),
      () => false,
    );
  }

  /**
   * Fetches `url` into a temporary file next to `rel` and hashes it on the way.
   * `keep` gets the hash and decides: true moves it to `rel`, false drops it.
   */
  async download(
    url: string,
    rel: string,
    keep: (sha256: string) => boolean,
  ): Promise<{ sha256: string; bytes: number; kept: boolean }> {
    const target = this.resolve(rel);
    if (!target) throw new Error('gallery: path outside the parent folder');
    if (!isAulaMediaUrl(url)) throw new Error('gallery: not an Aula media URL');
    const response = await this.fetchFn(url, { redirect: 'error' });
    // Status only: the URL is a signed grant to the file.
    if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.part-${randomUUID()}`;
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        new Transform({
          transform(chunk: Buffer, _encoding, done) {
            hash.update(chunk);
            bytes += chunk.length;
            done(null, chunk);
          },
        }),
        createWriteStream(tmp, { mode: 0o600 }),
      );
      const sha256 = hash.digest('hex');
      const kept = keep(sha256);
      if (kept) await rename(tmp, target);
      else await rm(tmp, { force: true });
      return { sha256, bytes, kept };
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  /** Removes a file and the folders it leaves empty, up to the parent's folder. */
  async remove(rel: string): Promise<void> {
    const full = this.resolve(rel);
    if (!full) return;
    await rm(full, { force: true });
    for (let dir = dirname(full); dir.startsWith(this.root + sep); dir = dirname(dir)) {
      if ((await readdir(dir).catch(() => ['?'])).length > 0) break;
      await rmdir(dir).catch(() => {});
    }
  }

  /** A read stream of the file, for the dashboard. */
  async open(rel: string): Promise<{ stream: Readable; bytes: number } | null> {
    const full = this.resolve(rel);
    if (!full) return null;
    const s = await stat(full).catch(() => null);
    if (!s?.isFile()) return null;
    return { stream: createReadStream(full), bytes: s.size };
  }

  /** Hard-links an already stored file under a second name; false when it can't. */
  async linkTo(existingRel: string, rel: string): Promise<boolean> {
    const from = this.resolve(existingRel);
    const to = this.resolve(rel);
    if (!from || !to) return false;
    await mkdir(dirname(to), { recursive: true });
    return link(from, to).then(
      () => true,
      () => false,
    );
  }
}

/** Only Aula's own media host is fetched, whatever the listing says. */
function isAulaMediaUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'aula.dk' || u.hostname.endsWith('.aula.dk'));
  } catch {
    return false;
  }
}

// --- stored rows ------------------------------------------------------------

/** `gallery_album` row data: the album without its signed URLs. */
export interface StoredAlbum {
  album: GalleryAlbum;
  /** Child folder name, or SHARED_FOLDER. */
  child: string;
  /** Folder relative to the parent's gallery root. */
  folder: string;
  mediaCount: number;
  /** Set when the parent deleted the album here; sync leaves it alone after that. */
  removedAt?: number;
}

/** `gallery_media` row data, id `<albumId>:<mediaId>`. */
export interface StoredMedia {
  albumId: number;
  media: GalleryMedia;
  /** Relative to the parent's gallery root; null until downloaded. */
  path: string | null;
  thumb: string | null;
  sha256: string | null;
  bytes: number;
  downloadedAt: number | null;
  /** The last download error, without the URL. */
  error?: string;
  removedAt?: number;
}

/** Drops every `*Url` / `*Urls` field: signed URLs are never stored. */
export function withoutUrls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutUrls) as T;
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (/urls?$/i.test(key)) continue;
    out[key] = withoutUrls(v);
  }
  return out as T;
}

/** A path segment safe on every file system. */
export function safeName(name: string, fallback: string): string {
  const cleaned = name
    .normalize('NFC')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

function extensionOf(media: GalleryMedia): string {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(media.file?.name ?? '');
  if (match?.[1]) return match[1].toLowerCase();
  return media.mediaType === 'video' ? 'mp4' : 'jpg';
}

function copenhagenDate(iso: string | undefined): string | null {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Copenhagen' }).format(d);
}

export function albumFolder(album: GalleryAlbum, child: string): string {
  const date = copenhagenDate(album.creationDate);
  const year = date?.slice(0, 4) ?? 'Uden dato';
  const title = safeName(album.title ?? '', `Album ${album.id}`);
  return [child, year, safeName(`${date ?? ''} ${title}`, title)].join('/');
}

/** Every stored row of a kind, page by page. */
async function listAll(store: ParentStorage, kind: 'gallery_album' | 'gallery_media') {
  const rows: StoredItem[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await store.list({ kind, limit: 500, offset });
    rows.push(...page);
    if (page.length < 500) return rows;
  }
}

// --- sync job ---------------------------------------------------------------

interface Child {
  id: number;
  name: string;
}

/**
 * Lists every album and its media, stores them without URLs, and downloads
 * what is not on disk yet, up to GALLERY_DOWNLOADS_PER_RUN files.
 */
export const syncGallery: SyncJob = async ({ client, store, gallery, childIds }) => {
  if (!gallery) return { fetched: 0, changed: 0 };
  const institutionProfileIds = await resolveFamilyProfileIds(client);
  const ids = new Set(await childIds());
  const children: Child[] = ((await client.getProfilesByLogin()).profiles ?? [])
    .flatMap((p) => p.children ?? [])
    .filter((c) => ids.has(c.id))
    .map((c) => ({ id: c.id, name: safeName(c.name, `Barn ${c.id}`) }));
  const childGroups = new Map<number, Set<number>>();
  for (const child of children) {
    childGroups.set(child.id, new Set(groupIds(await client.getGroups([child.id]))));
  }

  const storedAlbums = new Map(
    (await listAll(store, 'gallery_album')).map((row) => [row.id, row.data as StoredAlbum]),
  );
  const storedMedia = new Map(
    (await listAll(store, 'gallery_media')).map((row) => [row.id, row.data as StoredMedia]),
  );
  const bySha = new Map<string, string>();
  for (const m of storedMedia.values()) if (m.sha256 && m.path) bySha.set(m.sha256, m.path);

  let fetched = 0;
  let changed = 0;
  let downloads = 0;
  let pending = 0;
  let more = false;
  let diskFull = false;

  const albums: GalleryAlbum[] = [];
  for (let index = 0; ; index += 100) {
    const page = await client.getAlbums({ institutionProfileIds, index, limit: 100 });
    albums.push(...page);
    if (page.length < 100) break;
  }

  for (const album of albums) {
    const key = String(album.id);
    const before = storedAlbums.get(key);
    if (before?.removedAt) continue;

    let listedAt = Date.now();
    const listMedia = async () => {
      const items: GalleryMedia[] = [];
      for (let index = 0; ; index += PAGE_SIZE) {
        const page = await client.getAlbumMedia({
          albumId: album.id,
          institutionProfileIds,
          index,
          limit: PAGE_SIZE,
        });
        const results = page.results ?? [];
        items.push(...results);
        const total = page.totalSize ?? page.mediaCount ?? 0;
        if (results.length === 0 || (page.startIndex ?? index) + results.length >= total) break;
      }
      listedAt = Date.now();
      return items;
    };
    let media = await listMedia();
    fetched += media.length;

    // An album already filed keeps its folder, so files never move.
    const child = before?.child ?? childOf(album, media, children, childGroups);
    const folder = before?.folder ?? albumFolder(album, child);
    const albumRow: StoredAlbum = {
      album: withoutUrls(album),
      child,
      folder,
      mediaCount: media.length,
    };
    changed += (
      await store.put([
        { kind: 'gallery_album', id: key, occurredAt: album.creationDate ?? null, data: albumRow },
      ])
    ).changed;

    for (let i = 0; i < media.length; i++) {
      const item = media[i] as GalleryMedia;
      const id = `${album.id}:${item.id}`;
      const old = storedMedia.get(id);
      if (old?.removedAt) continue;
      const row: StoredMedia = {
        albumId: album.id,
        media: withoutUrls(item),
        path: old?.path ?? null,
        thumb: old?.thumb ?? null,
        sha256: old?.sha256 ?? null,
        bytes: old?.bytes ?? 0,
        downloadedAt: old?.downloadedAt ?? null,
      };
      const ready = item.conversionStatus === undefined || item.conversionStatus === 'completed';
      const onDisk = row.path ? await gallery.exists(row.path) : false;
      const thumbOnDisk = row.thumb ? await gallery.exists(row.thumb) : false;
      if (!onDisk) {
        row.path = null;
        row.downloadedAt = null;
      }
      if (!thumbOnDisk) row.thumb = null;

      const wanted =
        gallery.config.downloads &&
        ready &&
        !item.isDeleted &&
        (!onDisk || (!thumbOnDisk && item.thumbnailUrl));
      if (wanted) {
        if (downloads >= GALLERY_DOWNLOADS_PER_RUN || diskFull) {
          pending++;
          more ||= !diskFull;
        } else if ((await gallery.disk()).used >= gallery.config.stopAt) {
          diskFull = true;
          pending++;
        } else {
          if (Date.now() - listedAt > LISTING_FRESH_MS) {
            media = await listMedia();
            const fresh = media.find((m) => m.id === item.id);
            if (fresh) Object.assign(item, fresh);
          }
          downloads++;
          try {
            if (!onDisk && item.file?.url) {
              const rel = `${folder}/${item.id}.${extensionOf(item)}`;
              const result = await gallery.download(item.file.url, rel, (sha) => !bySha.has(sha));
              // Seen before in another album: link to that file, or point at it.
              const existing = result.kept ? null : (bySha.get(result.sha256) as string);
              row.path = existing ? ((await gallery.linkTo(existing, rel)) ? rel : existing) : rel;
              row.sha256 = result.sha256;
              row.bytes = result.bytes;
              row.downloadedAt = Math.floor(Date.now() / 1000);
              bySha.set(result.sha256, row.path);
            }
            if (!row.thumb && item.thumbnailUrl) {
              const rel = `.thumbs/${item.id}.jpg`;
              await gallery.download(item.thumbnailUrl, rel, () => true);
              row.thumb = rel;
            }
            delete row.error;
          } catch (err) {
            row.error = (err instanceof Error ? err.message : String(err)).slice(0, 200);
          }
        }
      }
      changed += (
        await store.put([
          {
            kind: 'gallery_media',
            id,
            occurredAt: item.file?.created ?? album.creationDate ?? null,
            data: row,
          },
        ])
      ).changed;
    }
  }
  return { fetched, changed, ...(pending ? { skipped: pending } : {}), ...(more ? { more } : {}) };
};

/**
 * The child an album is filed under: the one child tagged in it, else the one
 * child whose groups it is shared with, else SHARED_FOLDER.
 */
export function childOf(
  album: GalleryAlbum,
  media: GalleryMedia[],
  children: Child[],
  childGroups: Map<number, Set<number>>,
): string {
  const tagged = new Set(
    media
      .flatMap((m) => (m.tags ?? []).map((t) => t.id))
      .filter((id) => children.some((c) => c.id === id)),
  );
  if (tagged.size === 1) return children.find((c) => tagged.has(c.id))?.name ?? SHARED_FOLDER;
  if (tagged.size > 1) return SHARED_FOLDER;
  const shared = new Set((album.sharedWithGroups ?? []).map((g) => g.id));
  const matching = children.filter((c) =>
    [...(childGroups.get(c.id) ?? [])].some((g) => shared.has(g)),
  );
  return matching.length === 1 ? (matching[0] as Child).name : SHARED_FOLDER;
}

/** Group ids out of groups.getGroupsByContext, whatever its wrapping. */
function groupIds(raw: unknown): number[] {
  const list = Array.isArray(raw)
    ? raw
    : ((raw as { groups?: unknown[] } | null)?.groups ??
      (raw as { data?: unknown[] } | null)?.data ??
      []);
  return (Array.isArray(list) ? list : [])
    .map((g) => Number((g as { id?: unknown })?.id))
    .filter((id) => Number.isFinite(id));
}

// --- reading ----------------------------------------------------------------

export interface GalleryStatus {
  downloads: boolean;
  stopAt: number;
  disk: DiskUsage | null;
  albums: number;
  media: number;
  downloaded: number;
  /** Listed but not on disk yet (excluding deleted). */
  waiting: number;
  failed: number;
  /** Bytes of the stored originals, each file counted once. */
  bytes: number;
  children: Array<{ child: string; albums: number; media: number; bytes: number }>;
  sync: SyncState | null;
}

export interface AlbumSummary {
  id: number;
  title: string;
  child: string;
  year: string;
  date: string | null;
  folder: string;
  creator: string | null;
  groups: string[];
  mediaCount: number;
  downloaded: number;
  bytes: number;
  removed: boolean;
  /** First downloaded media id with a thumbnail, for a cover. */
  coverMediaId: number | null;
}

export interface MediaSummary {
  id: number;
  albumId: number;
  type: string;
  name: string | null;
  title: string | null;
  created: string | null;
  bytes: number;
  downloaded: boolean;
  hasThumb: boolean;
  path: string | null;
  tags: string[];
  error: string | null;
}

/** One parent's gallery as the tools and the dashboard read it. */
export class GalleryView {
  constructor(
    private readonly store: ParentStorage,
    private readonly files: ParentGallery,
  ) {}

  private async rows() {
    const albums = (await listAll(this.store, 'gallery_album')).map((r) => r.data as StoredAlbum);
    const media = (await listAll(this.store, 'gallery_media')).map((r) => r.data as StoredMedia);
    return { albums, media };
  }

  async status(): Promise<GalleryStatus> {
    const { albums, media } = await this.rows();
    const live = media.filter((m) => !m.removedAt);
    const albumChild = new Map(albums.map((a) => [a.album.id, a.child]));
    const seen = new Set<string>();
    const children = new Map<
      string,
      { child: string; albums: number; media: number; bytes: number }
    >();
    const entry = (child: string) => {
      const e = children.get(child) ?? { child, albums: 0, media: 0, bytes: 0 };
      children.set(child, e);
      return e;
    };
    for (const a of albums) if (!a.removedAt) entry(a.child).albums++;
    let bytes = 0;
    for (const m of live) {
      const e = entry(albumChild.get(m.albumId) ?? SHARED_FOLDER);
      e.media++;
      if (m.path && m.sha256 && !seen.has(m.sha256)) {
        seen.add(m.sha256);
        bytes += m.bytes;
        e.bytes += m.bytes;
      }
    }
    return {
      downloads: this.files.config.downloads,
      stopAt: this.files.config.stopAt,
      disk: await this.files.disk().catch(() => null),
      albums: albums.filter((a) => !a.removedAt).length,
      media: live.length,
      downloaded: live.filter((m) => m.path).length,
      waiting: live.filter((m) => !m.path && !m.media.isDeleted).length,
      failed: live.filter((m) => m.error).length,
      bytes,
      children: [...children.values()].sort((a, b) => a.child.localeCompare(b.child, 'da')),
      sync: (await this.store.syncStates()).find((s) => s.job === 'gallery') ?? null,
    };
  }

  async albums(
    query: { child?: string; year?: string; includeRemoved?: boolean } = {},
  ): Promise<AlbumSummary[]> {
    const { albums, media } = await this.rows();
    const byAlbum = new Map<number, StoredMedia[]>();
    for (const m of media) {
      if (m.removedAt) continue;
      const list = byAlbum.get(m.albumId) ?? [];
      list.push(m);
      byAlbum.set(m.albumId, list);
    }
    return albums
      .map((a) => {
        const items = byAlbum.get(a.album.id) ?? [];
        const date = copenhagenDate(a.album.creationDate);
        return {
          id: a.album.id,
          title: a.album.title ?? `Album ${a.album.id}`,
          child: a.child,
          year: date?.slice(0, 4) ?? 'Uden dato',
          date,
          folder: a.folder,
          creator: a.album.creator?.name ?? null,
          groups: (a.album.sharedWithGroups ?? []).map((g) => g.name ?? String(g.id)),
          mediaCount: a.mediaCount,
          downloaded: items.filter((m) => m.path).length,
          bytes: items.reduce((sum, m) => sum + (m.path ? m.bytes : 0), 0),
          removed: Boolean(a.removedAt),
          coverMediaId: items.find((m) => m.thumb)?.media.id ?? null,
        };
      })
      .filter(
        (a) =>
          (query.includeRemoved || !a.removed) &&
          (!query.child || a.child === query.child) &&
          (!query.year || a.year === query.year),
      )
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.id - a.id);
  }

  async media(albumId: number): Promise<MediaSummary[]> {
    const all: StoredItem[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await this.store.list({
        kind: 'gallery_media',
        idPrefix: `${albumId}:`,
        limit: 500,
        offset,
      });
      all.push(...page);
      if (page.length < 500) break;
    }
    return all
      .map((r) => r.data as StoredMedia)
      .filter((m) => !m.removedAt)
      .map((m) => ({
        id: m.media.id,
        albumId: m.albumId,
        type: m.media.mediaType ?? 'image',
        name: m.media.file?.name ?? null,
        title: m.media.title ?? null,
        created: m.media.file?.created ?? null,
        bytes: m.bytes,
        downloaded: Boolean(m.path),
        hasThumb: Boolean(m.thumb),
        path: m.path,
        tags: (m.media.tags ?? []).map((t) => t.name ?? String(t.id)),
        error: m.error ?? null,
      }))
      .sort((a, b) => (a.created ?? '').localeCompare(b.created ?? '') || a.id - b.id);
  }

  /** The stored file (or its thumbnail) of one media item. */
  async file(albumId: number, mediaId: number, variant: 'original' | 'thumb') {
    const row = await this.store.get('gallery_media', `${albumId}:${mediaId}`);
    const m = row?.data as StoredMedia | undefined;
    const rel = variant === 'thumb' ? m?.thumb : m?.path;
    if (!m || m.removedAt || !rel) return null;
    const opened = await this.files.open(rel);
    if (!opened) return null;
    const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase();
    return {
      ...opened,
      contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream',
      name: m.media.file?.name ?? rel.slice(rel.lastIndexOf('/') + 1),
    };
  }

  /**
   * Deletes the local copies of one album, or of every album, and keeps a
   * marker so sync does not fetch them again. Nothing in Aula is touched.
   */
  async remove(
    target: { albumId: number } | { all: true },
  ): Promise<{ albums: number; files: number }> {
    const { albums, media } = await this.rows();
    const now = Math.floor(Date.now() / 1000);
    const hit = (albumId: number) => 'all' in target || albumId === target.albumId;
    const gone = media.filter((m) => !m.removedAt && hit(m.albumId));
    const stillUsed = new Set(
      media.filter((m) => !m.removedAt && !hit(m.albumId) && m.path).map((m) => m.path),
    );
    let files = 0;
    for (const m of gone) {
      if (m.path && !stillUsed.has(m.path)) {
        await this.files.remove(m.path);
        files++;
      }
      if (m.thumb) await this.files.remove(m.thumb);
    }
    const removedAlbums = albums.filter((a) => !a.removedAt && hit(a.album.id));
    await this.store.put([
      ...removedAlbums.map((a) => ({
        kind: 'gallery_album' as const,
        id: String(a.album.id),
        occurredAt: a.album.creationDate ?? null,
        data: { ...a, removedAt: now },
      })),
      ...gone.map((m) => ({
        kind: 'gallery_media' as const,
        id: `${m.albumId}:${m.media.id}`,
        occurredAt: m.media.file?.created ?? null,
        data: { ...m, path: null, thumb: null, downloadedAt: null, removedAt: now },
      })),
    ]);
    return { albums: removedAlbums.length, files };
  }
}

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
};
