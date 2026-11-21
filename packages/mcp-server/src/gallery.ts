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
 *   AULA_MCP_GALLERY_STORE    — `disk` (default) or `s3`
 *   AULA_MCP_GALLERY_S3_BUCKET, _ENDPOINT, _REGION, _PREFIX — the bucket with
 *     `s3`; keys come from AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY. The
 *     same layout is used under <prefix><parentId>/, and S3 has no disk limit.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, readdir, rename, rm, rmdir, stat, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { GalleryAlbum, GalleryMedia } from '@aula-mcp/aula-client';
import {
  type AttachmentKind,
  type AttachmentView,
  attachmentFiles,
  attachmentRel,
  openAttachment,
  removeAttachments,
  storedAttachments,
} from './attachments.ts';
import { resolveFamilyProfileIds } from './family-profiles.ts';
import type { ItemKind, ParentStorage, StoredItem, SyncState } from './storage.ts';
import type { SyncJob } from './sync.ts';

const MINUTE = 60 * 1000;

/** Files fetched per run; the next run comes sooner while more are waiting. */
export const GALLERY_DOWNLOADS_PER_RUN = 300;
/** Signed URLs last about 30 minutes: list again before they run out. */
const LISTING_FRESH_MS = 20 * MINUTE;
const PAGE_SIZE = 50;
/** Folder for albums that are not one child's alone. */
export const SHARED_FOLDER = 'Fælles';

export interface GalleryS3Config {
  bucket: string;
  endpoint?: string;
  region: string;
  /** Put before every key, e.g. `aula/`. */
  prefix: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface GalleryConfig {
  dir: string;
  /** Set when files go to an S3 bucket instead of `dir`. */
  s3?: GalleryS3Config;
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
  const store = env.AULA_MCP_GALLERY_STORE ?? 'disk';
  if (store !== 'disk' && store !== 's3') {
    throw new Error(`AULA_MCP_GALLERY_STORE must be disk or s3, not "${store}".`);
  }
  const bucket = env.AULA_MCP_GALLERY_S3_BUCKET;
  if (store === 's3' && !bucket) {
    throw new Error('AULA_MCP_GALLERY_STORE=s3 needs AULA_MCP_GALLERY_S3_BUCKET.');
  }
  const prefix = env.AULA_MCP_GALLERY_S3_PREFIX ?? '';
  if (prefix && !/^[A-Za-z0-9._/-]+\/$/.test(prefix)) {
    throw new Error('AULA_MCP_GALLERY_S3_PREFIX must end with / and use only A-Z a-z 0-9 . _ - /.');
  }
  return {
    dir: env.AULA_MCP_GALLERY_DIR ?? join(base, 'gallery'),
    downloads: env.AULA_MCP_GALLERY !== '0',
    stopAt,
    ...(store === 's3' && bucket
      ? {
          s3: {
            bucket,
            ...(env.AULA_MCP_GALLERY_S3_ENDPOINT
              ? { endpoint: env.AULA_MCP_GALLERY_S3_ENDPOINT }
              : {}),
            region: env.AULA_MCP_GALLERY_S3_REGION ?? 'us-east-1',
            prefix,
            ...(env.AWS_ACCESS_KEY_ID ? { accessKeyId: env.AWS_ACCESS_KEY_ID } : {}),
            ...(env.AWS_SECRET_ACCESS_KEY ? { secretAccessKey: env.AWS_SECRET_ACCESS_KEY } : {}),
          },
        }
      : {}),
  };
}

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
  /** 0–1. */
  used: number;
}

/** One parent's gallery files. Every path is relative and checked to stay inside. */
export interface ParentGallery {
  readonly config: GalleryConfig;
  /** Where the files are, without credentials: a folder or `s3://bucket/prefix`. */
  readonly location: string;
  /** How full the disk is; null on S3, which has no limit to pause at. */
  disk(): Promise<DiskUsage | null>;
  exists(rel: string): Promise<boolean>;
  /**
   * Fetches `url` to `rel` and hashes it on the way. `keep` gets the hash and
   * decides: true keeps it at `rel`, false drops it.
   */
  download(
    url: string,
    rel: string,
    keep: (sha256: string) => boolean,
  ): Promise<{ sha256: string; bytes: number; kept: boolean }>;
  remove(rel: string): Promise<void>;
  /** A read stream of the file, for the dashboard. */
  open(rel: string): Promise<{ stream: Readable; bytes: number } | null>;
  /** Stores an already stored file under a second name; false when it can't. */
  linkTo(existingRel: string, rel: string): Promise<boolean>;
}

