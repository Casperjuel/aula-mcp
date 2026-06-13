/**
 * MCP tool registrations. Each tool delegates to AulaContext / AulaClient.
 * Inputs are validated by Zod 4 schemas registered with McpServer.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AulaStepUpRequiredError,
  isoDate,
  isoWeekString,
  isoWeekToMonday,
  PRESENCE_STATUS_CODE,
} from '@aula-mcp/aula-client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AulaContext } from './aula-context.ts';
import { resolveCalendarRange } from './calendar-range.ts';
import { buildDiscoverManifest } from './discover.ts';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');

function jsonContent(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** Monday..Sunday of the current ISO week as `YYYY-MM-DD` strings. */
function currentWeekRange(): { from: string; to: string } {
  const monday = isoWeekToMonday(isoWeekString());
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { from: isoDate(monday), to: isoDate(sunday) };
}

type ConsentEntry = {
  institutionProfile?: {
    id?: number;
    role?: string; // "guardian" | "child"
  };
};

/**
 * Every institution profile (guardian + child, across all institutions) for
 * the authenticated guardian, read from consents.getConsentResponses — the
 * only endpoint that surfaces the club child identity that profiles.list and
 * discover both omit. Returns a guardian id first so the posts call is
 * authorized. Only the logged-in user's own profiles appear here, so the
 * other parent can never leak in.
 */
async function resolveFamilyProfileIds(
  client: Awaited<ReturnType<AulaContext['getClient']>>,
): Promise<number[]> {
  // rawRequest unwraps the Aula envelope to `.data`, so this is the
  // consent-entry array directly. Guard against either shape regardless.
  const raw = (await client.rawRequest('consents.getConsentResponses', {
    returnOnlyPendingConsentResponses: 'false',
  })) as { data?: ConsentEntry[] } | ConsentEntry[] | null;

  const entries: ConsentEntry[] = Array.isArray(raw) ? raw : (raw?.data ?? []);

  const guardianIds: number[] = [];
  const childIds: number[] = [];
  for (const { institutionProfile: ip } of entries) {
    if (!ip?.id) continue;
    (ip.role === 'guardian' ? guardianIds : childIds).push(ip.id);
  }

  if (guardianIds.length === 0) {
    throw new Error(
      'resolveFamilyProfileIds: consents.getConsentResponses returned no guardian ' +
        'profile to authorize the request.',
    );
  }
  // Guardian(s) first, then children; dedupe.
  return [...new Set([...guardianIds, ...childIds])];
}

