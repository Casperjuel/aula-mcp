#!/usr/bin/env bun
/**
 * aula-digest — Stage 2.
 *
 * Fetch new Aula beskeder + opslag, diff against local state, write a full
 * `YYYY-MM-DD.md` artefact, append one line to runs.jsonl. **No Slack, no LLM
 * yet** — those are Stage 3 and 4. Bodies never leave this machine.
 *
 * Phased with an `errors[]` accumulator; only preflight aborts. State is
 * committed LAST, so any failure downstream means tomorrow re-reports rather
 * than silently dropping a message.
 *
 * Flags:
 *   --dry-run   do everything except write state (safe to run repeatedly)
 *   --json      machine-readable summary on stdout
 *   --seed      force seed behaviour even if state exists
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AulaSession,
  fetchNewMessages,
  fetchNewPosts,
  isContentMessage,
  listAllThreadPointers,
  openSession,
} from './aula.ts';
import {
  type ArtefactInput,
  localDateKey,
  renderArtefact,
  renderConsoleSummary,
} from './render.ts';
import { appendRunLog, decideOutcome, isoWithOffset, type RunLogEntry } from './runlog.ts';
import {
  type DigestState,
  dataDir,
  hasSeenMessage,
  isSeedRun,
  loadState,
  rememberMessage,
  saveState,
} from './state.ts';

interface Flags {
  dryRun: boolean;
  json: boolean;
  seed: boolean;
}

function parseFlags(argv: string[]): Flags {
  return {
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
    seed: argv.includes('--seed'),
  };
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  const runAt = new Date();
  const errors: string[] = [];

  const state = await loadState();
  const seedRun = flags.seed || isSeedRun(state);

  // ---- phase 0: preflight ----------------------------------------------------
  // The only phase that aborts. No tokens ⇒ nothing else is meaningful.

  let session: AulaSession;
  try {
    session = await openSession();
  } catch (e) {
    const msg = (e as Error).message;
    await appendRunLog({
      ts: isoWithOffset(runAt),
      task: 'aula-digest',
      outcome: 'error',
      reason: 'auth_dead',
      counts: { messages: 0, posts: 0, stepUp: 0, scannedThreads: 0, scannedPosts: 0 },
      actions: [],
      errors: [`preflight: ${msg}`],
      notes: 'MitID-tokens kunne ikke fornyes — kør `aula login` på maskinen.',
    });
    process.stderr.write(`auth_dead: ${msg}\n`);
    return 1;
  }

  // ---- seed run --------------------------------------------------------------
  // First run indexes every thread and post and reports NOTHING backwards.
  // Bodies are deliberately not fetched: we only need each thread's pointer, and
  // dumping months of history into a file named after today would be a lie.

  if (seedRun) {
    return await runSeed(session, state, runAt, flags);
  }

  // ---- phase 1: beskeder -----------------------------------------------------

  let messages: Awaited<ReturnType<typeof fetchNewMessages>>['messages'] = [];
  let stepUp: Awaited<ReturnType<typeof fetchNewMessages>>['stepUp'] = [];
  let pointers: Awaited<ReturnType<typeof fetchNewMessages>>['pointers'] = [];
  let scannedThreads = 0;
  try {
    const r = await fetchNewMessages(session, state.threads);
    messages = r.messages;
    stepUp = r.stepUp;
    pointers = r.pointers;
    scannedThreads = r.scanned;
    errors.push(...r.errors);
  } catch (e) {
    errors.push(`beskeder: ${(e as Error).message}`);
  }

  // Ring-buffer cross-check. Aula timestamps have collided at second
  // granularity, so ids are the only trustworthy dedup key.
  messages = messages.filter((m) => !hasSeenMessage(state, m.id));

  // Split content from Aula's membership bookkeeping. `allMessages` advances
  // state (so bookkeeping doesn't re-trigger the thread forever); only
  // `messages` is ever shown or, later, summarised.
  const allMessages = messages;
  messages = messages.filter(isContentMessage);

  // ---- phase 2: opslag -------------------------------------------------------
  // Independent of phase 1: a messaging failure must not cost us the posts.

  let posts: Awaited<ReturnType<typeof fetchNewPosts>>['posts'] = [];
  let scannedPosts = 0;
  try {
    const r = await fetchNewPosts(session, state.posts);
    posts = r.posts;
    scannedPosts = r.scanned;
  } catch (e) {
    errors.push(`opslag: ${(e as Error).message}`);
  }

  const hadContent = messages.length > 0 || posts.length > 0 || stepUp.length > 0;

  const artefact: ArtefactInput = {
    runAt,
    seedRun,
    messages,
    stepUp,
    posts,
    scannedThreads,
    scannedPosts,
    errors,
  };

  // ---- phase 3: artefact -----------------------------------------------------
  // Written before any delivery, so content survives a Slack/Azure outage.

  let delivered = false;
  let artefactPath: string | undefined;
  if (hadContent) {
    try {
      await mkdir(dataDir(), { recursive: true });
      artefactPath = join(dataDir(), `${localDateKey(runAt)}.md`);
      await writeFile(artefactPath, renderArtefact(artefact), 'utf8');
      delivered = true;
    } catch (e) {
      errors.push(`artefakt: ${(e as Error).message}`);
    }
  } else {
    delivered = true; // nothing to deliver is a successful delivery
  }

  // ---- phase 4: commit state -------------------------------------------------
  // LAST, and only if the artefact landed. Ordering is the whole recovery story.

  if (!flags.dryRun && delivered) {
    advanceState(
      state,
      runAt,
      allMessages,
      pointers,
      new Set(stepUp.map((s) => s.threadId)),
      posts,
    );
    try {
      await saveState(state);
    } catch (e) {
      errors.push(`state: ${(e as Error).message}`);
      delivered = false;
    }
  }

  // ---- phase 5: log ----------------------------------------------------------

  const { outcome, reason } = decideOutcome({ errors, hadContent, delivered });
  const entry: RunLogEntry = {
    ts: isoWithOffset(runAt),
    task: 'aula-digest',
    outcome,
    reason: seedRun ? `seed_${reason}` : reason,
    counts: {
      messages: messages.length,
      posts: posts.length,
      stepUp: stepUp.length,
      scannedThreads,
      scannedPosts,
    },
    actions: [
      ...messages.map((m) => ({ type: 'message', id: m.id })),
      ...posts.map((p) => ({ type: 'post', id: String(p.id) })),
      ...stepUp.map((s) => ({ type: 'stepup_thread', id: String(s.threadId) })),
    ],
    errors,
    notes: seedRun
      ? 'Første kørsel: alt indekseret, intet sendt bagud.'
      : flags.dryRun
        ? 'dry-run: state ikke skrevet.'
        : undefined,
  };
  await appendRunLog(entry);

  // ---- output ----------------------------------------------------------------

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ ...entry, artefactPath }, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderConsoleSummary(artefact)}\n`);
    if (artefactPath) process.stdout.write(`  → ${artefactPath}\n`);
    if (flags.dryRun) process.stdout.write('  (dry-run — state uændret)\n');
  }

  return outcome === 'error' ? 1 : 0;
}

/**
 * Seed run: index everything, report nothing backwards.
 *
 * Deliberately reads no message bodies. The only thing that must be perfect
 * here is coverage — every thread and post gets a pointer, so tomorrow's run
 * sees genuinely new content and not six months of history.
 */
