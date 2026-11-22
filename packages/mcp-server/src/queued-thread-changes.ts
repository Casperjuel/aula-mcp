/**
 * A thread's read state and pin, changed by the parent in the dashboard. With
 * Aula reachable the change goes straight there (setup-ui.ts). Without it (no
 * Aula login, an expired session, Aula down) the stored copy changes now and
 * the change waits on the thread, under `pendingAula`, until the next messages
 * sync can send it.
 *
 * Only the parent's own clicks are queued and sent. The sync jobs still read
 * only; sending the queue is its own step before them (sync.ts). Sync keeps a
 * queued flag over what Aula says until it is sent, so the page does not flip
 * back, and drops a queued "read" when a new message arrived in the meantime:
 * the parent has not seen that one.
 */

import { AulaApiError, AulaApiVersionError, type AulaClient } from '@aula-mcp/aula-client';
import type { ItemKind, ParentStorage, StoredItem } from './storage.ts';

export const PENDING_KEY = 'pendingAula';

/** The flags a parent can change on a thread, as Aula's thread object names them. */
export interface ThreadPatch {
  read?: boolean;
  marked?: boolean;
}

interface Pending extends ThreadPatch {
  /** Sends that failed for a reason other than missing access. */
  attempts?: number;
}

export type ThreadWriter = Pick<
  AulaClient,
  'setLastReadMessage' | 'setThreadsRead' | 'setThreadsMarked'
>;

/** What one change is called in the audit log. */
export const actionOf = (key: keyof ThreadPatch, value: boolean) =>
  key === 'read' ? (value ? 'mark_read' : 'mark_unread') : value ? 'mark_thread' : 'unmark_thread';

/** Give up on a queued change after this many refusals from Aula. */
const MAX_ATTEMPTS = 3;
/** Queued changes are looked for among the newest threads only. */
const SCAN_THREADS = 500;

const asRecord = (data: unknown): Record<string, unknown> =>
  typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};

export function pendingOf(data: unknown): Pending | null {
  const pending = asRecord(data)[PENDING_KEY];
  return typeof pending === 'object' && pending !== null ? (pending as Pending) : null;
}

const patchKeys = (patch: ThreadPatch) =>
  (['read', 'marked'] as const).filter((key) => typeof patch[key] === 'boolean');

const latestId = (data: unknown) => asRecord(asRecord(data).latestMessage).id ?? null;

/** The thread with `patch` applied and queued for Aula. */
export function withQueued(data: unknown, patch: ThreadPatch): Record<string, unknown> {
  const d = asRecord(data);
  const { attempts: _attempts, ...queued } = pendingOf(d) ?? {};
  return { ...d, ...patch, [PENDING_KEY]: { ...queued, ...patch } };
}

/** The thread with `patch` applied and nothing of it left queued. */
export function withSent(data: unknown, patch: ThreadPatch): Record<string, unknown> {
  const d = asRecord(data);
  const pending = pendingOf(d);
  const { [PENDING_KEY]: _queued, ...rest } = d;
  const next: Record<string, unknown> = { ...rest, ...patch };
  if (pending) {
    const left: Pending = { ...pending };
    for (const key of patchKeys(patch)) delete left[key];
    if (patchKeys(left).length) next[PENDING_KEY] = left;
  }
  return next;
}

/**
 * For sync: Aula's fresh copy of a thread, with what is still queued on the
 * stored copy kept on top. A queued flag Aula already agrees with is done.
 */
export function keepQueued(fresh: unknown, stored: StoredItem | null): unknown {
  const pending = stored ? pendingOf(stored.data) : null;
  if (!pending) return fresh;
  const f = asRecord(fresh);
  const left: Pending = {};
  for (const key of patchKeys(pending)) {
    const value = pending[key] as boolean;
    if (f[key] === value) continue;
    // A new message since the click: the parent has not read that one.
    if (key === 'read' && value && latestId(f) !== latestId(stored?.data)) continue;
    left[key] = value;
  }
  if (!patchKeys(left).length) return fresh;
  if (pending.attempts) left.attempts = pending.attempts;
  return { ...f, ...left, [PENDING_KEY]: left };
}

