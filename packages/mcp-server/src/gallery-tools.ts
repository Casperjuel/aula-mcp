/**
 * MCP tools for the downloaded gallery: what is stored, the albums, the media
 * in an album, and a thumbnail as an image. They read the local copy only;
 * the `gallery` sync job (aula.sync.run) fetches from Aula.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GalleryView } from './gallery.ts';

export function registerGalleryTools(server: McpServer, gallery: GalleryView): void {
  server.registerTool(
    'aula.gallery.status',
    {
      title: 'Gallery download status',
      description:
        "How far the download of the caller's own Aula photo albums has come: albums and " +
        'media known, how many are downloaded, waiting or failed, bytes stored (each file ' +
        'counted once, the same photo in two albums is stored once), a split per child, the ' +
        'disk use of the gallery volume and the level at which downloads pause, and the ' +
        'last run of the `gallery` sync job. Files are kept in original quality with a ' +
        'thumbnail, under <child>/<year>/<date album title>/. Albums shared with more than ' +
        'one child are filed under "Fælles". To download now, call aula.sync.run with ' +
        'jobs ["gallery"]; it fetches up to a few hundred files per run and runs again ' +
        'soon while more are waiting.',
      inputSchema: {},
    },
    async () => jsonContent(await gallery.status()),
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
        'aula.gallery.media. Reads local storage only, so it shows what the last sync saw.',
      inputSchema: {
        child: z.string().optional().describe('Child folder name, or "Fælles".'),
        year: z
          .string()
          .regex(/^\d{4}$/)
          .optional()
          .describe('Year the album was made, e.g. "2026".'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
        offset: z.number().int().min(0).optional().describe('Default 0.'),
      },
    },
    async (args) => {
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
        'to look at one.',
      inputSchema: {
        albumId: z.number().int().describe('Album id from aula.gallery.albums.'),
        limit: z.number().int().min(1).max(500).optional().describe('Default 100.'),
        offset: z.number().int().min(0).optional().describe('Default 0.'),
      },
    },
    async (args) => {
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
        'yet. Never returns the original file.',
      inputSchema: {
        albumId: z.number().int().describe('Album id.'),
        mediaId: z.number().int().describe('Media id from aula.gallery.media.'),
      },
    },
    async (args) => {
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
}

function jsonContent(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
