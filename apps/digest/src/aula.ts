/**
 * Fetch layer: everything that talks to Aula.
 *
 * Two hard-won quirks are encoded here. Both were found empirically against a
 * live account on 2026-08-13 and neither is documented by Aula:
 *
 *  1. `profiles.getProfileContext` MUST be called before `posts.getAllPosts`.
 *     Without it Aula returns HTTP 403 / status.code 10 / subCode 23. The call
 *     establishes server-side session state; its return value is discarded.
 *
 *  2. `posts.getAllPosts` returns an EMPTY array unless `institutionProfileIds[]`
 *     contains the guardian's own institutionProfile id *together with* the
 *     children's. Any strict subset — own alone, or children alone — yields 0
 *     posts while still reporting `hasMorePosts: true`. So we always pass every
 *     id we can discover.
 */
import { AulaHttpClient, withFreshTokens } from '@aula-mcp/aula-auth';
import { AulaClient, AulaStepUpRequiredError } from '@aula-mcp/aula-client';
import { defaultStore } from '../../cli/src/store.ts';

export interface ChildRef {
  id: number;
  name: string;
}

export interface AulaSession {
  client: AulaClient;
  username: string;
  /** Guardian's own id + every child id — required verbatim by getAllPosts. */
  institutionProfileIds: number[];
  children: ChildRef[];
  tokenExpiresAt: number;
}

/** One new message inside a thread. */
export interface NewMessage {
  id: string;
  threadId: number;
  subject: string;
  sender: string;
  sentAt: string;
  /** Plain text, HTML stripped. Empty when only a preview was available. */
  text: string;
  children: string[];
  /** Aula's own `messageType`. See `isContentMessage`. */
  type: string;
  /** True for `MessageEdited` — the sender changed it after sending. */
  edited: boolean;
}

/**
 * Aula interleaves membership bookkeeping into the message list:
 * `RecipientsRemoved` / `RecipientsAdded` carry no body and mean "a parent was
 * added to this thread". They were 30 of 169 messages on a live account — pure
 * noise in a digest, but they still occupy `latestMessage.id`, so state MUST
 * advance past them or the thread is re-fetched on every run forever.
 */
export function isContentMessage(m: NewMessage): boolean {
  return m.type === 'Message' || m.type === 'MessageEdited';
}

/** A thread we know changed but cannot read (Aula 403 → MitID step-up). */
export interface StepUpThread {
  threadId: number;
  subject: string;
  sender: string;
  sentAt: string;
  children: string[];
}

export interface NewPost {
  id: number;
  title: string;
  text: string;
  author: string;
  publishedAt: string;
  editedAt?: string | undefined;
  important: boolean;
  /** sha256 of title+body, so a silent edit is detectable next run. */
  hash: string;
}

/** Strip HTML to readable plain text. Aula bodies are simple markup. */
export function htmlToText(html: string | undefined): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Log in from stored tokens (refreshing if needed) and bootstrap the session.
 * Throws if tokens are missing or dead — the caller treats that as `auth_dead`.
 */
export async function openSession(): Promise<AulaSession> {
  const store = defaultStore();
  const http = new AulaHttpClient();
  const record = await withFreshTokens({ store, http });
  const client = new AulaClient({ tokens: record.tokens, http });

  const profiles = (await client.getProfilesByLogin()) as {
    profiles?: {
      institutionProfiles?: { id?: number }[];
      children?: { id?: number; name?: string; displayName?: string }[];
    }[];
  };

  // QUIRK 1: required session bootstrap. Return value intentionally unused.
  await client.getProfileContext('guardian');

  const ids = new Set<number>();
  const children: ChildRef[] = [];
  for (const p of profiles.profiles ?? []) {
    for (const ip of p.institutionProfiles ?? []) if (ip?.id) ids.add(ip.id);
    for (const c of p.children ?? []) {
      if (!c?.id) continue;
      ids.add(c.id);
      children.push({ id: c.id, name: c.displayName ?? c.name ?? `barn ${c.id}` });
    }
  }

  return {
    client,
    username: record.username,
    institutionProfileIds: [...ids],
    children,
    tokenExpiresAt: record.tokens.expires_at,
  };
}