/** Strip Aula post HTML down to readable text (keeps line breaks). */
function htmlToText(html: string): string {
  return html
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Keep only what a reader (and the attachment-download tool) needs. */
function slimPost(post: any) {
  const attachments = (post.attachments ?? [])
    .map((a: any) => ({
      name: a.file?.name ?? a.name,
      url: a.file?.url ?? a.url, // get_attachment needs the exact URL
      ...(a.file?.mediaType ? { mediaType: a.file.mediaType } : {}),
    }))
    .filter((a: any) => a.url);

  return {
    id: post.id, // needed for aula.posts.get_attachment's postId
    title: post.title,
    date: post.publishAt ?? post.timestamp,
    author: post.ownerProfile?.fullName,
    // institutionName is the one bit of that block worth keeping —
    // it tells you school vs club at a glance.
    institution: post.ownerProfile?.institution?.institutionName,
    ...(post.isImportant ? { isImportant: true } : {}),
    content: htmlToText(post.content?.html ?? ''),
    ...(attachments.length ? { attachments } : {}),
  };
}

/** `YYYY-MM-DD`. */
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** 24-hour `HH:mm`. */
const HH_MM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** Komme/gå "henteform" values the write tool accepts. */
const SET_TEMPLATE_ACTIVITY_TYPES = [
  'picked_up_by',
  'self_decider',
  'send_home',
  'go_home_with',
] as const;

/**
 * Subset of aula.presence.set_template's args that has cross-field rules.
 * Optional fields spell out `| undefined` so the tool's Zod-inferred args
 * (which carry explicit `undefined` under `exactOptionalPropertyTypes`)
 * assign cleanly.
 */
export interface SetTemplateArgs {
  activityType: (typeof SET_TEMPLATE_ACTIVITY_TYPES)[number];
  pickedUpBy?: string | undefined;
  selfDeciderStartTime?: string | undefined;
  selfDeciderEndTime?: string | undefined;
  repeat?: 'never' | 'weekly' | 'every_2_weeks' | undefined;
  repeatUntil?: string | undefined;
}

/**
 * Cross-field checks for aula.presence.set_template — the rules a flat Zod
 * schema can't express (a field required only for certain activityTypes).
 * Returns human-readable problems; an empty array means the args cohere.
 */
export function validateSetTemplateArgs(args: SetTemplateArgs): string[] {
  const problems: string[] = [];
  if (
    (args.activityType === 'picked_up_by' || args.activityType === 'go_home_with') &&
    !args.pickedUpBy
  ) {
    problems.push(
      `activityType "${args.activityType}" requires pickedUpBy (who collects the child).`,
    );
  }
  if (
    args.activityType === 'self_decider' &&
    (!args.selfDeciderStartTime || !args.selfDeciderEndTime)
  ) {
    problems.push(
      'activityType "self_decider" requires selfDeciderStartTime and selfDeciderEndTime.',
    );
  }
  const repeat = args.repeat ?? 'never';
  if (repeat !== 'never' && !args.repeatUntil) {
    problems.push(`repeat "${repeat}" requires repeatUntil (the last date the repeat applies).`);
  }
  return problems;
}

export function registerTools(server: McpServer, context: AulaContext): void {
  // --- aula.discover -------------------------------------------------------

  server.registerTool(
    'aula.discover',
    {
      title: 'Discover Aula context',
      description:
        'Returns a typed manifest of the logged-in guardian: children (with names + ids), ' +
        'institutions, API version, detected widgets, and which subordinate aula.* tools to ' +
        'call. Includes a `usage` block with name-resolution and tool-selection rules. ' +
        'Call ONCE per session and reuse the result — do not re-call mid-session.',
      inputSchema: {},
    },
    async () => {
      const manifest = await buildDiscoverManifest(context);
      return jsonContent(manifest);
    },
  );

  // --- aula.profiles.list --------------------------------------------------

  server.registerTool(
    'aula.profiles.list',
    {
      title: 'List Aula profiles',
      description: 'Raw profiles.getProfilesByLogin response — every child + institution.',
      inputSchema: {},
    },
    async () => {
      const client = await context.getClient();
      return jsonContent(await client.getProfilesByLogin());
    },
  );

  // --- aula.presence.today -------------------------------------------------

  server.registerTool(
    'aula.presence.today',
    {
      title: 'Daily presence overview',
      description:
        'Returns presence/check-in/check-out info for the given child IDs. Status codes: ' +
        '0=IKKE_KOMMET (not arrived), 1=SYG (reported sick), 2=FERIE_FRI (holiday/not ' +
        'enrolled), 3=KOMMET (arrived/present), 4=PAA_TUR (on a trip), 5=SOVER (sleeping), ' +
        '6=FRITIDSAKTIVITET, 7=FYSISK_PLACERING, 8=GAAET (picked up/left).',
      inputSchema: {
        childIds: z
          .array(z.number().int().positive())
          .min(1)
          .describe('Aula child IDs (from aula.discover.children[].id)'),
      },
    },
    async (args) => {
      const client = await context.getClient();
      return jsonContent(await client.getDailyOverview(args.childIds));
    },
  );

  // --- aula.presence.templates ---------------------------------------------

  server.registerTool(
    'aula.presence.templates',
    {
      title: 'Komme/gå templates (drop-off & pickup schedule)',
      description:
        'Recurring komme/gå (presence) templates for the given children — the drop-off ' +
        'and pickup times a guardian has registered per day. Pass the same child IDs as ' +
        '`aula.presence.today`. `from`/`to` bound the window (YYYY-MM-DD); they default ' +
        'to the current week. Each returned template carries the `institutionProfile.id` ' +
        'that `aula.presence.set_template` needs. Read this before changing a schedule.',
      inputSchema: {
        childIds: z
          .array(z.number().int().positive())
          .min(1)
          .describe('Aula child IDs (from aula.discover.children[].id)'),
        from: ISO_DATE.optional().describe('Window start YYYY-MM-DD. Defaults to this Monday.'),
        to: ISO_DATE.optional().describe('Window end YYYY-MM-DD. Defaults to this Sunday.'),
      },
    },
    async (args) => {
      const window = args.from && args.to ? { from: args.from, to: args.to } : currentWeekRange();
      const client = await context.getClient();
      return jsonContent(
        await client.getPresenceTemplates({
          institutionProfileIds: args.childIds,
          fromDate: window.from,
          toDate: window.to,
        }),
      );
    },
  );

  // --- aula.presence.set_template (gated, write) ---------------------------
  //
  // The first and only tool that *writes* to Aula. Gated behind
  // AULA_MCP_WRITE=1 so a server stays read-only by default — rescheduling a
  // child's pickup is not something an agent should be able to do unasked.

  if (process.env.AULA_MCP_WRITE === '1') {
    server.registerTool(
      'aula.presence.set_template',
      {
        title: 'Set a komme/gå template (drop-off & pickup time)',
        description:
          "Register or overwrite a child's komme/gå template for one day. WRITES to " +
          'Aula — enabled when AULA_MCP_WRITE=1. Covers one child and one date per call; ' +
          'call once per day to fill a week. Read `aula.presence.templates` first to see ' +
          'the current schedule and confirm the child id. `activityType` picks how the ' +
          'child leaves: picked_up_by ("Hentes af", a named person collects), ' +
          'self_decider ("Selvbestemmer", may leave alone between two times), ' +
          'send_home ("Sendes hjem", leaves alone at exitTime), go_home_with ' +
          '("Går hjem med", leaves with a named person). Set `repeat` to make it recur ' +
          'on that weekday until `repeatUntil`.',
        inputSchema: {
          institutionProfileId: z
            .number()
            .int()
            .positive()
            .describe(
              'Child institution-profile id — the same id passed to aula.presence.today ' +
                'as childIds, and the institutionProfile.id from aula.presence.templates.',
            ),
          date: ISO_DATE.describe(
            'Day the template applies to (YYYY-MM-DD). With repeat set, this is the ' +
              'first occurrence and fixes the weekday.',
          ),
          activityType: z
            .enum(SET_TEMPLATE_ACTIVITY_TYPES)
            .describe('How the child leaves the institution.'),
          entryTime: HH_MM.optional().describe('Drop-off time, HH:mm.'),
          exitTime: HH_MM.optional().describe(
            'Pickup / go-home time, HH:mm. Used by picked_up_by, send_home, go_home_with.',
          ),
          pickedUpBy: z
            .string()
            .min(1)
            .optional()
            .describe(
              'Name of the person collecting the child. Required for ' +
                'picked_up_by and go_home_with.',
            ),
          selfDeciderStartTime: HH_MM.optional().describe(
            'Earliest the child may leave, HH:mm. Required for self_decider.',
          ),
          selfDeciderEndTime: HH_MM.optional().describe(
            'Latest the child may leave, HH:mm. Required for self_decider.',
          ),
          comment: z.string().optional().describe('Free-text note shown to staff.'),
          repeat: z
            .enum(['never', 'weekly', 'every_2_weeks'])
            .optional()
            .describe('Repeat cadence. Defaults to never (the single day only).'),
          repeatUntil: ISO_DATE.optional().describe(
            'Last date the repeat applies (YYYY-MM-DD). Required when repeat is ' +
              'weekly or every_2_weeks.',
          ),
        },
      },
      async (args) => {
        // Cross-field prerequisites Zod can't express — fail here with an
        // actionable message rather than letting Aula reject a half-built
        // template after the round-trip.
        const problems = validateSetTemplateArgs(args);
        if (problems.length > 0) {
          return jsonContent({ error: 'invalid_arguments', problems });
        }
        const repeat = args.repeat ?? 'never';

        const client = await context.getClient();
        const result = await client.updatePresenceTemplate({
          institutionProfileId: args.institutionProfileId,
          date: args.date,
          activityType: args.activityType,
          repeatPattern: repeat,
          ...(args.entryTime ? { entryTime: args.entryTime } : {}),
          ...(args.exitTime ? { exitTime: args.exitTime } : {}),
          ...(args.pickedUpBy ? { pickedUpBy: args.pickedUpBy } : {}),
          ...(args.selfDeciderStartTime ? { selfDeciderStartTime: args.selfDeciderStartTime } : {}),
          ...(args.selfDeciderEndTime ? { selfDeciderEndTime: args.selfDeciderEndTime } : {}),
          ...(args.comment !== undefined ? { comment: args.comment } : {}),
          ...(args.repeatUntil ? { repeatUntil: args.repeatUntil } : {}),
        });
        return jsonContent({ ok: true, result });
      },
    );

    // --- aula.presence.report_sick (gated, write) --------------------------
    //
    // Same gate, and for the same reason: telling a daycare a child is ill is
    // not something an agent should be able to do unasked.
    //
    // One tool for both directions, because Aula has one endpoint for both:
    // reporting sick and taking it back are the same call with a different
    // status.

    server.registerTool(
      'aula.presence.report_sick',
      {
        title: 'Report a child sick (or well again)',
        description:
          'Mark a child as sick for today, or take the report back. WRITES to Aula — ' +
          'enabled when AULA_MCP_WRITE=1. The institution is notified. Applies to today; ' +
          'Aula has no future-dated sick report — use aula.presence.set_template or a ' +
          'vacation registration for a planned absence. An institution can withhold this ' +
          'from guardians, in which case Aula rejects the call.',
        inputSchema: {
          institutionProfileIds: z
            .array(z.number().int().positive())
            .min(1)
            .describe(
              'Child institution-profile ids — the same ids passed to aula.presence.today ' +
                'as childIds, i.e. aula.discover children[].id. Must belong to the ' +
                'logged-in guardian; anything else is rejected. Confirm the child with ' +
                'the user before calling.',
            ),
          sick: z
            .boolean()
            .describe(
              'true reports the child sick. false takes the report back, which sets the ' +
                'child to "ikke kommet" (not arrived) — so it is rejected unless Aula ' +
                'currently reports that child as sick.',
            ),
        },
      },
      async (args) => {
        const client = await context.getClient();

        // Scope the write to this login's own children.
        //
        // Aula happily accepts any institution-profile id the caller has rights
        // to, and the schema takes an array, so a single hallucinated number is
        // enough to tell the wrong institution that someone else's child is
        // ill. Resolve the guardian's actual children first and refuse anything
        // that isn't one of them — a local error beats a phone call from a
        // daycare.
        const profilesData = await client.getProfilesByLogin();
        const ownChildren = new Map<number, string>();
        for (const profile of profilesData.profiles ?? []) {
          for (const child of profile.children ?? []) {
            ownChildren.set(child.id, child.name);
          }
        }
        const unknownIds = args.institutionProfileIds.filter((id) => !ownChildren.has(id));
        if (unknownIds.length > 0) {
          return jsonContent({
            error: 'unknown_child',
            message:
              'Refusing to write: these institution-profile ids are not children of the ' +
              'logged-in guardian. Call aula.discover and use children[].id.',
            unknownIds,
            knownChildren: [...ownChildren].map(([id, name]) => ({ id, name })),
          });
        }

        // Un-reporting is not a free action.
        //
        // Aula's own UI only offers "take the sick report back" from a sick
        // state, so status 0 is safe there. Here nothing constrains it: calling
        // sick:false on a child who is currently checked in would silently flip
        // them to "ikke kommet" and still report ok. Only allow it for a child
        // Aula currently reports as sick.
        if (!args.sick) {
          const overview = await client.getDailyOverview(args.institutionProfileIds);
          const statusById = new Map<number, number>();
          for (const entry of overview) {
            const id = entry.institutionProfile?.id;
            if (id !== undefined) statusById.set(id, entry.status);
          }
          const notSick = args.institutionProfileIds.filter(
            (id) => statusById.get(id) !== PRESENCE_STATUS_CODE.SICK,
          );
          if (notSick.length > 0) {
            return jsonContent({
              error: 'not_reported_sick',
              message:
                'Refusing to write: taking a sick report back sets the child to ' +
                '"ikke kommet" (0), so it is only safe for a child Aula currently reports ' +
                'as sick. These are not. Use aula.presence.today to see the current status.',
              children: notSick.map((id) => ({
                id,
                name: ownChildren.get(id),
                currentStatus: statusById.get(id) ?? null,
              })),
            });
          }
        }

        const result = await client.updatePresenceStatus({
          institutionProfileIds: args.institutionProfileIds,
          status: args.sick ? PRESENCE_STATUS_CODE.SICK : PRESENCE_STATUS_CODE.NOT_PRESENT,
        });
        return jsonContent({ ok: true, result });
      },
    );

    // --- aula.messages.mark_read (gated, write) ----------------------------
    //
    // Lives here rather than next to the other aula.messages.* tools so every
    // write stays behind the one AULA_MCP_WRITE gate. Aula has no "mark as
    // read" verb; see AulaClient.setLastReadMessage for what actually happens.

    server.registerTool(
      'aula.messages.mark_read',
      {
        title: 'Mark a message thread as read',
        description:
          'Move the read marker in a thread to its newest message, clearing the unread ' +
          'badge. WRITES to Aula — enabled when AULA_MCP_WRITE=1. Pass `messageId` from ' +
          '`aula.messages.list_threads` (thread.latestMessage.id); omit it to mark the ' +
          'thread read up to whatever its newest message is right now. Marking read is ' +
          'not reversible through this API — Aula offers no way to set a thread back to ' +
          'unread, so only call this for threads the user has actually seen.',
        inputSchema: {
          threadId: z
            .number()
            .int()
            .positive()
            .describe('Thread id from aula.messages.list_threads.'),
          messageId: z
            .string()
            .min(1)
            .optional()
            .describe(
              'Aula\'s opaque message id (e.g. "6a3d2467304484.24549709"), NOT a number. ' +
                "Defaults to the thread's newest message.",
            ),
        },
      },
      async (args) => {
        const client = await context.getClient();
        // Messaging endpoints 403 until the guardian profile is activated
        // server-side — same priming as aula.messages.get_thread.
        await context.getGuardianUserId();

        let messageId = args.messageId;
        if (!messageId) {
          // Aula pages threads 20 at a time and ignores pageSize, so a single
          // getThreads call only ever sees the newest 20 — walk pages until the
          // thread turns up. Bounded: a caller that already has the thread in
          // hand should pass messageId rather than make us search for it.
          const MAX_PAGES = 10;
          let latest: string | undefined;
          let pagesRead = 0;
          for (let page = 0; page < MAX_PAGES; page++) {
            const { threads, hasMorePages } = await client.getThreadsPage({ page });
            pagesRead = page + 1;
            const found = threads.find((t) => t.id === args.threadId);
            if (found?.latestMessage?.id != null) {
              latest = String(found.latestMessage.id);
              break;
            }
            if (!hasMorePages) break;
          }
          if (latest === undefined) {
            return jsonContent({
              error: 'message_id_unresolved',
              message:
                `Thread ${args.threadId} was not found in the first ${pagesRead} pages ` +
                `(~${pagesRead * 20} threads), or carries no latestMessage.id. Pass ` +
                'messageId explicitly — aula.messages.list_threads returns it as ' +
                'thread.latestMessage.id.',
            });
          }
          messageId = latest;
        }

        const result = await client.setLastReadMessage(args.threadId, messageId);
        return jsonContent({ ok: true, threadId: args.threadId, messageId, result });
      },
    );
  }

  // --- aula.calendar.events ------------------------------------------------

  server.registerTool(
    'aula.calendar.events',
    {
      title: 'Calendar events (school schedule)',
      description:
        'Lessons + events for the given child institution-profile IDs. ' +
        'Call aula.discover first and pass children[].id as profileIds. ' +
        'Pass `range` for a preset window (today/tomorrow/this_week/next_week) ' +
        'OR `start`+`end` for a specific window. Timestamps are formatted as Aula ' +
        'expects: "YYYY-MM-DD HH:MM:SS.0000+ZZZZ". Aula uses Europe/Copenhagen.',
      inputSchema: {
        profileIds: z
          .array(z.number().int().positive())
          .min(1)
          .describe(
            'Child institution-profile IDs from aula.discover children[].id. ' +
              'Do not use children[].userId.',
          ),
        range: z.enum(['today', 'tomorrow', 'this_week', 'next_week']).optional(),
        start: z.string().min(1).optional(),
        end: z.string().min(1).optional(),
        resourceIds: z.array(z.number().int().positive()).optional(),
      },
    },
    async (args) => {
      let start: string;
      let end: string;
      if (args.start && args.end) {
        start = args.start;
        end = args.end;
      } else {
        const window = resolveCalendarRange(args.range ?? 'this_week');
        start = window.start;
        end = window.end;
      }
      const client = await context.getClient();
      const events = await client.getCalendarEvents({
        profileIds: args.profileIds,
        start,
        end,
        ...(args.resourceIds ? { resourceIds: args.resourceIds } : {}),
      });
      return jsonContent(events);
    },
  );

  // --- aula.notifications.list ---------------------------------------------

  server.registerTool(
    'aula.notifications.list',
    {
      title: 'Aula notifications',
      description: 'Unread items + activity for the active guardian profile.',
      inputSchema: {},
    },
    async () => {
      const client = await context.getClient();
      // See aula.messages.get_thread below — guardian profile must be
      // primed or Aula's `*ForActiveProfile` endpoints 403.
      await context.getGuardianUserId();
      return jsonContent(await client.getNotifications());
    },
  );

// --- aula.posts.list -----------------------------------------------------


// ---- Tool ----
server.registerTool(
  'aula.posts.list',
  {
    title: 'Aula posts (class news feed)',
    description: 'Teacher posts and class-level updates.',
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional(),
      index: z.number().int().min(0).optional(),
      profileIds: z.array(z.number()).min(1).optional().describe(
        "Optional. Omit to include the whole family across all institutions " +
        "(school + club) automatically — recommended, and the only way to " +
        "guarantee club posts appear. Only set this to deliberately restrict " +
        "the feed to specific institution profiles.",
      ),
      onlyUnread: z.boolean().optional().describe(
        "Set to true if you ONLY want to see unread posts. Defaults to false (shows all historical posts).",
      ),
    },
  },
  async (args) => {
  const client = await context.getClient();
  await context.getGuardianUserId();

  const profileIds = args.profileIds ?? await resolveFamilyProfileIds(client);

  const result: any = await client.getPosts({
    limit: args.limit,
    index: args.index ?? 0,
    parent: 'profile',
    isUnread: args.onlyUnread === true ? 'true' : 'false',
    profileIds,
  });

    const rawPosts: any[] = Array.isArray(result)
      ? result
      : (result?.posts ?? result?.data?.posts ?? []);

    return jsonContent({
      count: rawPosts.length,
      ...(typeof result?.moreMessagesExist === 'boolean'
        ? { moreMessagesExist: result.moreMessagesExist }
        : {}),
      posts: rawPosts.map(slimPost),
    });
  },
);

  // --- aula.raw_request (gated) --------------------------------------------

  if (process.env.AULA_MCP_RAW === '1') {
    server.registerTool(
      'aula.raw_request',
      {
        title: 'Raw Aula API call (escape hatch)',
        description:
          'Call any Aula API method directly. Enabled when AULA_MCP_RAW=1. The CSRF token + ' +
          'access_token are added automatically; the response envelope is unwrapped to its ' +
          '`data` field. Use sparingly — most needs have a typed tool.',
        inputSchema: {
          method: z.string().min(1).describe('e.g. "profiles.getProfileContext"'),
          query: z.record(z.string(), z.string()).optional(),
          body: z.unknown().optional(),
        },
      },
      async (args) => {
        const client = await context.getClient();
        return jsonContent(await client.rawRequest(args.method, args.query ?? {}, args.body));
      },
    );
  }

  // --- aula.messages.list_threads ------------------------------------------

  server.registerTool(
    'aula.messages.list_threads',
    {
      title: 'List Aula message threads',
      description:
        'One page of threads, most recent first. Aula serves 20 per page and IGNORES ' +
        '`pageSize` — asking for 50 still returns 20. Returns `{ threads, page, ' +
        'hasMorePages }`: when `hasMorePages` is true there are older threads you have ' +
        'not seen, so keep calling with `page` + 1 before concluding anything about the ' +
        'mailbox as a whole (e.g. "no unread messages"). A single call answers "what ' +
        'arrived recently", never "what does the mailbox contain".',
      inputSchema: {
        page: z.number().int().min(0).default(0).optional(),
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Sent through to Aula, which ignores it. Kept in case that changes.'),
      },
    },
    async (args) => {
      const client = await context.getClient();
      // See aula.messages.get_thread below — messaging endpoints 403
      // until the guardian profile is activated server-side.
      await context.getGuardianUserId();
      const page = await client.getThreadsPage({
        ...(args.page !== undefined ? { page: args.page } : {}),
        ...(args.pageSize !== undefined ? { pageSize: args.pageSize } : {}),
      });
      return jsonContent(page);
    },
  );

  // --- aula.ugeplan.* ------------------------------------------------------
  //
  // Each provider has its own tool. The agent picks the right one based on
  // the institution-to-provider mapping (currently: try whichever the
  // school uses; long term, plumb this into discover).

  const integrationContextShape = {
    childIds: z.array(z.number().int().positive()).min(1),
    institutionCodes: z.array(z.string().min(1)).min(1),
    isoWeek: z
      .string()
      .regex(/^\d{4}-W\d{2}$/)
      .optional()
      .describe('ISO week, e.g. "2026-W18". Defaults to the current week.'),
  } as const;

  async function buildIntegrationCtx(args: {
    childIds: number[];
    institutionCodes: string[];
    isoWeek?: string | undefined;
  }) {
    const client = await context.getClient();
    const record = context.record;
    if (!record) throw new Error('AulaContext: no token record loaded');
    // EasyIQ / MU / Meebook want the numeric guardian user-id (from
    // getProfileContext). Systematic uses the literal MitID username for its
    // sessionId — that's the only integration where `sessionId` and the
    // numeric id differ. SystematicClient currently reads `ctx.sessionId`
    // (= username), so we keep that field as the username and put the
    // numeric id under `guardianId` for the other plugins.
    const guardianUserId = await context.getGuardianUserId();

    // SkolePortal's `x-childfilter` header takes the opaque per-child userId
    // (alphanumeric token), not the numeric child profile id. Look it up
    // from the profiles list, aligned with childIds by index. Missing → "".
    const profilesData = await client.getProfilesByLogin();
    const userIdByChildId = new Map<number, string>();
    for (const profile of profilesData.profiles ?? []) {
      for (const child of profile.children ?? []) {
        if (child.userId != null) {
          userIdByChildId.set(child.id, String(child.userId));
        }
      }
    }
    const childUserIds = args.childIds.map((id) => userIdByChildId.get(id) ?? '');

    return {
      isoWeek: args.isoWeek ?? isoWeekString(),
      sessionId: record.username,
      guardianId: guardianUserId,
      childIds: args.childIds,
      childUserIds,
      institutionCodes: args.institutionCodes,
    };
  }

  server.registerTool(
    'aula.ugeplan.easyiq',
    {
      title: 'EasyIQ weekly plan',
      description:
        'Weekly plan from EasyIQ for the given children. Use when the school is on EasyIQ.',
      inputSchema: integrationContextShape,
    },
    async (args) => {
      const easyiq = await context.getEasyIq();
      return jsonContent(await easyiq.getWeekPlan(await buildIntegrationCtx(args)));
    },
  );

  server.registerTool(
    'aula.ugeplan.meebook',
    {
      title: 'Meebook weekly plan',
      description:
        'Weekly plan from Meebook for the given children. Use when the school is on Meebook.',
      inputSchema: integrationContextShape,
    },
    async (args) => {
      const meebook = await context.getMeebook();
      return jsonContent(await meebook.getWeekPlan(await buildIntegrationCtx(args)));
    },
  );

  server.registerTool(
    'aula.ugeplan.easyiq_skoleportal',
    {
      title: 'EasyIQ SkolePortal weekly plan',
      description:
        'Weekly plan from EasyIQ SkolePortal (widget 0128) — a different EasyIQ product than ' +
        '`aula.ugeplan.easyiq` (widget 0001). Use when discover.detectedWidgets contains "0128".',
      inputSchema: integrationContextShape,
    },
    async (args) => {
      const sp = await context.getEasyIqSkoleportal();
      return jsonContent(await sp.getWeekPlan(await buildIntegrationCtx(args)));
    },
  );

  server.registerTool(
    'aula.lektier.easyiq',
    {
      title: 'EasyIQ Lektier (homework)',
      description:
        'Homework items from EasyIQ Lektier (widget 0142) — same vendor as ' +
        '`aula.ugeplan.easyiq_skoleportal` but a separate "Lektier" product. ' +
        'Use when discover.detectedWidgets contains "0142".',
      inputSchema: integrationContextShape,
    },
    async (args) => {
      const lektier = await context.getEasyIqLektier();
      return jsonContent(await lektier.getLektier(await buildIntegrationCtx(args)));
    },
  );

  server.registerTool(
    'aula.opgaver.minuddannelse',
    {
      title: 'Min Uddannelse opgaveliste',
      description: 'Homework / task list from Min Uddannelse for the given children.',
      inputSchema: integrationContextShape,
    },
    async (args) => {
      const mu = await context.getMinUddannelse();
      return jsonContent(await mu.getOpgaver(await buildIntegrationCtx(args)));
    },
  );

  server.registerTool(
    'aula.ugebrev.minuddannelse',
    {
      title: 'Min Uddannelse ugebrev',
      description: 'Weekly newsletter (ugebrev) from Min Uddannelse.',
      inputSchema: integrationContextShape,
    },
    async (args) => {
      const mu = await context.getMinUddannelse();
      return jsonContent(await mu.getUgebrev(await buildIntegrationCtx(args)));
    },
  );

  server.registerTool(
    'aula.huskelisten.systematic',
    {
      title: 'Systematic Huskelisten reminders',
      description:
        'Homework reminders from Systematic. Args may include `from`/`to` ISO YYYY-MM-DD dates.',
      inputSchema: {
        ...integrationContextShape,
        fromDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        toDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      },
    },
    async (args) => {
      const sys = await context.getSystematic();
      const baseCtx = await buildIntegrationCtx(args);
      return jsonContent(
        await sys.getReminders({
          ...baseCtx,
          ...(args.fromDate ? { fromDate: args.fromDate } : {}),
          ...(args.toDate ? { toDate: args.toDate } : {}),
        }),
      );
    },
  );

  // --- aula.messages.get_thread --------------------------------------------

  server.registerTool(
    'aula.messages.get_thread',
    {
      title: 'Read a single thread',
      description:
        'Returns subject + every message in the thread. If the thread is sensitive, ' +
        'this tool returns an error code that means the user must MitID step-up to read it ' +
        '(currently a fresh `aula login` from the CLI).',
      inputSchema: {
        threadId: z.number().int().positive(),
        page: z.number().int().min(0).default(0).optional(),
      },
    },
    async (args) => {
      const client = await context.getClient();
      // Prime the guardian profile before fetching. Aula's
      // messaging.getMessagesForThread returns HTTP 403 if the
      // guardian profile hasn't been activated on the server side
      // this session, even with a fully step-up'd bearer. aula.discover
      // implicitly primes via getGuardianUserId() — but if the agent
      // calls get_thread directly (cached threadId from a prior turn,
      // skipping discover), no priming has happened. getGuardianUserId
      // memoises after the first call, so this is a no-op once primed.
      await context.getGuardianUserId();
      try {
        return jsonContent(
          await client.getMessagesForThread(args.threadId, {
            ...(args.page !== undefined ? { page: args.page } : {}),
          }),
        );
      } catch (e) {
        if (e instanceof AulaStepUpRequiredError) {
          return jsonContent({
            error: 'step_up_required',
            message: e.message,
            hint: 'Run `aula login` again to refresh your session, then retry.',
          });
        }
        throw e;
      }
    },
  );

  // --- aula.messages.get_attachment ----------------------------------------
  //
  // Download a message attachment server-side and return a local file path.
  // Necessary because Aula attachment URLs are CloudFront presigned links
  // with long opaque signatures; LLMs frequently corrupt them when echoing
  // the URL into other tool calls (the typical symptom is a chain of
  // MalformedSignature / AccessDenied 403s from S3 even though the URL is
  // still within its 1h validity window). Returning a local path keeps the
  // URL out of the model's emit path entirely.

  server.registerTool(
    'aula.messages.get_attachment',
    {
      title: 'Download a thread attachment to local disk',
      description:
        'Download an attachment from a thread message and write it to a ' +
        'local temporary file, returning the file path. Prefer this over ' +
        'passing Aula attachment URLs through the model — CloudFront ' +
        'presigned URLs are long opaque blobs that LLMs often mangle when ' +
        'echoing into tool calls (MalformedSignature / AccessDenied 403). ' +
        '`attachmentIndex` is zero-based across all attachments in the ' +
        'thread, flattened message-by-message in the order returned by ' +
        '`aula.messages.get_thread`.',
      inputSchema: {
        threadId: z.number().int().positive(),
        attachmentIndex: z.number().int().min(0),
      },
    },
    async (args) => {
      const client = await context.getClient();
      await context.getGuardianUserId();
      // Re-fetch the thread to get a fresh URL; presigned URLs age out
      // within ~1h and we never want to download against a cached one.
      const { messages } = await client.getMessagesForThread(args.threadId);
      const flat = messages.flatMap((m) => m.attachments ?? []);
      const att = flat[args.attachmentIndex];
      if (!att?.file?.url) {
        return jsonContent({
          error: 'attachment_not_found',
          threadId: args.threadId,
          attachmentIndex: args.attachmentIndex,
          totalAttachments: flat.length,
        });
      }
      const url = att.file.url;
      const filename = att.file.name ?? `attachment-${args.attachmentIndex}.bin`;
      // CloudFront presigned URLs don't want Aula cookies / Auth headers
      // — the signature IS the auth, and extra headers can interfere.
      // Use plain fetch (not AulaHttpClient, which adds defaults).
      const res = await fetch(url);
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        return jsonContent({
          error: 'download_failed',
          httpStatus: res.status,
          filename,
          body,
        });
      }
      const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > ATTACHMENT_MAX_BYTES) {
        return jsonContent({
          error: 'attachment_too_large',
          filename,
          bytes: declared,
          maxBytes: ATTACHMENT_MAX_BYTES,
        });
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > ATTACHMENT_MAX_BYTES) {
        return jsonContent({
          error: 'attachment_too_large',
          filename,
          bytes: buf.byteLength,
          maxBytes: ATTACHMENT_MAX_BYTES,
        });
      }
      const baseDir = process.env.AULA_MCP_ATTACHMENTS_DIR ?? join(tmpdir(), 'aula-attachments');
      await mkdir(baseDir, { recursive: true });
      const safeName = filename.replace(/[^\w.\- ]+/gu, '_');
      const path = join(baseDir, `${args.threadId}-${args.attachmentIndex}-${safeName}`);
      await writeFile(path, buf, { mode: 0o600 });
      return jsonContent({
        ok: true,
        path,
        filename,
        bytes: buf.length,
        ...(att.file.mediaType ? { mediaType: att.file.mediaType } : {}),
      });
    },
  );

  // --- aula.posts.get_attachment ----------------------------------------
  //
  // Download an attachment from a news feed post using its raw URL.

  server.registerTool(
    'aula.posts.get_attachment',
    {
      title: 'Download a post attachment to local disk',
      description:
        'Download an attachment from a news feed post and write it to a local temporary file. ' +
        'Extract the exact `url` and `name` from the post\'s attachments array and pass them here. ' +
        'CRITICAL: You must pass the URL exactly as it appears in the JSON without altering any characters.',
      inputSchema: {
        postId: z.number().int().describe("The ID of the post (used for safely naming the file)"),
        url: z.string().url().describe("The exact CloudFront presigned URL of the attachment from the posts feed"),
        filename: z.string().describe("The name of the file (e.g., 'Kostplan_juni_2026.pdf')"),
      },
    },
    async (args) => {
      // CloudFront presigned URLs don't want Aula cookies or Auth headers.
      // The signature in the URL IS the auth. We use plain fetch here.
      const res = await fetch(args.url);
      
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        return jsonContent({
          error: 'download_failed',
          httpStatus: res.status,
          filename: args.filename,
          body,
        });
      }

      const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB limit
      const declared = Number(res.headers.get('content-length') ?? '0');
      
      if (declared > ATTACHMENT_MAX_BYTES) {
        return jsonContent({
          error: 'attachment_too_large',
          filename: args.filename,
          bytes: declared,
          maxBytes: ATTACHMENT_MAX_BYTES,
        });
      }

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > ATTACHMENT_MAX_BYTES) {
        return jsonContent({
          error: 'attachment_too_large',
          filename: args.filename,
          bytes: buf.byteLength,
          maxBytes: ATTACHMENT_MAX_BYTES,
        });
      }

      // Use the exact same safe temporary directory as the messages tool
      const baseDir = process.env.AULA_MCP_ATTACHMENTS_DIR ?? join(tmpdir(), 'aula-attachments');
      await mkdir(baseDir, { recursive: true });
      
      // Sanitize the filename so it doesn't break Windows/Mac file systems
      const safeName = args.filename.replace(/[^\w.\- ]+/gu, '_');
      const path = join(baseDir, `post-${args.postId}-${safeName}`);
      
      await writeFile(path, buf, { mode: 0o600 });
      
      return jsonContent({
        ok: true,
        path,
        filename: args.filename,
        bytes: buf.length,
      });
    },
  );




