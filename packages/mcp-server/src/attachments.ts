/**
 * Attachments of posts and messages, kept next to the gallery files.
 *
 * Aula's attachment links are presigned and expire after about an hour, so
 * a link in the stored data is dead by the time anyone opens it. The sync
 * saves each file while its link is fresh, under
 * `attachments/<kind>/<id>/<n>.<ext>` in the parent's gallery folder or
 * bucket, and the dashboard serves it from there. The links themselves are
 * never logged or sent to the browser.
 */

import { extname } from 'node:path';
import type { ParentGallery } from './gallery.ts';
import type { ItemInput, ParentStorage } from './storage.ts';

export type AttachmentKind = 'post' | 'message';

export interface AttachmentFile {
  index: number;
  name: string;
  mediaType: string;
  size: number | null;
  /** Aula's presigned link; null when the stored data has none. */
  url: string | null;
}

/** What the dashboard and the tools may see: no link. */
export interface AttachmentView {
  index: number;
  name: string;
  mediaType: string;
  size: number | null;
  /** Whether a copy is saved and can be opened. */
  saved?: boolean;
}

/** Most files one item may carry. */
const MAX_FILES = 20;

/** Types a browser may show inline; anything else is only downloaded. */
const INLINE = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/mp4',
  'text/plain',
]);

const BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  txt: 'text/plain',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

type Data = Record<string, unknown>;
const asData = (v: unknown): Data =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Data) : {};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * The files of a stored post or message. Documents come as `file`, images
 * in messages as `media.file`, and some posts put name and url on the
 * attachment itself.
 */
export function attachmentFiles(data: unknown): AttachmentFile[] {
  const list = asData(data).attachments;
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_FILES).map((a, index) => {
    const x = asData(a);
    const f =
      [asData(x.file), asData(asData(x.media).file), x].find((o) => str(o.name) || str(o.url)) ??
      {};
    const name = str(f.name) || 'Vedhæftet fil';
    const given = str(f.mediaType).toLowerCase();
    return {
      index,
      name,
      mediaType: given.includes('/') ? given : typeOfName(name),
      size: typeof f.size === 'number' ? f.size : null,
      url: str(f.url) || null,
    };
  });
}

export function attachmentViews(data: unknown): AttachmentView[] {
  return attachmentFiles(data).map(({ url: _url, ...view }) => view);
}

export function typeOfName(name: string): string {
  return BY_EXTENSION[extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

/** Whether the browser may show it in the page rather than download it. */
export function isInline(mediaType: string): boolean {
  return INLINE.has(mediaType);
}

/** Where the copy lives. Built from the id and index only, never the file name. */
export function attachmentRel(kind: AttachmentKind, id: string, file: AttachmentFile): string {
  const ext = extname(file.name)
    .slice(1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8);
  return `attachments/${kind}/${encodeURIComponent(id).replace(/%/g, '_')}/${file.index}${ext ? `.${ext}` : ''}`;
}

/**
 * Saves the files of these items that are not saved yet. A failed file is
 * counted and tried again at the next sync, while Aula still lists it.
 */
export async function saveAttachments(
  files: ParentGallery,
  items: ItemInput[],
): Promise<{ saved: number; failed: number }> {
  let saved = 0;
  let failed = 0;
  // AULA_MCP_GALLERY=0 turns off every download, these too.
  if (!files.config.downloads) return { saved, failed };
  for (const item of items) {
    if (item.kind !== 'post' && item.kind !== 'message') continue;
    for (const file of attachmentFiles(item.data)) {
      if (!file.url) continue;
      const rel = attachmentRel(item.kind, item.id, file);
      try {
        if (await files.exists(rel)) continue;
        if (((await files.disk())?.used ?? 0) >= files.config.stopAt) {
          return { saved, failed };
        }
        await files.download(file.url, rel, () => true);
        saved++;
      } catch {
        failed++;
      }
    }
  }
  return { saved, failed };
}

/** The views of a stored item, each marked saved or not. */
export async function storedAttachments(
  store: ParentStorage,
  files: ParentGallery | null,
  kind: AttachmentKind,
  id: string,
): Promise<AttachmentView[]> {
  const item = await store.get(kind, id);
  if (!item) return [];
  return Promise.all(
    attachmentFiles(item.data).map(async ({ url: _url, ...view }) => ({
      ...view,
      saved: files ? await files.exists(attachmentRel(kind, id, view as AttachmentFile)) : false,
    })),
  );
}

/** One saved file, for the dashboard; null when there is no copy. */
export async function openAttachment(
  store: ParentStorage,
  files: ParentGallery,
  kind: AttachmentKind,
  id: string,
  index: number,
) {
  const item = await store.get(kind, id);
  const file = item ? attachmentFiles(item.data)[index] : undefined;
  if (!file) return null;
  const opened = await files.open(attachmentRel(kind, id, file));
  return opened ? { ...opened, name: file.name, mediaType: file.mediaType } : null;
}

/** Deletes the saved copies of a kind's items, or of both kinds. */
export async function removeAttachments(
  store: ParentStorage,
  files: ParentGallery,
  kind?: AttachmentKind,
): Promise<number> {
  let removed = 0;
  for (const k of kind ? [kind] : (['post', 'message'] as const)) {
    for (let offset = 0; ; offset += 500) {
      const page = await store.list({ kind: k, limit: 500, offset });
      for (const item of page) {
        for (const file of attachmentFiles(item.data)) {
          const rel = attachmentRel(k, item.id, file);
          if (await files.exists(rel)) {
            await files.remove(rel);
            removed++;
          }
        }
      }
      if (page.length < 500) break;
    }
  }
  return removed;
}