/** The S3 calls the gallery makes; Bun's S3Client has them. */
export interface S3Like {
  file(key: string): {
    exists(): Promise<boolean>;
    stat(): Promise<{ size: number }>;
    stream(): ReadableStream<Uint8Array>;
    delete(): Promise<void>;
    writer(options?: { partSize?: number }): {
      write(chunk: Uint8Array): number | Promise<number>;
      end(): Promise<number> | number;
    };
  };
}

/** The gallery files of every parent. */
export class GalleryFiles {
  readonly config: GalleryConfig;
  private readonly fetchFn: typeof fetch;
  private readonly s3: S3Like | null;

  constructor(config: GalleryConfig, options: { fetch?: typeof fetch; s3?: S3Like } = {}) {
    this.config = config;
    this.fetchFn = options.fetch ?? fetch;
    this.s3 = config.s3 ? (options.s3 ?? bunS3(config.s3)) : null;
  }

  forParent(parentId: string): ParentGallery {
    if (!/^[A-Za-z0-9._-]+$/.test(parentId) || parentId.startsWith('.')) {
      throw new Error('gallery: unusable parent id');
    }
    if (this.s3 && this.config.s3) {
      return new S3ParentGallery(
        this.s3,
        `${this.config.s3.prefix}${parentId}/`,
        `s3://${this.config.s3.bucket}/${this.config.s3.prefix}${parentId}/`,
        this.config,
        this.fetchFn,
      );
    }
    return new DiskParentGallery(
      join(resolve(this.config.dir), parentId),
      this.config,
      this.fetchFn,
    );
  }
}

function bunS3(config: GalleryS3Config): S3Like {
  return new Bun.S3Client({
    bucket: config.bucket,
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.accessKeyId ? { accessKeyId: config.accessKeyId } : {}),
    ...(config.secretAccessKey ? { secretAccessKey: config.secretAccessKey } : {}),
  }) as unknown as S3Like;
}

