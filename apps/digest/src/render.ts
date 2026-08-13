/**
 * Render the local artefact: `YYYY-MM-DD.md` with FULL bodies.
 *
 * This file is the ground truth and stays on the machine forever. It is written
 * *before* anything is sent anywhere, so if Slack or Azure fall over the day's
 * content is still captured and hand-checkable against aula.dk.
 *
 * All formatting is Danish and Copenhagen-local. Timestamps are compared
 * elsewhere as UTC instants and only formatted here — never compare the strings
 * this module produces.
 */
import type { NewMessage, NewPost, StepUpThread } from './aula.ts';

const TZ = 'Europe/Copenhagen';

const dateFmt = new Intl.DateTimeFormat('da-DK', {
  timeZone: TZ,
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const timeFmt = new Intl.DateTimeFormat('da-DK', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
});

const dayTimeFmt = new Intl.DateTimeFormat('da-DK', {
  timeZone: TZ,
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** `2026-08-13` in Copenhagen time — the artefact filename. */
export function localDateKey(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  return parts;
}

function fmtOr(iso: string | undefined, f: Intl.DateTimeFormat, fallback = 'ukendt tid'): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? fallback : f.format(d);
}

export function threadUrl(threadId: number): string {
  return `https://www.aula.dk/portal/#/beskeder/${threadId}`;
}

export function postUrl(postId: number): string {
  return `https://www.aula.dk/portal/#/opslag/${postId}`;
}

export interface ArtefactInput {
  runAt: Date;
  seedRun: boolean;
  messages: NewMessage[];
  stepUp: StepUpThread[];
  posts: NewPost[];
  scannedThreads: number;
  scannedPosts: number;
  errors: string[];
}

/** The full-fidelity local record. Never truncated, never summarised. */
export function renderArtefact(input: ArtefactInput): string {
  const out: string[] = [];
  const day = dateFmt.format(input.runAt);

  out.push(`# Aula — ${day}`);
  out.push('');
  out.push(
    `_Kørt ${fmtOr(input.runAt.toISOString(), timeFmt)} · ${input.scannedThreads} tråde og ` +
      `${input.scannedPosts} opslag gennemgået_`,
  );
  if (input.seedRun) {
    out.push('');
    out.push('> **Første kørsel (seed).** Alt herunder er indekseret, intet er sendt til Slack.');
  }
  out.push('');

  // ---- beskeder --------------------------------------------------------------

  out.push(`## Beskeder (${input.messages.length})`);
  out.push('');
  if (input.messages.length === 0) {
    out.push('_Ingen nye beskeder._');
    out.push('');
  } else {
    // Group by thread so a burst in one thread reads as a conversation.
    const byThread = new Map<number, NewMessage[]>();
    for (const m of input.messages) {
      const list = byThread.get(m.threadId) ?? [];
      list.push(m);
      byThread.set(m.threadId, list);
    }
    for (const [threadId, msgs] of byThread) {
      const first = msgs[0];
      if (!first) continue;
      const kids = first.children.length ? ` · ${first.children.join(', ')}` : '';
      out.push(`### ${first.subject}${kids}`);
      out.push('');
      out.push(`${threadUrl(threadId)}`);
      out.push('');
      for (const m of msgs) {
        const edited = m.edited ? ' · _redigeret_' : '';
        out.push(`**${m.sender}** — ${fmtOr(m.sentAt, dayTimeFmt)}${edited}`);
        out.push('');
        out.push(m.text || '_(tom besked / kun vedhæftning)_');
        out.push('');
      }
    }
  }

  // ---- opslag ----------------------------------------------------------------

  out.push(`## Opslag (${input.posts.length})`);
  out.push('');
  if (input.posts.length === 0) {
    out.push('_Ingen nye opslag._');
    out.push('');
  } else {
    for (const p of input.posts) {
      const flags: string[] = [];
      if (p.important) flags.push('**VIGTIGT**');
      if (p.editedAt) flags.push('_redigeret_');
      out.push(`### ${p.title}${flags.length ? ` — ${flags.join(' · ')}` : ''}`);
      out.push('');
      out.push(`${p.author} — ${fmtOr(p.publishedAt, dayTimeFmt)}`);
      out.push('');
      out.push(`${postUrl(p.id)}`);
      out.push('');
      out.push(p.text || '_(tomt opslag)_');
      out.push('');
    }
  }

  // ---- følsomme --------------------------------------------------------------

  if (input.stepUp.length > 0) {
    out.push(`## Følsomme beskeder (${input.stepUp.length}) — kræver MitID-login`);
    out.push('');
    for (const s of input.stepUp) {
      const kids = s.children.length ? `${s.children.join(', ')} · ` : '';
      out.push(
        `- ${kids}fra ${s.sender} · ${fmtOr(s.sentAt, dayTimeFmt)} · ` +
          `"${s.subject}" — ${threadUrl(s.threadId)}`,
      );
    }
    out.push('');
  }

  // ---- fejl ------------------------------------------------------------------

  if (input.errors.length > 0) {
    out.push(`## Fejl (${input.errors.length})`);
    out.push('');
    for (const e of input.errors) out.push(`- ${e}`);
    out.push('');
  }

  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}

/**
 * Terminal summary for interactive runs. Deliberately body-free — this is what
 * gets read over someone's shoulder.
 */
export function renderConsoleSummary(input: ArtefactInput): string {
  const lines: string[] = [];
  lines.push(`Aula-digest ${localDateKey(input.runAt)}${input.seedRun ? ' (seed)' : ''}`);
  lines.push(
    `  ${input.messages.length} nye beskeder · ${input.posts.length} nye opslag · ` +
      `${input.stepUp.length} følsomme · ${input.errors.length} fejl`,
  );
  lines.push(`  gennemgået: ${input.scannedThreads} tråde, ${input.scannedPosts} opslag`);
  for (const e of input.errors) lines.push(`  ! ${e}`);
  return lines.join('\n');
}
