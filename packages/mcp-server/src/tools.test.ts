import { describe, expect, test } from 'bun:test';
import {
  htmlToText,
  localizeTimestamps,
  registerTools,
  slimCalendarEvents,
  slimPost,
  slimWeekPlan,
  toCopenhagenTime,
  validateSetTemplateArgs,
} from './tools.ts';

describe('validateSetTemplateArgs', () => {
  test('picked_up_by needs pickedUpBy', () => {
    expect(validateSetTemplateArgs({ activityType: 'picked_up_by' })[0]).toContain('pickedUpBy');
    expect(validateSetTemplateArgs({ activityType: 'picked_up_by', pickedUpBy: 'Far' })).toEqual(
      [],
    );
  });

  test('go_home_with needs pickedUpBy', () => {
    expect(validateSetTemplateArgs({ activityType: 'go_home_with' })[0]).toContain('pickedUpBy');
  });

  test('self_decider needs both window times', () => {
    expect(
      validateSetTemplateArgs({ activityType: 'self_decider', selfDeciderStartTime: '14:00' })[0],
    ).toContain('self_decider');
    expect(
      validateSetTemplateArgs({
        activityType: 'self_decider',
        selfDeciderStartTime: '14:00',
        selfDeciderEndTime: '16:00',
      }),
    ).toEqual([]);
  });

  test('send_home with no extra fields is fine', () => {
    expect(validateSetTemplateArgs({ activityType: 'send_home' })).toEqual([]);
  });

  test('a repeating template needs repeatUntil', () => {
    expect(validateSetTemplateArgs({ activityType: 'send_home', repeat: 'weekly' })[0]).toContain(
      'repeatUntil',
    );
    expect(
      validateSetTemplateArgs({
        activityType: 'send_home',
        repeat: 'weekly',
        repeatUntil: '2026-06-30',
      }),
    ).toEqual([]);
  });

  test('a one-off (repeat never / unset) does not need repeatUntil', () => {
    expect(validateSetTemplateArgs({ activityType: 'send_home', repeat: 'never' })).toEqual([]);
    expect(validateSetTemplateArgs({ activityType: 'send_home' })).toEqual([]);
  });
});

/**
 * aula.messages.mark_read is registered only when AULA_MCP_WRITE=1, and its
 * interesting behaviour is resolving `messageId` when the caller omits it.
 * Capture the handler off a stub McpServer rather than driving the whole
 * transport — the registration shape is all we need.
 */