/**
 * Decide which of a thread's messages are new, returned oldest-first for
 * rendering.
 *
 * CAREFUL: `getMessagesForThread` returns messages **newest-first**, verified
 * against a live account (5 of 6 threads strictly descending; the 6th only
 * broke monotonicity because a `MessageEdited` entry keeps its slot while its
 * timestamp moves). So "after the pointer" means the messages BEFORE it in the
 * array. Getting this backwards silently reports the oldest message instead of
 * the newest and the thread never converges.
 *
 * The unhappy path matters most. If the stored pointer is absent — the message
 * was deleted, or Aula returned only a recent window of a long thread — then
 * taking everything would dump the whole thread into the digest. So we fall
 * back to the stored timestamp, and if that is missing too we report nothing.
 * A one-day delay is a nuisance; a 40-message false burst destroys trust.
 */
export function selectFreshMessages<T extends { id?: string; sendDateTime?: string }>(
  all: T[],
  lastSeenId: string | undefined,
  lastSeenTs: string | undefined,
): T[] {
  const chronological = (xs: T[]): T[] => [...xs].reverse();

  if (!lastSeenId) return chronological(all); // thread is brand new

  const idx = all.findIndex((m) => String(m.id) === lastSeenId);
  if (idx >= 0) return chronological(all.slice(0, idx));

  const since = lastSeenTs ? Date.parse(lastSeenTs) : Number.NaN;
  if (Number.isNaN(since)) return [];
  return chronological(
    all.filter((m) => {
      const ts = Date.parse(m.sendDateTime ?? '');
      return !Number.isNaN(ts) && ts > since;
    }),
  );
}

/** Just enough of a thread to record "I have seen up to here". */
export interface ThreadPointer {
  threadId: number;
  latestMessageId: string;
  subject: string;
  sentAt: string;
}

/**
 * Walk the ENTIRE thread list and return one pointer per thread.
 *
 * Used only by the seed run. It reads no bodies, so it is cheap and — crucially
 * — complete: any thread left unindexed on the first run would look brand new
 * tomorrow and backfill months of history into the digest.
 */
export async function listAllThreadPointers(
  session: AulaSession,
  opts: { maxPages?: number } = {},
): Promise<ThreadPointer[]> {
  const out: ThreadPointer[] = [];
  const maxPages = opts.maxPages ?? 200;
  for (let page = 0; page < maxPages; page++) {
    const batch = await session.client.getThreads({ page });
    if (batch.length === 0) break;
    for (const t of batch) {
      const latest = t.latestMessage?.id;
      if (!latest) continue;
      out.push({
        threadId: t.id,
        latestMessageId: String(latest),
        subject: t.subject ?? '(uden emne)',
        sentAt: t.latestMessage?.sendDateTime ?? '',
      });
    }
  }
  return out;
}

/**
 * Fetch threads whose latest message is newer than what state has seen.
 *
 * `seen` maps threadId → last seen message id. A thread absent from `seen` is
 * brand new. We only call getMessagesForThread for threads that actually moved,
 * which keeps a typical run to a handful of requests.
 *
 * Returns `pointers` for every thread it handled successfully. The caller MUST
 * advance state from these rather than from the last message it rendered: the
 * pointer is `latestMessage.id` straight off the thread list, which is the very
 * field the change-check compares against, so storing it is the only thing that
 * guarantees the comparison converges. Threads that errored are absent, so they
 * are retried tomorrow instead of being silently skipped.
 */
