/**
 * `aula ugeplan fetch` — fetch EasyIQ SkolePortal weekly plans for the
 * given children and ISO weeks, and print them as deterministic JSON.
 *
 * Cheap pre-check for the week-plan poller: diff the normalised items
 * against a state file and only fire LLM classification when the plan
 * content actually changed — no SHA, no online hashing service, no LLM
 * bill. (The previous in-gateway cron asked the model to hash the plan
 * itself; lacking an exec tool it reached for md5calc.com / hashify /
 * httpbin, all of which the egress chokepoint held + dropped.)
 *
 * Same CLI-not-/tools/invoke rationale as `threads list-ids` /
 * `notifications list-ids` (see threads.ts / notifications.ts):
 * openclaw's `/tools/invoke` HTTP surface can't reach MCP-plugin tools,
 * so a shell poller can't call `aula.ugeplan.easyiq_skoleportal` from
 * outside the LLM path. This command replicates that tool's context
 * assembly (guardian id, per-child opaque userIds via getProfilesByLogin,
 * a WidgetTokenManager) and calls the same EasyIqSkoleportalClient.
 *
 * Output is normalised + sorted for stable diffing; the non-deterministic
 * and sensitive `raw` payload (SkolePortal auth loginIds etc.) is dropped.
 * Per-child soft failures surface under each week's `warnings` so the
 * poller can treat a degraded read as "fall through to the LLM"
 * (fail-open) rather than a clean no-change.
 *
 * Scope: easyiq_skoleportal only — that's the provider the household's
 * schools use (the cron called `aula.ugeplan.easyiq_skoleportal`). Add
 * sibling subcommands if another provider is ever needed.
 */

import { AulaHttpClient, withFreshTokens } from '@aula-mcp/aula-auth';
import {
  AulaClient,
  EasyIqSkoleportalClient,
  isoWeekString,
  type NormalisedWeekPlanItem,
  WidgetTokenManager,
} from '@aula-mcp/aula-client';
import { fmt, printJson } from '../io.ts';
import { defaultStore } from '../store.ts';

export interface UgeplanFetchCommandArgs {
  childIds: number[];
  institutionCodes: string[];
  /** ISO weeks to fetch (e.g. ["2026-W23"]). Defaults to current + next. */
  isoWeeks?: string[];
}

/** Fixed key order so serialized items are byte-stable across polls. */
const ITEM_KEYS: ReadonlyArray<keyof NormalisedWeekPlanItem> = [
  'childName',
  'date',
  'subject',
  'title',
  'content',
  'kind',
  'url',
];

/**
 * Reduce a plan item to its defined string fields in a fixed key order.
 * Drops `undefined`/empty so a field flicking between absent and "" never
 * reads as a change.
 */
export function canonicalItem(it: NormalisedWeekPlanItem): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ITEM_KEYS) {
    const v = it[k];
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return out;
}

/**
 * Canonicalise + order a week's items so the serialized output is
 * byte-stable regardless of upstream ordering jitter — the whole point of
 * the pre-check is that an unchanged plan diffs to "unchanged".
 */
export function normaliseItems(items: NormalisedWeekPlanItem[]): Record<string, string>[] {
  return items.map(canonicalItem).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
}

/** Current + next ISO week — mirrors the old cron's "this week + next week". */
function defaultWeeks(): string[] {
  const now = new Date();
  const next = new Date(now.getTime() + 7 * 86_400_000);
  return [isoWeekString(now), isoWeekString(next)];
}

export async function runUgeplanFetch(args: UgeplanFetchCommandArgs): Promise<void> {
  const store = defaultStore();
  const http = new AulaHttpClient();
  let record: Awaited<ReturnType<typeof withFreshTokens>>;
  try {
    record = await withFreshTokens({ store, http });
  } catch (e) {
    printJson({
      ok: false,
      error: 'tokens',
      message: (e as Error).message,
      hint: `Run ${fmt.bold('aula login')} or ${fmt.bold('aula refresh-stepup')} to recover.`,
    });
    process.exit(1);
  }

  const client = new AulaClient({ tokens: record.tokens, http });
  try {
    // Prime the guardian profile (the *ForActiveProfile endpoints 403
    // otherwise) and grab the numeric guardian id — same preflight the
    // MCP path does via context.getGuardianUserId().
    const guardianCtx = await client.getProfileContext('guardian');
    const guardianId = guardianCtx.userId == null ? '' : String(guardianCtx.userId);

    // SkolePortal's x-childfilter wants the opaque per-child userId, not
    // the numeric child id. Map it from the profiles list, aligned with
    // childIds by index (missing → ""), exactly as buildIntegrationCtx does.
    const profilesData = await client.getProfilesByLogin();
    const userIdByChildId = new Map<number, string>();
    for (const profile of profilesData.profiles ?? []) {
      for (const child of profile.children ?? []) {
        if (child.userId != null) userIdByChildId.set(child.id, String(child.userId));
      }
    }
    const childUserIds = args.childIds.map((id) => userIdByChildId.get(id) ?? '');

    const widgets = new WidgetTokenManager({ client });
    const sp = new EasyIqSkoleportalClient({ http, widgets });

    const isoWeeks = args.isoWeeks && args.isoWeeks.length > 0 ? args.isoWeeks : defaultWeeks();

    const weeks: Record<string, { items: Record<string, string>[]; warnings?: string[] }> = {};
    for (const isoWeek of isoWeeks) {
      const plan = await sp.getWeekPlan({
        isoWeek,
        sessionId: record.username,
        guardianId,
        childIds: args.childIds,
        childUserIds,
        institutionCodes: args.institutionCodes,
      });
      const items = normaliseItems(plan.items);
      weeks[isoWeek] = {
        items,
        ...(plan.warnings && plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
      };
    }
    printJson({ ok: true, weeks });
  } catch (e) {
    printJson({
      ok: false,
      error: 'api',
      message: (e as Error).message,
    });
    // Deliberately no `fail()` here. This command's entire contract is one
    // JSON document on stdout, and `fail` writes to stdout too — a trailing
    // `✗ message` line makes the output unparseable for the very pollers
    // this command exists to serve. The payload above already carries the
    // message, and the non-zero exit code signals the failure.
    process.exit(1);
  }
}