async function runSeed(
  session: AulaSession,
  state: DigestState,
  runAt: Date,
  flags: Flags,
): Promise<number> {
  const errors: string[] = [];
  let threadCount = 0;
  let postCount = 0;

  try {
    const pointers = await listAllThreadPointers(session);
    threadCount = pointers.length;
    for (const p of pointers) {
      // Deliberately NOT added to the ring buffer: the per-thread pointer is
      // the real dedup key, and 490 seed ids would evict the ring's actual job
      // (catching same-second timestamp collisions among reported messages).
      state.threads[String(p.threadId)] = {
        lastSeenMessageId: p.latestMessageId,
        lastSeenTs: p.sentAt,
        subject: p.subject,
      };
    }
  } catch (e) {
    errors.push(`seed beskeder: ${(e as Error).message}`);
  }

  try {
    // Ask for a deep page of posts so the back catalogue is indexed too.
    const r = await fetchNewPosts(session, {}, { limit: 100 });
    postCount = r.posts.length;
    for (const p of r.posts) {
      state.posts[String(p.id)] = { seenTs: p.publishedAt, hash: p.hash };
    }
  } catch (e) {
    errors.push(`seed opslag: ${(e as Error).message}`);
  }

  const delivered = errors.length === 0;
  if (!flags.dryRun && delivered) {
    const now = isoWithOffset(runAt);
    state.firstRunAt ??= now;
    state.lastRunAt = now;
    try {
      await saveState(state);
    } catch (e) {
      errors.push(`state: ${(e as Error).message}`);
    }
  }

  const entry: RunLogEntry = {
    ts: isoWithOffset(runAt),
    task: 'aula-digest',
    outcome: errors.length > 0 ? 'partial' : 'ok',
    reason: 'seed_indexed',
    counts: {
      messages: 0,
      posts: 0,
      stepUp: 0,
      scannedThreads: threadCount,
      scannedPosts: postCount,
    },
    actions: [],
    errors,
    notes: `Første kørsel: ${threadCount} tråde og ${postCount} opslag indekseret, intet sendt bagud.`,
  };
  await appendRunLog(entry);

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Aula-digest ${localDateKey(runAt)} (seed)\n` +
        `  ${threadCount} tråde og ${postCount} opslag indekseret · intet sendt bagud\n` +
        `${errors.map((e) => `  ! ${e}\n`).join('')}` +
        `${flags.dryRun ? '  (dry-run — state uændret)\n' : ''}`,
    );
  }
  return errors.length > 0 ? 1 : 0;
}

/**
 * Fold this run's findings into state. Only called once delivery succeeded.
 *
 * Thread pointers come from `pointers`, NOT from the messages we rendered.
 * Aula returns thread messages newest-first, so picking one off the rendered
 * list is easy to get backwards — and a pointer that isn't exactly the
 * `latestMessage.id` the change-check reads would never converge, re-reporting
 * the thread every day. Only threads that were handled successfully appear
 * here; a thread that errored keeps its old pointer and is retried tomorrow.
 */
function advanceState(
  state: DigestState,
  runAt: Date,
  messages: { id: string }[],
  pointers: { threadId: number; latestMessageId: string; subject: string; sentAt: string }[],
  stepUpIds: Set<number>,
  posts: { id: number; hash: string; publishedAt: string }[],
): void {
  // The ring buffer holds only messages we actually reported — it exists to
  // catch same-second timestamp collisions, not to mirror the pointers.
  for (const m of messages) rememberMessage(state, m.id);

  for (const p of pointers) {
    if (!p.latestMessageId) continue;
    const key = String(p.threadId);
    const prior = state.threads[key] ?? {};
    state.threads[key] = {
      ...prior,
      lastSeenMessageId: p.latestMessageId,
      lastSeenTs: p.sentAt || prior.lastSeenTs,
      subject: p.subject,
      stepUp: stepUpIds.has(p.threadId) ? true : prior.stepUp,
    };
  }

  for (const p of posts) {
    state.posts[String(p.id)] = { seenTs: p.publishedAt, hash: p.hash };
  }

  const now = isoWithOffset(runAt);
  state.firstRunAt ??= now;
  state.lastRunAt = now;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`fatal: ${(e as Error).stack ?? (e as Error).message}\n`);
    process.exit(1);
  });