describe('aula.messages.mark_read', () => {
  type ToolHandler = (args: { threadId: number; messageId?: string }) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
  }>;

  /** `pages` models Aula's 20-per-page paging: one array per page. */
  function register(pages: unknown[][]): {
    markRead: (args: { threadId: number; messageId?: string }) => Promise<Record<string, unknown>>;
    calls: Array<[number, string]>;
    pagesRequested: number[];
  } {
    const calls: Array<[number, string]> = [];
    const pagesRequested: number[] = [];
    const fakeClient = {
      async getThreadsPage({ page = 0 }: { page?: number } = {}) {
        pagesRequested.push(page);
        return {
          threads: pages[page] ?? [],
          page,
          hasMorePages: page + 1 < pages.length,
        };
      },
      async setLastReadMessage(threadId: number, messageId: string) {
        calls.push([threadId, messageId]);
        return { ok: true };
      },
    };
    const context = {
      async getClient() {
        return fakeClient;
      },
      async getGuardianUserId() {
        return '5000';
      },
    };
    let handler: ToolHandler | undefined;
    const server = {
      registerTool(name: string, _config: unknown, fn: ToolHandler) {
        if (name === 'aula.messages.mark_read') handler = fn;
      },
    };
    const previous = process.env.AULA_MCP_WRITE;
    process.env.AULA_MCP_WRITE = '1';
    try {
      // biome-ignore lint/suspicious/noExplicitAny: structural stubs for McpServer/AulaContext
      registerTools(server as any, context as any);
    } finally {
      if (previous === undefined) delete process.env.AULA_MCP_WRITE;
      else process.env.AULA_MCP_WRITE = previous;
    }
    if (!handler) throw new Error('aula.messages.mark_read was not registered');
    const registered = handler;
    return {
      async markRead(args) {
        const res = await registered(args);
        const [first] = res.content;
        if (!first) throw new Error('tool returned no content');
        return JSON.parse(first.text) as Record<string, unknown>;
      },
      calls,
      pagesRequested,
    };
  }

  test('passes an explicit messageId straight through', async () => {
    const { markRead, calls, pagesRequested } = register([]);
    const out = await markRead({ threadId: 42, messageId: '6a3d24.99' });
    expect(calls).toEqual([[42, '6a3d24.99']]);
    expect(out.ok).toBe(true);
    // An explicit id means no reason to go looking for the thread.
    expect(pagesRequested).toEqual([]);
  });

  test('resolves messageId from the thread list when omitted', async () => {
    const { markRead, calls } = register([
      [
        { id: 7, latestMessage: { id: 'aaa.1' } },
        { id: 42, latestMessage: { id: 'bbb.2' } },
      ],
    ]);
    const out = await markRead({ threadId: 42 });
    expect(calls).toEqual([[42, 'bbb.2']]);
    expect(out.messageId).toBe('bbb.2');
  });

  test('pages past the first 20 to find an older thread', async () => {
    const { markRead, calls, pagesRequested } = register([
      [{ id: 7, latestMessage: { id: 'aaa.1' } }],
      [{ id: 8, latestMessage: { id: 'bbb.2' } }],
      [{ id: 42, latestMessage: { id: 'ccc.3' } }],
    ]);
    const out = await markRead({ threadId: 42 });
    expect(pagesRequested).toEqual([0, 1, 2]);
    expect(calls).toEqual([[42, 'ccc.3']]);
    expect(out.messageId).toBe('ccc.3');
  });

  test('stops paging when Aula says there are no more pages', async () => {
    const { markRead, calls, pagesRequested } = register([
      [{ id: 7, latestMessage: { id: 'aaa.1' } }],
      [{ id: 8, latestMessage: { id: 'bbb.2' } }],
    ]);
    const out = await markRead({ threadId: 42 });
    expect(pagesRequested).toEqual([0, 1]);
    expect(calls).toEqual([]);
    expect(out.error).toBe('message_id_unresolved');
  });

  test('reports message_id_unresolved rather than writing a bogus marker', async () => {
    const { markRead, calls } = register([[{ id: 7, latestMessage: { id: 'aaa.1' } }]]);
    const out = await markRead({ threadId: 42 });
    expect(calls).toEqual([]);
    expect(out.error).toBe('message_id_unresolved');
  });

  test('is not registered without AULA_MCP_WRITE=1', () => {
    let seen = false;
    const server = {
      registerTool(name: string) {
        if (name === 'aula.messages.mark_read') seen = true;
      },
    };
    const previous = process.env.AULA_MCP_WRITE;
    delete process.env.AULA_MCP_WRITE;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: structural stub for McpServer
      registerTools(server as any, {} as any);
    } finally {
      if (previous !== undefined) process.env.AULA_MCP_WRITE = previous;
    }
    expect(seen).toBe(false);
  });
});

describe('htmlToText', () => {
  test('block-level tags become line breaks, inline markup is dropped', () => {
    expect(htmlToText('<p>Husk badetøj</p><p>og håndklæde</p>')).toBe('Husk badetøj\nog håndklæde');
    expect(htmlToText('Line one<br/>Line two')).toBe('Line one\nLine two');
    expect(htmlToText('<div><strong>Fed</strong> tekst</div>')).toBe('Fed tekst');
  });

  test('decodes the entities Aula actually emits', () => {
    expect(htmlToText('Mor &amp; far')).toBe('Mor & far');
    expect(htmlToText('a&nbsp;b')).toBe('a b');
    expect(htmlToText('&lt;ikke en tag&gt;')).toBe('<ikke en tag>');
  });

  test('collapses runs of blank lines and trims', () => {
    expect(htmlToText('<p>a</p><p></p><p></p><p>b</p>')).toBe('a\n\nb');
  });

  test('empty content is empty, not "undefined"', () => {
    expect(htmlToText('')).toBe('');
  });
});

