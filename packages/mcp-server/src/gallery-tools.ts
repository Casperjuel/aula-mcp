/**
 * MCP tools for the downloaded gallery: what is stored, the albums, the media
 * in an album, a thumbnail as an image, and the photos and files saved from
 * posts and messages. They read the local copy only;
 * the `gallery` sync job (aula.sync.run) fetches from Aula. The read tools
 * take `owner` for what another parent shares (local-tools.ts).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GalleryView } from './gallery.ts';
import { NOT_SHARED, OWNER_TEXT, ownerArg, type SharedAccess } from './local-tools.ts';

export function registerGalleryTools(
  server: McpServer,
  own: GalleryView,
  shared?: SharedAccess,
): void {
  const owner = ownerArg(shared);
  const sharedNote = shared ? ` ${OWNER_TEXT}` : '';
  /** The caller's own gallery, or what `args.owner` shares with them. */
  const galleryFor = async (args: { owner?: string | undefined }): Promise<GalleryView | null> =>
    args.owner ? ((await shared?.open(args.owner))?.gallery ?? null) : own;
  const notShared = () => ({
    isError: true,
    content: [{ type: 'text' as const, text: NOT_SHARED }],
  });
  server.registerTool(
    'aula.gallery.status',
    {
      title: 'Gallery download status',
      description:
        "How far the download of the caller's own Aula photo albums has come: albums and " +
        'media known, how many are downloaded, waiting or failed, bytes stored (each file ' +
        'counted once, the same photo in two albums is stored once), a split per child, the ' +
        'disk use of the gallery volume and the level at which downloads pause (null when ' +
        'the files are in an S3 bucket, `store` "s3", which has no limit), where they are ' +
        '(`location`: a folder or s3://bucket/prefix), and the ' +
        'last run of the `gallery` sync job. Files are kept in original quality with a ' +
        'thumbnail, under <child>/<year>/<date album title>/. Albums shared with more than ' +
        'one child are filed under "Fælles". To download now, call aula.sync.run with ' +
        'jobs ["gallery"]; it fetches up to a few hundred files per run and runs again ' +
        'soon while more are waiting.',
      inputSchema: {},
    },
    async () => jsonContent(await own.status()),
  );

  server.registerTool(
    'aula.gallery.albums',
    {
      title: 'Gallery albums',
      description:
        "The caller's Aula photo albums from the local copy, newest first: id, title, " +
        'child folder, year and date, who made it, the groups it is shared with, media ' +
        'count, how many are downloaded and their size. Filter by `child` (the folder ' +
        'name, as aula.gallery.status lists it, or "Fælles") and `year`. Use the id with ' +
        'aula.gallery.media. Reads local storage only, so it shows what the last sync saw.' +
        sharedNote,
      inputSchema: {
        child: z.string().optional().describe('Child folder name, or "Fælles".'),
        year: z
          .string()
          .regex(/^\d{4}$/)
          .optional()
          .describe('Year the album was made, e.g. "2026".'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
        offset: z.number().int().min(0).optional().describe('Default 0.'),
        ...owner,
      },
    },
    async (args) => {
      const gallery = await galleryFor(args);
      if (!gallery) return notShared();
      const all = await gallery.albums({
        ...(args.child ? { child: args.child } : {}),
        ...(args.year ? { year: args.year } : {}),
      });
      const offset = args.offset ?? 0;
      const albums = all.slice(offset, offset + (args.limit ?? 50));
      return jsonContent({ total: all.length, offset, albums });
    },
  );

  server.registerTool(
    'aula.gallery.media',
    {
      title: 'Media in an album',
      description:
        'The photos and videos of one album from the local copy, oldest first: id, type ' +
        '(image or video), original file name, title, upload time, size, whether the ' +
        'original and the thumbnail are downloaded, the stored path relative to the ' +
        "parent's gallery folder, the names of people tagged, and the last download " +
        'error if any. Take `albumId` from aula.gallery.albums. Use aula.gallery.thumbnail ' +
        'to look at one.' +
        sharedNote,
      inputSchema: {
        albumId: z.number().int().describe('Album id from aula.gallery.albums.'),
        limit: z.number().int().min(1).max(500).optional().describe('Default 100.'),
        offset: z.number().int().min(0).optional().describe('Default 0.'),
        ...owner,
      },
    },
    async (args) => {
      const gallery = await galleryFor(args);
      if (!gallery) return notShared();
      const all = await gallery.media(args.albumId);
      const offset = args.offset ?? 0;
      const media = all.slice(offset, offset + (args.limit ?? 100));
      return jsonContent({ albumId: args.albumId, total: all.length, offset, media });
    },
  );

  server.registerTool(
    'aula.gallery.thumbnail',
    {
      title: 'Show a thumbnail',
      description:
        'Returns the stored thumbnail (about 170 KB, JPEG) of one photo or video as an ' +
        'image, so it can be looked at or described. Needs `albumId` and `mediaId` from ' +
        'aula.gallery.media; answers with an error when that thumbnail is not downloaded ' +
        'yet. Never returns the original file.' +
        sharedNote,
      inputSchema: {
        albumId: z.number().int().describe('Album id.'),
        mediaId: z.number().int().describe('Media id from aula.gallery.media.'),
        ...owner,
      },
    },
    async (args) => {
      const gallery = await galleryFor(args);
      if (!gallery) return notShared();
      const file = await gallery.file(args.albumId, args.mediaId, 'thumb');
      if (!file) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'That thumbnail is not downloaded.' }],
        };
      }
      const chunks: Buffer[] = [];
      for await (const chunk of file.stream) chunks.push(chunk as Buffer);
      return {
        content: [
          {
            type: 'image' as const,
            data: Buffer.concat(chunks).toString('base64'),
            mimeType: file.contentType,
          },
        ],
      };
    },
  );
  server.registerTool(
    'aula.gallery.post_albums',
    {
      title: 'Photos from posts',
      description:
        'Posts (opslag) with photos or videos attached, newest first, each shown as an ' +
        "album in the dashboard's gallery: post id, title, Danish date, author and the " +
        'saved files (index, name, type, size). The albums are made from the local copy ' +
        'and never in Aula. Filter by `year`. Look at one with aula.gallery.attachment ' +
        '(kind "post", the post id and the index); read the post itself with ' +
        'aula.local.get. Only files the posts sync saved while their links were fresh ' +
        'are listed.' +
        sharedNote,
      inputSchema: {
        year: z
          .string()
          .regex(/^\d{4}$/)
          .optional()
          .describe('Year of the post, e.g. "2026".'),
        ...owner,
      },
    },
    async (args) => {
      const gallery = await galleryFor(args);
      if (!gallery) return notShared();
      const posts = (await gallery.postAlbums()).filter(
        (p) => !args.year || p.date?.startsWith(args.year),
      );
      return jsonContent({ total: posts.length, posts });
    },
  );

  server.registerTool(
    'aula.gallery.attachment',
    {
      title: 'Open a kept attachment',
      description:
        'The bytes of one attachment of a stored post, message or message thread, from ' +
        'the local store only: never calls Aula. A photo (JPEG, PNG, GIF, WebP) comes ' +
        'back as image content; any other file (PDF, Word, video, text) as an embedded ' +
        'resource with the bytes base64 in `blob`. A second text part carries name, ' +
        `mediaType and bytes. Files over ${MAX_MB} MB answer with an error; open those in ` +
        'the dashboard. Take `kind` and `id` from aula.local.search, and `index` from ' +
        'the attachments aula.local.get lists (0 is the first): for kind ' +
        '"message_thread" the index counts across all messages of the thread, for ' +
        '"message" (id "<thread>:<message>") within that message. Only attachments ' +
        'aula.local.get marks `kept` can be opened; the posts and messages sync keep ' +
        'them while their Aula links are fresh. For a file that was never kept use ' +
        'aula.posts.get_attachment or aula.messages.get_attachment, which ask Aula.' +
        sharedNote,
      inputSchema: {
        kind: z
          .enum(['post', 'message', 'message_thread'])
          .describe('post, message or message_thread.'),
        id: z.string().min(1).describe('Id from aula.local.search.'),
        index: z
          .number()
          .int()
          .min(0)
          .max(9999)
          .describe('Attachment index from aula.local.get, 0 first.'),
        ...owner,
      },
    },
    async (args) => {
      const gallery = await galleryFor(args);
      if (!gallery) return notShared();
      const file = await gallery.attachment(args.kind, args.id, args.index);
      if (!file) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'No kept copy of that attachment.' }],
        };
      }
      const about = { name: file.name, mediaType: file.mediaType, bytes: file.bytes };
      if (file.bytes > MAX_BYTES) {
        file.stream.destroy();
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ...about, error: `larger than ${MAX_MB} MB` }),
            },
          ],
        };
      }
      const chunks: Buffer[] = [];
      for await (const chunk of file.stream) chunks.push(chunk as Buffer);
      const data = Buffer.concat(chunks).toString('base64');
      const image = /^image\/(jpeg|png|gif|webp)$/.test(file.mediaType);
      return {
        content: [
          image
            ? { type: 'image' as const, data, mimeType: file.mediaType }
            : {
                type: 'resource' as const,
                resource: {
                  uri: attachmentUri(args.kind, args.id, args.index, file.name),
                  mimeType: file.mediaType,
                  blob: data,
                },
              },
          { type: 'text' as const, text: JSON.stringify(about) },
        ],
      };
    },
  );
}

/** Largest attachment aula.gallery.attachment returns; base64 adds a third on top. */
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_MB = MAX_BYTES / 1024 / 1024;

/** Names the file in an embedded resource; nothing can be fetched from it. */
export function attachmentUri(kind: string, id: string, index: number, name: string): string {
  return `aula://attachments/${kind}/${encodeURIComponent(id)}/${index}/${encodeURIComponent(name)}`;
}

function jsonContent(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
