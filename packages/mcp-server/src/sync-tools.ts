/**
 * MCP tools for background sync: see where each sync job stands and run
 * jobs now. Registered only when local storage is on.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type ParentSync, SYNC_INTERVALS_MS, SYNC_JOB_DESCRIPTIONS, SYNC_JOBS } from './sync.ts';

const jobList = SYNC_JOBS.map(
  (job) =>
    `\`${job}\` (every ${formatInterval(SYNC_INTERVALS_MS[job])}): ${SYNC_JOB_DESCRIPTIONS[job]}`,
).join(' ');

export function registerSyncTools(server: McpServer, sync: ParentSync): void {
  server.registerTool(
    'aula.sync.status',
    {
      title: 'Sync status',
      description:
        "Where the background sync of the caller's own Aula data into the local database " +
        'stands, one entry per job: when it last ran and succeeded, when it runs next, ' +
        'whether the last run failed and why, and how many items it fetched and changed. ' +
        `Jobs: ${jobList} ` +
        'Sync only reads from Aula: it never marks anything read and never writes to Aula. ' +
        'Parents without an Aula login are skipped until they log in.',
      inputSchema: {},
    },
    async () => jsonContent({ jobs: await sync.status() }),
  );

  server.registerTool(
    'aula.sync.run',
    {
      title: 'Run sync now',
      description:
        "Fetch the caller's own Aula data into the local database right now instead of " +
        'waiting for the schedule, and return what each job fetched and changed. Waits ' +
        'for a sync that is already running. Takes from seconds to a minute or two ' +
        '(messages and the contact directory are the slow ones). Read-only towards Aula: ' +
        'nothing is marked read. Omit `jobs` to run all of them.',
      inputSchema: {
        jobs: z
          .array(z.enum(SYNC_JOBS))
          .min(1)
          .optional()
          .describe(`Which jobs to run: ${SYNC_JOBS.join(', ')}. Defaults to all.`),
      },
    },
    async (args) => jsonContent({ results: await sync.run(args.jobs) }),
  );
}

function formatInterval(ms: number): string {
  const minutes = ms / 60_000;
  return minutes < 60 ? `${minutes} min` : `${minutes / 60} h`;
}

function jsonContent(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