describe('slimPost', () => {
  test('keeps the fields a reader and get_attachment need', () => {
    const slim = slimPost({
      id: 42,
      title: 'Sommerfest',
      publishAt: '2026-06-01T10:00:00+02:00',
      isImportant: true,
      content: { html: '<p>Kom glad</p>' },
      ownerProfile: {
        fullName: 'Lærer Hansen',
        institution: { institutionName: 'Klub Solsikken' },
      },
      attachments: [
        { file: { name: 'plan.pdf', url: 'https://cdn/plan.pdf', mediaType: 'application/pdf' } },
      ],
    });

    expect(slim.id).toBe(42);
    expect(slim.title).toBe('Sommerfest');
    expect(slim.date).toBe('2026-06-01T10:00:00+02:00');
    expect(slim.author).toBe('Lærer Hansen');
    // institutionName is what tells school and club apart at a glance.
    expect(slim.institution).toBe('Klub Solsikken');
    expect(slim.isImportant).toBe(true);
    expect(slim.content).toBe('Kom glad');
    expect(slim.attachments?.[0]?.url).toBe('https://cdn/plan.pdf');
  });

  test('falls back to timestamp when publishAt is absent', () => {
    expect(slimPost({ timestamp: '2026-05-05T08:00:00Z' }).date).toBe('2026-05-05T08:00:00Z');
  });

  test('omits isImportant and attachments rather than emitting empty values', () => {
    const slim = slimPost({ id: 1, content: { html: '<p>hej</p>' } });
    expect('isImportant' in slim).toBe(false);
    expect('attachments' in slim).toBe(false);
  });

  test('drops attachments with no usable URL', () => {
    const slim = slimPost({
      id: 1,
      attachments: [{ name: 'ingen-url.pdf' }, { file: { name: 'ok.pdf', url: 'https://cdn/ok' } }],
    });
    expect(slim.attachments).toHaveLength(1);
    expect(slim.attachments?.[0]?.name).toBe('ok.pdf');
  });
});

describe('slimWeekPlan', () => {
  const plan = {
    items: [{ subject: 'Dansk', content: 'x' }],
    raw: { child1: { events: Array.from({ length: 200 }, (_, i) => ({ Id: i })) } },
    warnings: ['child 2: boom'],
  };

  test('drops the vendor payload but keeps items and warnings', () => {
    expect(slimWeekPlan(plan, false)).toEqual({ items: plan.items, warnings: plan.warnings });
  });

  test('keeps it when asked to', () => {
    expect(slimWeekPlan(plan, true)).toBe(plan);
  });

  test('defaults to AULA_MCP_RAW', () => {
    const previous = process.env.AULA_MCP_RAW;
    try {
      process.env.AULA_MCP_RAW = '1';
      expect(slimWeekPlan(plan)).toBe(plan);
      delete process.env.AULA_MCP_RAW;
      expect(slimWeekPlan(plan)).not.toHaveProperty('raw');
    } finally {
      if (previous === undefined) delete process.env.AULA_MCP_RAW;
      else process.env.AULA_MCP_RAW = previous;
    }
  });
});

/** A lesson as Aula shapes it, padded with the empty/bookkeeping fields it really carries. */
function lessonEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: 'Dansk',
    type: 'lesson',
    startDateTime: '2026-09-21T06:00:00+00:00',
    endDateTime: '2026-09-21T06:45:00+00:00',
    createdDateTime: '2026-08-01T00:00:00+00:00',
    belongsToProfiles: [1, 2],
    belongsToResources: [],
    allDay: false,
    private: false,
    hasAttachments: false,
    responseRequired: false,
    responseStatus: null,
    responseDeadline: null,
    creatorName: null,
    oldStartDateTime: null,
    repeating: null,
    primaryResource: { id: 7, name: 'Lokale 12' },
    invitedGroups: [{ id: 1, name: 'Hele klassen 8E', shortName: '8E', mainGroup: true }],
    additionalResources: [],
    lesson: {
      lessonId: 'abc',
      lessonStatus: 'normal',
      hasRelevantNote: false,
      participants: [
        {
          teacherId: 1,
          teacherName: 'Anna Teacher',
          teacherInitials: 'AT',
          participantRole: 'primaryTeacher',
        },
      ],
    },
    ...overrides,
  };
}