export async function fetchNewMessages(
  session: AulaSession,
  seen: Record<string, { lastSeenMessageId?: string | undefined; lastSeenTs?: string | undefined }>,
  opts: { maxThreads?: number; maxPages?: number } = {},
): Promise<{
  messages: NewMessage[];
  stepUp: StepUpThread[];
  pointers: ThreadPointer[];
  scanned: number;
  errors: string[];
}> {
  const messages: NewMessage[] = [];
  const stepUp: StepUpThread[] = [];
  const pointers: ThreadPointer[] = [];
  const errors: string[] = [];

  // Threads come back newest-activity-first, so page 0 normally holds every
  // thread that moved today. But if EVERY thread on a page changed we cannot
  // tell whether the next page also has movement — so we keep paging until a
  // page contains at least one already-seen thread. On a steady-state day this
  // is exactly one request; only the seed run walks further.
  const isChanged = (t: { id: number; latestMessage?: { id?: string } }): boolean => {
    const latest = t.latestMessage?.id;
    if (!latest) return false;
    return seen[String(t.id)]?.lastSeenMessageId !== latest;
  };

  const maxPages = opts.maxPages ?? 5;
  const threads: Awaited<ReturnType<typeof session.client.getThreads>> = [];
  const changed: typeof threads = [];
  for (let page = 0; page < maxPages; page++) {
    const batch = await session.client.getThreads({ page });
    if (batch.length === 0) break;
    threads.push(...batch);
    const changedHere = batch.filter(isChanged);
    changed.push(...changedHere);
    if (changedHere.length < batch.length) break; // found solid ground
  }

  const slice = changed.slice(0, opts.maxThreads ?? 40);

  for (const t of slice) {
    const raw = t as unknown as {
      regardingChildren?: { displayName?: string }[];
      creator?: { fullName?: string };
    };
    const kids = (raw.regardingChildren ?? []).map((c) => c.displayName ?? '').filter(Boolean);
    const subject = t.subject ?? '(uden emne)';
    const sender = raw.creator?.fullName ?? 'ukendt afsender';
    const lastSeenId = seen[String(t.id)]?.lastSeenMessageId;
    const lastSeenTs = seen[String(t.id)]?.lastSeenTs;
    const pointer: ThreadPointer = {
      threadId: t.id,
      latestMessageId: String(t.latestMessage?.id ?? ''),
      subject,
      sentAt: t.latestMessage?.sendDateTime ?? '',
    };

    try {
      const full = await session.client.getMessagesForThread(t.id);
      const fresh = selectFreshMessages(full.messages ?? [], lastSeenId, lastSeenTs);
      for (const m of fresh) {
        const mm = m as {
          id?: string;
          sendDateTime?: string;
          text?: { html?: string };
          sender?: { fullName?: string };
          messageType?: string;
        };
        if (!mm.id) continue;
        const type = mm.messageType ?? 'Message';
        messages.push({
          id: String(mm.id),
          threadId: t.id,
          subject,
          sender: mm.sender?.fullName ?? sender,
          sentAt: mm.sendDateTime ?? t.latestMessage?.sendDateTime ?? '',
          text: htmlToText(mm.text?.html),
          children: kids,
          type,
          edited: type === 'MessageEdited',
        });
      }
      pointers.push(pointer);
    } catch (e) {
      if (e instanceof AulaStepUpRequiredError) {
        // Expected for sensitive threads — surface as metadata, never an error.
        // The pointer still advances: we can never read this thread, so without
        // it the same sensitive thread would resurface every single day. With
        // it, only a genuinely NEW message brings it back.
        stepUp.push({
          threadId: t.id,
          subject,
          sender,
          sentAt: t.latestMessage?.sendDateTime ?? '',
          children: kids,
        });
        pointers.push(pointer);
      } else {
        errors.push(`thread ${t.id}: ${(e as Error).message}`);
      }
    }
  }

  return { messages, stepUp, pointers, scanned: threads.length, errors };
}

/**
 * Fetch posts newer than `sinceIso`, plus any whose content hash changed
 * (i.e. edited after we last saw them).
 */
export async function fetchNewPosts(
  session: AulaSession,
  seen: Record<string, { hash?: string | undefined }>,
  opts: { limit?: number } = {},
): Promise<{ posts: NewPost[]; scanned: number }> {
  const params = new URLSearchParams();
  params.set('method', 'posts.getAllPosts');
  params.set('parent', 'profile');
  params.set('index', '0');
  params.set('limit', String(opts.limit ?? 20));
  // QUIRK 2: every discovered id, together, or Aula returns an empty array.
  for (const id of session.institutionProfileIds) {
    params.append('institutionProfileIds[]', String(id));
  }

  const data = (await session.client.getJsonRaw(params)) as {
    posts?: {
      id: number;
      title?: string;
      content?: { html?: string };
      timestamp?: string;
      publishAt?: string;
      editedAt?: string;
      isImportant?: boolean;
      ownerProfile?: { fullName?: string };
    }[];
  };

  const all = data.posts ?? [];
  const fresh: NewPost[] = [];

  for (const p of all) {
    const text = htmlToText(p.content?.html);
    const hash = await sha256(`${p.title ?? ''}\u0000${text}`);
    const prior = seen[String(p.id)];
    if (prior?.hash === hash) continue; // unchanged, already reported
    fresh.push({
      id: p.id,
      title: p.title ?? '(uden titel)',
      text,
      author: p.ownerProfile?.fullName ?? 'ukendt',
      publishedAt: p.publishAt ?? p.timestamp ?? '',
      editedAt: p.editedAt,
      important: Boolean(p.isImportant),
      hash,
    });
  }

  return { posts: fresh, scanned: all.length };
}
