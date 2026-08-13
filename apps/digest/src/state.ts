/**
 * State: what have we already reported?
 *
 * The crux is that Aula threads grow — a thread we reported yesterday can have
 * a new message today. So per-thread we remember the *last message id we saw*,
 * not merely "seen". Posts instead get a content hash, because posts are edited
 * in place and an edit is exactly where a changed pickup time hides.
 *
 * `seenMessageIds` is a ring buffer used as a belt-and-braces cross-check: Aula
 * timestamps have collided at second granularity, so id-based dedup is the only
 * safe answer and this catches a message re-appearing under a different thread.
 *
 * Writes are atomic (tmp + rename). A run that dies mid-write must not leave a
 * truncated state file — that would re-report everything or, worse, skip it.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SCHEMA_VERSION = 1;

/** Keep the last N message ids. ~20 threads × a few messages/day ⇒ months. */
const RING_SIZE = 500;

export interface ThreadState {
  lastSeenMessageId?: string | undefined;
  lastSeenTs?: string | undefined;
  subject?: string | undefined;
  stepUp?: boolean | undefined;
}

export interface PostState {
  seenTs?: string | undefined;
  hash?: string | undefined;
}

export interface DigestState {
  schemaVersion: number;
  firstRunAt?: string | undefined;
  lastRunAt?: string | undefined;
  lastSlackTs?: string | undefined;
  threads: Record<string, ThreadState>;
  posts: Record<string, PostState>;
  seenMessageIds: string[];
}

/** Data lives outside the git repo — the fork is public. */
export function dataDir(): string {
  return process.env.AULA_DIGEST_DIR ?? join(homedir(), 'Documents', 'Claude', 'aula-digest');
}

export function statePath(): string {
  return join(dataDir(), '.state.json');
}

export function emptyState(): DigestState {
  return { schemaVersion: SCHEMA_VERSION, threads: {}, posts: {}, seenMessageIds: [] };
}

/**
 * Load state, or return a blank one if this is the very first run.
 * A corrupt file is fatal on purpose: silently starting from zero would dump
 * six months of Aula history into Slack.
 */
export async function loadState(): Promise<DigestState> {
  let raw: string;
  try {
    raw = await readFile(statePath(), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw e;
  }

  const parsed = JSON.parse(raw) as Partial<DigestState>;
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `state schemaVersion ${parsed.schemaVersion} != expected ${SCHEMA_VERSION} — migrate by hand`,
    );
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    firstRunAt: parsed.firstRunAt,
    lastRunAt: parsed.lastRunAt,
    lastSlackTs: parsed.lastSlackTs,
    threads: parsed.threads ?? {},
    posts: parsed.posts ?? {},
    seenMessageIds: parsed.seenMessageIds ?? [],
  };
}

/** Atomic write — a half-written state file is worse than none. */
export async function saveState(state: DigestState): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  const target = statePath();
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tmp, target);
}

/** True on the very first run — caller switches to seed mode. */
export function isSeedRun(state: DigestState): boolean {
  return !state.firstRunAt;
}

export function hasSeenMessage(state: DigestState, id: string): boolean {
  return state.seenMessageIds.includes(id);
}

export function rememberMessage(state: DigestState, id: string): void {
  if (state.seenMessageIds.includes(id)) return;
  state.seenMessageIds.unshift(id);
  if (state.seenMessageIds.length > RING_SIZE) {
    state.seenMessageIds.length = RING_SIZE;
  }
}