describe('slimCalendarEvents', () => {
  test('drops empty, null and false fields, bookkeeping ids and group/resource records', () => {
    expect(slimCalendarEvents([lessonEvent()], [])).toEqual([
      {
        id: 1,
        title: 'Dansk',
        type: 'lesson',
        startDateTime: '2026-09-21T06:00:00+00:00',
        endDateTime: '2026-09-21T06:45:00+00:00',
        primaryResource: { id: 7, name: 'Lokale 12' },
        groups: ['8E'],
        lesson: { status: 'normal', teachers: ['Anna Teacher (AT)'] },
      },
    ]);
  });

  test('keeps a substitute teacher and the substitute status visible', () => {
    const [event] = slimCalendarEvents(
      [
        lessonEvent({
          lesson: {
            lessonStatus: 'substitute',
            participants: [
              {
                teacherName: 'Vera Vikar',
                teacherInitials: 'VV',
                participantRole: 'substituteTeacher',
              },
            ],
          },
        }),
      ],
      [],
    ) as Array<Record<string, unknown>>;
    expect(event?.lesson).toEqual({
      status: 'substitute',
      teachers: ['Vera Vikar (VV, substituteTeacher)'],
    });
  });

  test('keeps that a lesson has a note', () => {
    const [event] = slimCalendarEvents(
      [
        lessonEvent({
          lesson: { lessonStatus: 'normal', hasRelevantNote: true, participants: [] },
        }),
      ],
      [],
    ) as Array<Record<string, unknown>>;
    expect(event?.lesson).toEqual({ status: 'normal', hasNote: true });
  });

  test('keeps response-required, status, deadline, creator and institution for events', () => {
    const [event] = slimCalendarEvents(
      [
        lessonEvent({
          type: 'event',
          title: 'Skovtur',
          lesson: null,
          responseRequired: true,
          responseStatus: 'waiting',
          responseDeadline: '2026-09-20T00:00:00+00:00',
          creatorName: 'Test Creator',
          institutionName: 'Test School',
          hasAttachments: true,
        }),
      ],
      [],
    ) as Array<Record<string, unknown>>;
    expect(event).toMatchObject({
      type: 'event',
      responseRequired: true,
      responseStatus: 'waiting',
      responseDeadline: '2026-09-20T00:00:00+00:00',
      creatorName: 'Test Creator',
      institutionName: 'Test School',
      hasAttachments: true,
    });
    expect(event).not.toHaveProperty('lesson');
  });

  test('reduces additional resources to their display names', () => {
    const [event] = slimCalendarEvents(
      [
        lessonEvent({
          additionalResources: [
            { id: 5, name: 'ipad', displayName: 'iPad-vogn', category: { id: 1 } },
          ],
        }),
      ],
      [],
    ) as Array<Record<string, unknown>>;
    expect(event?.resources).toEqual(['iPad-vogn']);
  });

  test("time slots keep only the requested children's chosen slot, never other families' answers", () => {
    const timeSlot = {
      childRequired: false,
      timeSlots: [
        {
          id: 10,
          startDate: '2026-09-21T06:30:00+00:00',
          endDate: '2026-09-21T07:30:00+00:00',
          timeSlotIndexes: [{ startTime: 'a', endTime: 'b' }],
          answers: [
            { id: 1, instProfileId: 900, concerningProfileId: 111, selectedTimeSlotIndex: 0 },
            { id: 2, instProfileId: 901, concerningProfileId: 222, selectedTimeSlotIndex: 3 },
          ],
        },
        {
          id: 11,
          startDate: 'c',
          endDate: 'd',
          answers: [{ concerningProfileId: 333, selectedTimeSlotIndex: 0 }],
        },
      ],
    };

    const [event] = slimCalendarEvents([lessonEvent({ timeSlot })], [222]) as Array<
      Record<string, unknown>
    >;

    expect(event?.timeSlot).toEqual({
      childRequired: false,
      timeSlots: [
        {
          id: 10,
          startDate: '2026-09-21T06:30:00+00:00',
          endDate: '2026-09-21T07:30:00+00:00',
          timeSlotIndexes: [{ startTime: 'a', endTime: 'b' }],
          selectedTimeSlotIndexes: [3],
        },
        { id: 11, startDate: 'c', endDate: 'd' },
      ],
    });
    expect(JSON.stringify(event)).not.toContain('instProfileId');
  });

  test('a realistic week shrinks by an order of magnitude', () => {
    const members = Array.from({ length: 60 }, (_, i) => ({ id: i, name: `Member ${i}` }));
    const events = Array.from({ length: 90 }, (_, i) =>
      lessonEvent({ id: i, invitedGroups: [{ name: 'Klasse', shortName: '8E', members }] }),
    );
    expect(JSON.stringify(slimCalendarEvents(events, [])).length).toBeLessThan(
      JSON.stringify(events, null, 2).length / 10,
    );
  });

  test('leaves entries that are not objects untouched', () => {
    expect(slimCalendarEvents(['x', null], [])).toEqual(['x', null]);
  });
});