/** The Aula write for one change, or what the stored thread lacks for it. */
export function planWrite(
  data: unknown,
  id: number,
  key: keyof ThreadPatch,
  value: boolean,
): ((client: ThreadWriter) => Promise<unknown>) | string {
  const d = asRecord(data);
  if (key === 'marked') return (client) => client.setThreadsMarked([id], value);
  if (value) {
    const messageId = latestId(d);
    if (messageId == null) return 'latest message id';
    // Aula has no "mark as read" verb; see AulaClient.setLastReadMessage.
    // messaging.updateSubscriptionStatus with isRead: true answered 400
    // live, so the read marker is the only write here.
    return (client) => client.setLastReadMessage(id, String(messageId));
  }
  const subscriptionId = d.subscriptionId;
  if (typeof subscriptionId !== 'number') return 'subscription id';
  return (client) => client.setThreadsRead([subscriptionId], false);
}

/**
 * Whether a failed write means Aula could not be reached as this parent, so
 * the change should wait, rather than Aula refusing it.
 */
export function noAulaAccess(err: unknown): boolean {
  if (err instanceof AulaApiVersionError) return false;
  if (err instanceof AulaApiError) {
    return err.status === 401 || err.status === 403 || err.status >= 500;
  }
  // Network failures, an expired session, a MitID step-up.
  return true;
}

export interface QueueSession {
  getClient(): Promise<ThreadWriter>;
  /** Messaging answers 403 until the guardian profile is activated. */
  getGuardianUserId(): Promise<string>;
}

const THREAD: ItemKind = 'message_thread';

/**
 * Sends what is queued to Aula, oldest click first per thread. Stops at the
 * first failure that means no access; the rest waits for the next run.
 * Audited like the dashboard's own changes, with ids only.
 */
export async function sendQueuedThreadChanges(
  store: ParentStorage,
  session: QueueSession,
): Promise<{ sent: number; waiting: number }> {
  const queued = (await store.list({ kind: THREAD, limit: SCAN_THREADS })).filter((row) =>
    pendingOf(row.data),
  );
  if (!queued.length) return { sent: 0, waiting: 0 };
  const audit = async (
    action: string,
    ok: boolean,
    details: Record<string, string | boolean>,
    durationMs: number | null = null,
  ) => {
    try {
      await store.audit({
        category: 'aula',
        action,
        ok,
        durationMs,
        details: { ...details, trigger: 'queued' },
      });
    } catch {}
  };
  let client: ThreadWriter | undefined;
  let sent = 0;
  for (const [index, row] of queued.entries()) {
    const id = Number(row.id);
    let current = row;
    for (const key of patchKeys(pendingOf(row.data) ?? {})) {
      const value = (pendingOf(current.data) ?? {})[key] as boolean;
      const action = actionOf(key, value);
      const write = Number.isInteger(id) ? planWrite(current.data, id, key, value) : 'id';
      if (typeof write === 'string') {
        current = dropKey(current, key);
        await store.put([current]);
        await audit(action, false, {
          threadId: row.id,
          error: `the stored thread has no ${write}`,
        });
        continue;
      }
      const started = Date.now();
      try {
        if (!client) {
          client = await session.getClient();
          await session.getGuardianUserId();
        }
        await write(client);
      } catch (err) {
        const message = (err as Error).message.slice(0, 300);
        if (noAulaAccess(err)) {
          await audit(action, false, { threadId: row.id, error: message, waiting: true });
          return { sent, waiting: queued.length - index };
        }
        const attempts = (pendingOf(current.data)?.attempts ?? 0) + 1;
        current =
          attempts >= MAX_ATTEMPTS
            ? dropKey(current, key)
            : {
                ...current,
                data: {
                  ...asRecord(current.data),
                  [PENDING_KEY]: { ...pendingOf(current.data), attempts },
                },
              };
        await store.put([current]);
        await audit(action, false, {
          threadId: row.id,
          error: message,
          ...(attempts >= MAX_ATTEMPTS ? { givenUp: true } : {}),
        });
        continue;
      }
      current = { ...current, data: withSent(current.data, { [key]: value }) };
      await store.put([current]);
      sent++;
      await audit(action, true, { threadId: row.id }, Date.now() - started);
    }
  }
  return { sent, waiting: 0 };
}

/** The thread with one queued change dropped; the next sync brings Aula's value. */
function dropKey(row: StoredItem, key: keyof ThreadPatch): StoredItem {
  const d = asRecord(row.data);
  const left: Pending = { ...pendingOf(d) };
  delete left[key];
  const { [PENDING_KEY]: _queued, ...rest } = d;
  return { ...row, data: patchKeys(left).length ? { ...rest, [PENDING_KEY]: left } : rest };
}
