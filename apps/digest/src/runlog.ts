/**
 * One JSONL line per run, appended to the existing central ops log so
 * `status.py` can flag silence as OVERDUE.
 *
 * The house rule this module exists to enforce: **a non-empty `errors[]` may
 * never be logged as `ok` or `noop`.** Silence in Slack is acceptable; silence
 * in the log is not. `decideOutcome` is the only place that mapping lives.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type Outcome = 'ok' | 'noop' | 'partial' | 'error';

export interface RunLogEntry {
  ts: string;
  task: 'aula-digest';
  outcome: Outcome;
  reason: string;
  counts: {
    messages: number;
    posts: number;
    stepUp: number;
    scannedThreads: number;
    scannedPosts: number;
  };
  /** Message/post ids only — never subjects, senders or bodies. */
  actions: { type: string; id: string }[];
  errors: string[];
  notes?: string | undefined;
}

export function runLogPath(): string {
  return (
    process.env.AULA_DIGEST_RUNLOG ??
    join(homedir(), 'Documents', 'Claude', 'mobelhotel-ops', 'runs.jsonl')
  );
}

/** ISO-8601 with a real offset, matching the existing lines in runs.jsonl. */
export function isoWithOffset(d: Date = new Date()): string {
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  const local = new Date(d.getTime() + offMin * 60_000).toISOString().slice(0, 19);
  return `${local}${sign}${hh}:${mm}`;
}

/**
 * The single mapping from run facts to an outcome.
 *
 * `delivered` means the digest actually reached its destination. In Stage 2
 * there is no Slack, so writing the artefact counts as delivery.
 */
export function decideOutcome(opts: {
  errors: string[];
  hadContent: boolean;
  delivered: boolean;
  authDead?: boolean;
}): { outcome: Outcome; reason: string } {
  if (opts.authDead) return { outcome: 'error', reason: 'auth_dead' };
  if (!opts.delivered) return { outcome: 'error', reason: 'delivery_failed' };
  if (opts.errors.length > 0) return { outcome: 'partial', reason: 'errors_during_fetch' };
  if (!opts.hadContent) return { outcome: 'noop', reason: 'nothing_new' };
  return { outcome: 'ok', reason: 'digest_written' };
}

export async function appendRunLog(entry: RunLogEntry): Promise<void> {
  const path = runLogPath();
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
}