describe('size-limited tool results', () => {
  type Handler = (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
  }>;

  function captureTools(context: unknown): Map<string, Handler> {
    const handlers = new Map<string, Handler>();
    const server = {
      registerTool(name: string, _config: unknown, fn: Handler) {
        handlers.set(name, fn);
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: structural stubs for McpServer/AulaContext
    registerTools(server as any, context as any);
    return handlers;
  }

  const rawPlan = {
    items: [{ subject: 'Dansk', content: 'x' }],
    raw: { child1: { events: [{ Id: 1 }] } },
  };

  const context = {
    record: { username: 'demo' },
    async getGuardianUserId() {
      return '5000';
    },
    async getClient() {
      return {
        async getProfilesByLogin() {
          return { profiles: [] };
        },
        async getCalendarEvents() {
          return [lessonEvent()];
        },
      };
    },
    async getEasyIqSkoleportal() {
      return {
        async getWeekPlan() {
          return rawPlan;
        },
      };
    },
  };

  async function withRaw<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
    const previous = process.env.AULA_MCP_RAW;
    if (value === undefined) delete process.env.AULA_MCP_RAW;
    else process.env.AULA_MCP_RAW = value;
    try {
      return await fn();
    } finally {
      if (previous === undefined) delete process.env.AULA_MCP_RAW;
      else process.env.AULA_MCP_RAW = previous;
    }
  }

  async function text(name: string, args: Record<string, unknown>): Promise<string> {
    const handler = captureTools(context).get(name);
    if (!handler) throw new Error(`${name} was not registered`);
    const res = await handler(args);
    return res.content[0]?.text ?? '';
  }

  const ugeplanArgs = { childIds: [1], institutionCodes: ['D12345'] };

  test('an integration tool returns its items compactly, without the vendor payload', async () => {
    const out = await withRaw(undefined, () =>
      text('aula.ugeplan.easyiq_skoleportal', ugeplanArgs),
    );
    expect(JSON.parse(out)).toEqual({ items: rawPlan.items });
    expect(out).not.toContain('\n');
  });

  test('AULA_MCP_RAW=1 gives the integration tool its vendor payload back', async () => {
    const out = await withRaw('1', () => text('aula.ugeplan.easyiq_skoleportal', ugeplanArgs));
    expect(JSON.parse(out)).toEqual(rawPlan);
  });

  test('the calendar tool returns slimmed events compactly', async () => {
    const out = await withRaw(undefined, () =>
      text('aula.calendar.events', { profileIds: [1], range: 'this_week' }),
    );
    const [event] = JSON.parse(out) as Array<Record<string, unknown>>;
    expect(event).not.toHaveProperty('invitedGroups');
    expect(event?.groups).toEqual(['8E']);
    expect(out).not.toContain('\n');
  });

  test('the calendar tool returns Copenhagen local time, not UTC', async () => {
    const out = await withRaw(undefined, () =>
      text('aula.calendar.events', { profileIds: [1], range: 'this_week' }),
    );
    const [event] = JSON.parse(out) as Array<Record<string, unknown>>;
    // Aula sends 06:00 UTC, which is 08:00 in Copenhagen in summer.
    expect(event?.startDateTime).toBe('2026-09-21T08:00:00+02:00');
    expect(event?.endDateTime).toBe('2026-09-21T08:45:00+02:00');
  });

  test('AULA_MCP_RAW=1 gives the calendar tool its events back untouched', async () => {
    const out = await withRaw('1', () =>
      text('aula.calendar.events', { profileIds: [1], range: 'this_week' }),
    );
    expect(JSON.parse(out)).toEqual([lessonEvent()]);
  });
});

describe('toCopenhagenTime', () => {
  test.each([
    ['2026-09-21T06:00:00+00:00', '2026-09-21T08:00:00+02:00', 'summer'],
    ['2026-01-15T07:00:00Z', '2026-01-15T08:00:00+01:00', 'winter'],
    ['2026-03-29T00:59:59Z', '2026-03-29T01:59:59+01:00', 'last second before DST starts'],
    ['2026-03-29T01:00:00Z', '2026-03-29T03:00:00+02:00', 'DST starts'],
    ['2026-10-25T00:59:59Z', '2026-10-25T02:59:59+02:00', 'last second before DST ends'],
    ['2026-10-25T01:00:00Z', '2026-10-25T02:00:00+01:00', 'DST ends'],
    ['2026-09-21T06:30:00.000+00:00', '2026-09-21T08:30:00+02:00', 'fractional seconds'],
    ['2026-09-21T10:00:00+02:00', '2026-09-21T10:00:00+02:00', 'already Copenhagen time'],
    ['2026-09-21T23:30:00-05:00', '2026-09-22T06:30:00+02:00', 'another offset, date rolls over'],
  ])('%s -> %s (%s)', (input, expected) => {
    expect(toCopenhagenTime(input)).toBe(expected);
  });

  test.each([
    '2026-09-21T08:00:00', // no offset: the zone is unknown, so it is not guessed
    '2026-09-21',
    '2026-13-45T99:00:00+00:00', // looks like a timestamp but is not one
    'Dansk',
    '',
  ])('leaves %p as it is', (input) => {
    expect(toCopenhagenTime(input)).toBe(input);
  });
});

describe('localizeTimestamps', () => {
  test('converts timestamps at any depth and leaves everything else alone', () => {
    const input = {
      title: 'Skovtur',
      count: 3,
      flag: true,
      nothing: null,
      startDateTime: '2026-09-21T06:00:00+00:00',
      timeSlot: {
        timeSlots: [
          {
            id: 10,
            startDate: '2026-09-21T06:30:00+00:00',
            timeSlotIndexes: [{ startTime: '2026-09-21T06:30:00.000+00:00' }],
          },
        ],
      },
    };

    expect(localizeTimestamps(input)).toEqual({
      title: 'Skovtur',
      count: 3,
      flag: true,
      nothing: null,
      startDateTime: '2026-09-21T08:00:00+02:00',
      timeSlot: {
        timeSlots: [
          {
            id: 10,
            startDate: '2026-09-21T08:30:00+02:00',
            timeSlotIndexes: [{ startTime: '2026-09-21T08:30:00+02:00' }],
          },
        ],
      },
    });
  });

  test('does not mutate its input', () => {
    const input = { startDateTime: '2026-09-21T06:00:00+00:00' };
    localizeTimestamps(input);
    expect(input.startDateTime).toBe('2026-09-21T06:00:00+00:00');
  });
});
