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
} from '@aula-mcp/aula-client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AulaContext } from './aula-context.ts';
import { resolveCalendarRange } from './calendar-range.ts';
import { buildDiscoverManifest } from './discover.ts';

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
        '0=IKKE_KOMMET, 1=KOMMET, 2=PAA_TUR, 3=SOVER, 4=HENTET, 5=FRI, 6=FERIE, 7=SYG, ' +
        '8=KOMMET_SELV.',
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
  }

  // --- aula.calendar.events ------------------------------------------------

  server.registerTool(
    'aula.calendar.events',
    {
      title: 'Calendar events (school schedule)',
      description:
        'Lessons + events for the given institution-profile IDs. ' +
        'Pass `range` for a preset window (today/tomorrow/this_week/next_week) ' +
        'OR `start`+`end` for a specific window. Timestamps are formatted as Aula ' +
        'expects: "YYYY-MM-DD HH:MM:SS.0000+ZZZZ". Aula uses Europe/Copenhagen.',
      inputSchema: {
        profileIds: z.array(z.number().int().positive()).min(1),
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

  server.registerTool(
    'aula.posts.list',
    {
      title: 'Aula posts (class news feed)',
      description: 'Teacher posts and class-level updates.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional(),
        index: z.number().int().min(0).optional(),
      },
    },
    async (args) => {
      const client = await context.getClient();
      // See aula.messages.get_thread below — profile-scoped feed needs
      // the guardian profile activated, or Aula 403s.
      await context.getGuardianUserId();
      return jsonContent(
        await client.getPosts({
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.index !== undefined ? { index: args.index } : {}),
        }),
      );
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
      description: 'Most recent first. Use `page` for pagination (0-indexed).',
      inputSchema: {
        page: z.number().int().min(0).default(0).optional(),
        pageSize: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) => {
      const client = await context.getClient();
      // See aula.messages.get_thread below — messaging endpoints 403
      // until the guardian profile is activated server-side.
      await context.getGuardianUserId();
      const threads = await client.getThreads({
        ...(args.page !== undefined ? { page: args.page } : {}),
        ...(args.pageSize !== undefined ? { pageSize: args.pageSize } : {}),
      });
      return jsonContent(threads);
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
}
