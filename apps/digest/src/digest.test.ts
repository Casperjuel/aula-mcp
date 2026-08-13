/**
 * Tests for the digest's pure logic. No network, no Aula, no clock dependence.
 *
 * These cover the three things that would silently corrupt the digest if they
 * broke: outcome classification (a fault must never read as success), the
 * dedup ring buffer, and Copenhagen date handling across a DST boundary.
 */
import { describe, expect, test } from 'bun:test';
import { htmlToText, isContentMessage, type NewMessage, selectFreshMessages } from './aula.ts';
import { localDateKey, renderArtefact } from './render.ts';
import { decideOutcome } from './runlog.ts';
import { emptyState, hasSeenMessage, rememberMessage } from './state.ts';

function msg(over: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'm1',
    threadId: 1,
    subject: 'Emne',
    sender: 'Lærer Hansen',
    sentAt: '2026-08-13T14:02:00+02:00',
    text: 'Husk gummistøvler på fredag.',
    children: ['Esther'],
    type: 'Message',
    edited: false,
    ...over,
  };
}

describe('htmlToText', () => {
  test('strips tags and decodes the entities Aula actually emits', () => {
    expect(htmlToText('<p>Hej &amp; farvel</p>')).toBe('Hej & farvel');
    expect(htmlToText('a<br>b')).toBe('a\nb');
    expect(htmlToText('<ul><li>et</li><li>to</li></ul>')).toBe('• et\n• to');
    expect(htmlToText('&lt;ikke tag&gt;')).toBe('<ikke tag>');
    expect(htmlToText('&nbsp;x&nbsp;')).toBe('x');
  });

  test('collapses runaway blank lines rather than padding the digest', () => {
    expect(htmlToText('<p>a</p><p></p><p></p><p>b</p>')).toBe('a\n\nb');
  });

  test('undefined and empty are safe', () => {
    expect(htmlToText(undefined)).toBe('');
    expect(htmlToText('')).toBe('');
  });
});

describe('isContentMessage', () => {
  test('keeps real messages, including edited ones', () => {
    expect(isContentMessage(msg({ type: 'Message' }))).toBe(true);
    expect(isContentMessage(msg({ type: 'MessageEdited' }))).toBe(true);
  });

  test('drops Aula membership bookkeeping', () => {
    // 30 of 169 messages on a live account were these. They carry no body.
    expect(isContentMessage(msg({ type: 'RecipientsRemoved' }))).toBe(false);
    expect(isContentMessage(msg({ type: 'RecipientsAdded' }))).toBe(false);
  });
});