// ... scroll down to the bottom of the file ...

  // --- aula.utils.extract_pdf_text ----------------------------------------
  //
  // Reads a locally downloaded PDF file and returns its plain text content.

  server.registerTool(
    'aula.utils.extract_pdf_text',
    {
      title: 'Extract text from a local PDF file',
      description:
        'Read a PDF file from a local absolute path (like those returned by attachment download tools) ' +
        'and extract its text content so you can read, summarize, or analyze it.',
      inputSchema: {
        path: z.string().describe('The absolute local file path to the PDF file on disk'),
      },
    },
    async (args) => {
    let parser: { getText(): Promise<{ text: string; total: number; info: unknown }>; destroy?(): Promise<void> } | null = null;
    try {
      const dataBuffer = await readFile(args.path);

      // v2 API: instantiate the class, then call getText()
      parser = new PDFParse({ data: dataBuffer });
      const result = await parser.getText();

      return jsonContent({
        ok: true,
        text: result.text,
        pages: result.total,   // see note below
        info: result.info,
      });
    } catch (error: any) {
      return jsonContent({
        ok: false,
        error: 'failed_to_read_pdf',
        message: error.message ?? String(error),
      });
    } finally {
      // v2 holds pdf.js resources; release them
      if (parser?.destroy) await parser.destroy();
    }
  },
  );
}