/** Fetches an Aula media URL; the error never carries the signed URL. */
async function fetchMedia(fetchFn: typeof fetch, url: string): Promise<Readable> {
  if (!isAulaMediaUrl(url)) throw new Error('gallery: not an Aula media URL');
  const response = await fetchFn(url, { redirect: 'error' });
  // Status only: the URL is a signed grant to the file.
  if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`);
  return Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
}

/** One parent's gallery folder on disk. */
export class DiskParentGallery implements ParentGallery {
  constructor(
    readonly root: string,
    readonly config: GalleryConfig,
    private readonly fetchFn: typeof fetch,
  ) {}

  get location(): string {
    return this.root;
  }

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

  /** Writes to a temporary file next to `rel` and renames it when kept. */
  async download(
    url: string,
    rel: string,
    keep: (sha256: string) => boolean,
  ): Promise<{ sha256: string; bytes: number; kept: boolean }> {
    const target = this.resolve(rel);
    if (!target) throw new Error('gallery: path outside the parent folder');
    const body = await fetchMedia(this.fetchFn, url);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.part-${randomUUID()}`;
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      await pipeline(
        body,
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

  async open(rel: string): Promise<{ stream: Readable; bytes: number } | null> {
    const full = this.resolve(rel);
    if (!full) return null;
    const s = await stat(full).catch(() => null);
    if (!s?.isFile()) return null;
    return { stream: createReadStream(full), bytes: s.size };
  }

  /** A hard link. */
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

/**
 * One parent's gallery in an S3 bucket, under `<prefix><parentId>/`. Objects
 * have no hard links, so a second copy points at the first file instead.
 */
export class S3ParentGallery implements ParentGallery {
  constructor(
    private readonly s3: S3Like,
    /** `<prefix><parentId>/`. */
    private readonly base: string,
    readonly location: string,
    readonly config: GalleryConfig,
    private readonly fetchFn: typeof fetch,
  ) {}

  /** The object key of `rel`, or null when it would leave the parent's prefix. */
  key(rel: string): string | null {
    const full = resolve('/r', rel);
    return full.startsWith('/r/') ? this.base + full.slice(3) : null;
  }

  async disk(): Promise<null> {
    return null;
  }

  async exists(rel: string): Promise<boolean> {
    const key = this.key(rel);
    return key
      ? this.s3
          .file(key)
          .exists()
          .catch(() => false)
      : false;
  }

  /** Writes straight to `rel` (multipart for big files) and deletes it when not kept. */
  async download(
    url: string,
    rel: string,
    keep: (sha256: string) => boolean,
  ): Promise<{ sha256: string; bytes: number; kept: boolean }> {
    const key = this.key(rel);
    if (!key) throw new Error('gallery: path outside the parent folder');
    const body = await fetchMedia(this.fetchFn, url);
    const file = this.s3.file(key);
    const writer = file.writer({ partSize: 8 * 1024 * 1024 });
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of body as AsyncIterable<Buffer>) {
        hash.update(chunk);
        bytes += chunk.length;
        await writer.write(chunk);
      }
      await writer.end();
    } catch (err) {
      await Promise.resolve(writer.end()).catch(() => {});
      await file.delete().catch(() => {});
      throw err;
    }
    const sha256 = hash.digest('hex');
    const kept = keep(sha256);
    if (!kept) await file.delete();
    return { sha256, bytes, kept };
  }

  async remove(rel: string): Promise<void> {
    const key = this.key(rel);
    if (key) await this.s3.file(key).delete();
  }

  async open(rel: string): Promise<{ stream: Readable; bytes: number } | null> {
    const key = this.key(rel);
    if (!key) return null;
    const file = this.s3.file(key);
    const s = await file.stat().catch(() => null);
    if (!s) return null;
    return {
      stream: Readable.fromWeb(file.stream() as import('node:stream/web').ReadableStream),
      bytes: s.size,
    };
  }

  async linkTo(): Promise<boolean> {
    return false;
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
async function listAll(store: ParentStorage, kind: ItemKind) {
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
        } else if (((await gallery.disk())?.used ?? 0) >= gallery.config.stopAt) {
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
  /** Where the files go: `disk` or `s3`. */
  store: 'disk' | 's3';
  /** The folder or `s3://bucket/prefix`, without credentials. */
  location: string;
  /** Null on S3, or when the disk can't be read. */
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

/** The photos and videos of one post, shown as an album. */
export interface PostAlbum {
  postId: string;
  title: string;
  /** YYYY-MM-DD, Danish time. */
  date: string | null;
  author: string | null;
  media: AttachmentView[];
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
      store: this.files.config.s3 ? 's3' : 'disk',
      location: this.files.location,
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
  /** A post's or message's attachments, each marked saved or not. */
  attachments(kind: AttachmentKind, id: string): Promise<AttachmentView[]> {
    return storedAttachments(this.store, this.files, kind, id);
  }

  /** One saved attachment, or null. */
  attachment(kind: AttachmentKind, id: string, index: number) {
    return openAttachment(this.store, this.files, kind, id, index);
  }

  /** Deletes the saved attachments of posts, of messages, or of both. */
  removeAttachments(kind?: AttachmentKind): Promise<number> {
    return removeAttachments(this.store, this.files, kind);
  }

  /**
   * Every post with saved photos or videos, newest first: an album each in
   * the dashboard's gallery, made here and never in Aula.
   */
  async postAlbums(): Promise<PostAlbum[]> {
    const out: PostAlbum[] = [];
    for (const row of await listAll(this.store, 'post')) {
      const media: AttachmentView[] = [];
      for (const file of attachmentFiles(row.data)) {
        if (!/^(image|video)\//.test(file.mediaType)) continue;
        if (!(await this.files.exists(attachmentRel('post', row.id, file)))) continue;
        const { url: _url, ...view } = file;
        media.push({ ...view, saved: true });
      }
      if (!media.length) continue;
      const post = row.data as { title?: string; ownerProfile?: { fullName?: string } };
      out.push({
        postId: row.id,
        title: post.title?.trim() || `Opslag ${row.id}`,
        date:
          row.occurredAt === null
            ? null
            : copenhagenDate(new Date(row.occurredAt * 1000).toISOString()),
        author: post.ownerProfile?.fullName ?? null,
        media,
      });
    }
    return out;
  }

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