describe('selectFreshMessages', () => {
  // NEWEST-FIRST, as Aula actually returns them. Verified against a live
  // account: 5 of 6 threads strictly descending, the 6th only non-monotonic
  // because an edited message keeps its slot while its timestamp moves.
  const thread = [
    { id: 'd', sendDateTime: '2026-08-13T09:00:00+02:00' },
    { id: 'c', sendDateTime: '2026-08-12T09:00:00+02:00' },
    { id: 'b', sendDateTime: '2026-08-11T09:00:00+02:00' },
    { id: 'a', sendDateTime: '2026-08-10T09:00:00+02:00' },
  ];

  test('a brand new thread yields every message, oldest-first for reading', () => {
    expect(selectFreshMessages(thread, undefined, undefined).map((m) => m.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  test('takes exactly the messages NEWER than the pointer', () => {
    expect(selectFreshMessages(thread, 'b', undefined).map((m) => m.id)).toEqual(['c', 'd']);
  });

  test('an up-to-date pointer yields nothing', () => {
    expect(selectFreshMessages(thread, 'd', undefined)).toEqual([]);
  });

  // Regression guard for the ordering bug: if the slice direction is flipped,
  // pointing at the newest message returns the entire back catalogue instead
  // of nothing, and the thread re-reports every single day.
  test('the newest pointer must not return older messages', () => {
    const got = selectFreshMessages(thread, 'd', undefined);
    expect(got.map((m) => m.id)).not.toContain('a');
    expect(got).toHaveLength(0);
  });

  // The dangerous path: pointer gone (deleted message, or Aula returned only a
  // window of a long thread). Must NOT fall back to "report the whole thread".
  test('a missing pointer falls back to the timestamp, not to everything', () => {
    const got = selectFreshMessages(thread, 'deleted-id', '2026-08-11T12:00:00+02:00');
    expect(got.map((m) => m.id)).toEqual(['c', 'd']);
  });

  test('a missing pointer with no timestamp reports nothing rather than flooding', () => {
    expect(selectFreshMessages(thread, 'deleted-id', undefined)).toEqual([]);
    expect(selectFreshMessages(thread, 'deleted-id', 'not-a-date')).toEqual([]);
  });

  test('timestamp fallback is an instant comparison, so DST cannot skew it', () => {
    // Same instant expressed in two offsets must select identically.
    const utc = selectFreshMessages(thread, 'gone', '2026-08-11T07:00:00Z');
    const cest = selectFreshMessages(thread, 'gone', '2026-08-11T09:00:00+02:00');
    expect(utc.map((m) => m.id)).toEqual(cest.map((m) => m.id));
    expect(utc.map((m) => m.id)).toEqual(['c', 'd']);
  });
});

describe('decideOutcome', () => {
  test('nothing new is a noop', () => {
    expect(decideOutcome({ errors: [], hadContent: false, delivered: true })).toEqual({
      outcome: 'noop',
      reason: 'nothing_new',
    });
  });

  test('content delivered cleanly is ok', () => {
    expect(decideOutcome({ errors: [], hadContent: true, delivered: true }).outcome).toBe('ok');
  });

  // The house rule. Silence in Slack is fine; silence in the log is not.
  test('errors are NEVER reported as ok or noop', () => {
    for (const hadContent of [true, false]) {
      const { outcome } = decideOutcome({
        errors: ['thread 1: boom'],
        hadContent,
        delivered: true,
      });
      expect(outcome).toBe('partial');
      expect(outcome).not.toBe('ok');
      expect(outcome).not.toBe('noop');
    }
  });

  test('dead auth outranks everything else', () => {
    expect(
      decideOutcome({ errors: [], hadContent: false, delivered: true, authDead: true }),
    ).toEqual({ outcome: 'error', reason: 'auth_dead' });
  });

  test('failed delivery is an error even with no fetch errors', () => {
    expect(decideOutcome({ errors: [], hadContent: true, delivered: false }).outcome).toBe('error');
  });
});

describe('seenMessageIds ring buffer', () => {
  test('remembers and recognises', () => {
    const s = emptyState();
    expect(hasSeenMessage(s, 'a')).toBe(false);
    rememberMessage(s, 'a');
    expect(hasSeenMessage(s, 'a')).toBe(true);
  });

  test('does not duplicate', () => {
    const s = emptyState();
    rememberMessage(s, 'a');
    rememberMessage(s, 'a');
    expect(s.seenMessageIds).toEqual(['a']);
  });

  test('caps at 500 and evicts the oldest first', () => {
    const s = emptyState();
    for (let i = 0; i < 600; i++) rememberMessage(s, `id-${i}`);
    expect(s.seenMessageIds.length).toBe(500);
    expect(hasSeenMessage(s, 'id-599')).toBe(true); // newest kept
    expect(hasSeenMessage(s, 'id-0')).toBe(false); // oldest evicted
  });

  test('handles Aula ids, which are opaque strings not numbers', () => {
    const s = emptyState();
    rememberMessage(s, '69e51332b904f5.65928833');
    expect(hasSeenMessage(s, '69e51332b904f5.65928833')).toBe(true);
  });
});

describe('localDateKey', () => {
  test('uses Copenhagen time, not UTC', () => {
    // 22:30 UTC on 12 Aug is already 00:30 on 13 Aug in Copenhagen (CEST).
    expect(localDateKey(new Date('2026-08-12T22:30:00Z'))).toBe('2026-08-13');
  });

  test('survives the October DST fallback', () => {
    // 2026-10-25 02:30 CEST and 02:30 CET are different instants, same date.
    expect(localDateKey(new Date('2026-10-25T00:30:00Z'))).toBe('2026-10-25');
    expect(localDateKey(new Date('2026-10-25T01:30:00Z'))).toBe('2026-10-25');
  });
});

describe('renderArtefact', () => {
  const base = {
    runAt: new Date('2026-08-13T16:45:00+02:00'),
    seedRun: false,
    messages: [],
    stepUp: [],
    posts: [],
    scannedThreads: 20,
    scannedPosts: 20,
    errors: [],
  };

  test('groups several messages of one thread under a single heading', () => {
    const md = renderArtefact({
      ...base,
      messages: [msg({ id: 'a' }), msg({ id: 'b', sender: 'Anden Lærer' })],
    });
    expect(md.match(/^### /gm)?.length).toBe(1);
    expect(md).toContain('Lærer Hansen');
    expect(md).toContain('Anden Lærer');
    expect(md).toContain('https://www.aula.dk/portal/#/beskeder/1');
  });

  test('marks edited messages so a changed time is visible', () => {
    expect(renderArtefact({ ...base, messages: [msg({ edited: true })] })).toContain('_redigeret_');
  });

  test('sensitive threads get a section built from metadata only', () => {
    const md = renderArtefact({
      ...base,
      stepUp: [
        {
          threadId: 48213,
          subject: 'Opfølgning',
          sender: 'skolesundhedsplejersken',
          sentAt: '2026-08-13T14:02:00+02:00',
          children: ['Emil'],
        },
      ],
    });
    expect(md).toContain('Følsomme beskeder (1)');
    expect(md).toContain('MitID');
    expect(md).toContain('Opfølgning');
  });

  test('errors are surfaced in the artefact, never swallowed', () => {
    const md = renderArtefact({ ...base, errors: ['thread 9: HTTP 500'] });
    expect(md).toContain('## Fejl (1)');
    expect(md).toContain('thread 9: HTTP 500');
  });

  test('an empty day still renders valid, explicit markdown', () => {
    const md = renderArtefact(base);
    expect(md).toContain('_Ingen nye beskeder._');
    expect(md).toContain('_Ingen nye opslag._');
    expect(md).not.toContain('undefined');
  });

  test('seed runs are labelled so the artefact explains itself later', () => {
    expect(renderArtefact({ ...base, seedRun: true, messages: [msg()] })).toContain(
      'Første kørsel',
    );
  });
});
