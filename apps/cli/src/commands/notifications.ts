/**
 * `aula notifications list-ids` — print a stable id (plus best-effort
 * type/triggered) per notification in the active guardian's feed, as
 * JSON. Cheap pre-check for polling scripts: diff against a state-file
 * `seenNotificationIds` list and only fire downstream classification
 * when something is genuinely new.
 *
 * Same rationale as `threads list-ids` (see threads.ts): openclaw's
 * `/tools/invoke` HTTP surface doesn't expose MCP-plugin-server tools,
 * so a shell poller can't reach `aula.notifications.list` from outside
 * the LLM path. This CLI command sidesteps that, keeping the
 * "anything new?" check off the LLM bill.
 *
 * Aula's `notifications.getNotificationsForActiveProfile` is untyped
 * (the client returns raw JSON), so we stay shape-tolerant: locate the
 * array wherever it lives, prefer a `notificationId`/`id` string as the
 * dedup key, and fall back to a stable hash of the record so dedup
 * still works if the shape drifts. `type`/`triggered` are surfaced
 * best-effort for debugging only — the poller dedups on `id` alone and
 * the LLM does the semantic (Overblik-vs-message) filtering on the full
 * payload it fetches via the MCP tool.
 */

import { createHash } from 'node:crypto';
import { AulaHttpClient, withFreshTokens } from '@aula-mcp/aula-auth';
import { AulaClient } from '@aula-mcp/aula-client';
import { fail, fmt, printJson } from '../io.ts';
import { defaultStore } from '../store.ts';

/** Find the notifications array regardless of where Aula nests it. */
export function asArray(raw: unknown): Record<string, unknown>[] {
  const pick = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null);
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  const obj = (raw ?? {}) as Record<string, unknown>;
  const data = (obj.data ?? {}) as Record<string, unknown>;
  const found = pick(obj.data) ?? pick(data.notifications) ?? pick(obj.notifications) ?? [];
  return found as Record<string, unknown>[];
}

/**
 * Stable per-notification id for dedup. Prefer Aula's own identifier;
 * if absent, hash a canonical (sorted-key) serialization of the record
 * so the id is reproducible across polls.
 */
export function stableId(n: Record<string, unknown>): string {
  const direct = n.notificationId ?? n.id;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  if (typeof direct === 'number') return String(direct);
  const canonical = JSON.stringify(
    Object.keys(n)
      .sort()
      .map((k) => [k, n[k]]),
  );
  return `sha:${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

function firstString(n: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    if (typeof n[k] === 'string') return n[k] as string;
  }
  return null;
}

export async function runNotificationsListIds(): Promise<void> {
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
    // Prime the guardian profile: `*ForActiveProfile` endpoints 403 if
    // it hasn't been activated — same preflight threads list-ids does,
    // and what the MCP notifications tool gets via getGuardianUserId().
    await client.getProfileContext('guardian');
    const raw = await client.getNotifications();
    const notifications = asArray(raw).map((n) => ({
      id: stableId(n),
      type: firstString(n, ['notificationArea', 'notificationType', 'type']),
      triggered: firstString(n, ['triggered', 'triggeredTime', 'eventTime']),
    }));
    printJson({ ok: true, notifications });
  } catch (e) {
    printJson({
      ok: false,
      error: 'api',
      message: (e as Error).message,
    });
    fail((e as Error).message);
    process.exit(1);
  }
}
