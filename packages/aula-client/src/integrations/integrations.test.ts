/**
 * Tests for the third-party integration plugins. Each plugin transforms a
 * vendor-specific response into a NormalisedWeekPlan; tests pin both the
 * happy path and the obvious failure modes (token expiry → retry, missing
 * fields → graceful skip, per-child error → warning).
 *
 * Plugins share the WidgetTokenManager.withRetry pattern, so we use a stub
 * manager that bypasses Aula entirely and just hands the closure a token.
 */

import { describe, expect, test } from 'bun:test';
import { FakeHttp } from '../test-helpers.ts';
import type { WidgetTokenManager } from '../widget-token-manager.ts';
import { EasyIqClient } from './easyiq.ts';
import { EasyIqLektierClient } from './easyiq-lektier.ts';
import { EasyIqSkoleportalClient } from './easyiq-skoleportal.ts';
import { MeebookClient } from './meebook.ts';
import { MinUddannelseClient } from './min-uddannelse.ts';
import { SystematicClient } from './systematic.ts';
import { decodeHtmlEntities, type IntegrationContext, isoWeekString } from './types.ts';

function ctx(overrides: Partial<IntegrationContext> = {}): IntegrationContext {
  // Default childUserIds mirrors the test's childIds with a `u` prefix so
  // the two are clearly distinct; tests that need real data override.
  const childIds = overrides.childIds ?? [1234567];
  const childUserIds = overrides.childUserIds ?? childIds.map((id) => `u${id}`);
  return {
    isoWeek: isoWeekString(new Date('2026-05-04T08:00:00Z')),
    sessionId: 'cj',
    guardianId: '5000',
    childIds,
    childUserIds,
    institutionCodes: ['G12345'],
    ...overrides,
  };
}

/** Bypasses Aula — hands the closure a hard-coded token, no caching. */
function fakeWidgets(token: string = 'TKN-1'): WidgetTokenManager {
  return {
    async withRetry<T>(_widgetId: string, fn: (t: string) => Promise<T>) {
      return fn(token);
    },
    async get() {
      return token;
    },
    async refresh() {
      return token;
    },
    invalidate() {},
    invalidateAll() {},
  } as unknown as WidgetTokenManager;
}

// --------------------------------------------------------------------------
// EasyIQ (widget 0001)
// --------------------------------------------------------------------------

describe('EasyIqClient.getWeekPlan', () => {
  test('maps Events[] to NormalisedWeekPlanItem', async () => {
    const http = new FakeHttp().enqueue({
      status: 200,
      body: JSON.stringify({
        Events: [
          {
            start: '2026/05/04 08:00',
            end: '2026/05/04 09:00',
            itemType: 1,
            ownername: 'Matematik',
            description: 'Sider 12-15',
          },
          {
            start: '2026/05/04 10:00',
            itemType: 5,
            title: 'Bemærkning',
            description: 'Husk gymnastiktøj',
          },
        ],
      }),
    });
    const client = new EasyIqClient({ http: http.asHttpClient(), widgets: fakeWidgets() });
    const plan = await client.getWeekPlan(ctx());
    expect(plan.items).toHaveLength(2);
    expect(plan.items[0]).toMatchObject({
      date: '2026/05/04 08:00',
      subject: 'Matematik',
      content: 'Sider 12-15',
      kind: 'event',
    });
    // itemType 5 → "note" rather than "event"
    expect(plan.items[1]?.kind).toBe('note');
    expect(plan.items[1]?.title).toBe('Bemærkning');
  });

  test('sends required EasyIQ headers (x-aula-institutionfilter, x-aula-userprofile)', async () => {
    const http = new FakeHttp().enqueue({ status: 200, body: '{"Events":[]}' });
    const client = new EasyIqClient({ http: http.asHttpClient(), widgets: fakeWidgets() });
    await client.getWeekPlan(ctx({ institutionCodes: ['G12345', 'G99999'] }));
    const req = http.requested[0];
    expect(req?.method).toBe('POST');
    expect(req?.headers?.['x-aula-institutionfilter']).toBe('G12345,G99999');
    expect(req?.headers?.['x-aula-userprofile']).toBe('guardian');
    expect(req?.headers?.authorization).toBe('Bearer TKN-1');
  });

  test('empty Events returns no items', async () => {
    const http = new FakeHttp().enqueue({ status: 200, body: '{"Events":[]}' });
    const client = new EasyIqClient({ http: http.asHttpClient(), widgets: fakeWidgets() });
    const plan = await client.getWeekPlan(ctx());
    expect(plan.items).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// Meebook (widget 0004)
// --------------------------------------------------------------------------

describe('MeebookClient.getWeekPlan', () => {
  test('flattens person → weekPlan → tasks into normalised items', async () => {
    const http = new FakeHttp().enqueue({
      status: 200,
      body: JSON.stringify([
        {
          name: 'Emilie',
          weekPlan: [
            {
              date: 'mandag 4. maj',
              tasks: [
                {
                  type: 'task',
                  pill: 'Dansk',
                  title: 'Læseopgave',
                  content: 'Side 22',
                  editUrl: 'https://meebook.com/task/123',
                },
                {
                  type: 'comment',
                  pill: 'Matematik',
                  content: 'Husk lommeregner',
                },
              ],
            },
          ],
        },
      ]),
    });
    const client = new MeebookClient({ http: http.asHttpClient(), widgets: fakeWidgets() });
    const plan = await client.getWeekPlan(ctx());
    expect(plan.items).toHaveLength(2);
    expect(plan.items[0]).toMatchObject({
      childName: 'Emilie',
      date: 'mandag 4. maj',
      subject: 'Dansk',
      title: 'Læseopgave',
      content: 'Side 22',
      url: 'https://meebook.com/task/123',
      kind: 'task',
    });
    expect(plan.items[1]?.kind).toBe('comment');
    expect(plan.warnings).toBeUndefined();
  });

  test('per-person exceptionMessage becomes a warning, not a hard fail', async () => {
    const http = new FakeHttp().enqueue({
      status: 200,
      body: JSON.stringify([
        { name: 'Emilie', exceptionMessage: 'No data for week' },
        {
          name: 'Rasmus',
          weekPlan: [{ date: 'mandag', tasks: [{ type: 'task', title: 'X' }] }],
        },
      ]),
    });
    const client = new MeebookClient({ http: http.asHttpClient(), widgets: fakeWidgets() });
    const plan = await client.getWeekPlan(ctx());
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.childName).toBe('Rasmus');
    expect(plan.warnings).toEqual(['Emilie: No data for week']);
  });

  test('sends sessionuuid header from ctx.sessionId', async () => {
    const http = new FakeHttp().enqueue({ status: 200, body: '[]' });
    const client = new MeebookClient({ http: http.asHttpClient(), widgets: fakeWidgets() });
    await client.getWeekPlan(ctx());
    expect(http.requested[0]?.headers?.sessionuuid).toBe('cj');
    expect(http.requested[0]?.headers?.['x-version']).toBe('1.0');
  });
});

// --------------------------------------------------------------------------
// Min Uddannelse (widgets 0029 + 0030)
// --------------------------------------------------------------------------

describe('MinUddannelseClient.getOpgaver', () => {
  test('maps opgaver[] into normalised items with subject = joined hold names', async () => {
    const http = new FakeHttp().enqueue({
      status: 200,
      body: JSON.stringify({
        opgaver: [
          {
            kuvertnavn: 'Emilie',
            title: 'Aflever opgave',
            ugedag: 'mandag',
            opgaveType: 'aflevering',
            hold: [{ name: 'Dansk' }, { name: 'Tværfagligt' }],
            forloeb: { navn: 'Læseuge' },
          },
        ],
      }),
    });
    const client = new MinUddannelseClient({ http: http.asHttpClient(), widgets: fakeWidgets() });
    const plan = await client.getOpgaver(ctx());
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      childName: 'Emilie',
      title: 'Aflever opgave',
      date: 'mandag',
      subject: 'Dansk, Tværfagligt',
      content: 'Læseuge',
      kind: 'aflevering',
    });
  });

  test('getUgebrev maps personer → institutioner → ugebreve to one item per letter', async () => {
    const http = new FakeHttp().enqueue({
      status: 200,
      body: JSON.stringify({
        personer: [
          {
            navn: 'Emilie',
            institutioner: [
              {
                ugebreve: [
                  { indhold: '<p>Hej forældre, denne uge har vi…</p>' },
                  { indhold: '<p>Anden ugebrev fra samme institution</p>' },
                ],
              },
            ],
          },
        ],
      }),
    });
    const client = new MinUddannelseClient({ http: http.asHttpClient(), widgets: fakeWidgets() });
    const plan = await client.getUgebrev(ctx());
    expect(plan.items).toHaveLength(2);
    expect(plan.items[0]?.kind).toBe('ugebrev');
    expect(plan.items[0]?.childName).toBe('Emilie');
    expect(plan.items[0]?.content).toContain('Hej forældre');
  });

  test('sends Authorization Bearer + childFilter csv', async () => {
    const http = new FakeHttp().enqueue({ status: 200, body: '{"opgaver":[]}' });
    const client = new MinUddannelseClient({ http: http.asHttpClient(), widgets: fakeWidgets() });
    await client.getOpgaver(ctx({ childIds: [10, 20, 30] }));
    const url = http.requested[0]?.url ?? '';
    expect(url).toContain('childFilter=10%2C20%2C30');
    expect(url).toContain('userProfile=guardian');
    expect(http.requested[0]?.headers?.authorization).toBe('Bearer TKN-1');
  });
});

// --------------------------------------------------------------------------
// Systematic / Huskelisten (widget 0062)
// --------------------------------------------------------------------------

describe('SystematicClient.getReminders', () => {
  test('flattens team / course / assignment reminders per person, tagging the kind', async () => {
    const http = new FakeHttp().enqueue({
      status: 200,
      body: JSON.stringify([
        {
          userName: 'Emilie',
          userId: 1234,
          teamReminders: [
            {
              dueDate: '2026-05-08T12:00:00Z',
              subjectName: 'Matematik',
              teamName: '5A Matematik',
              reminderText: 'Læs s. 30-35',
            },
          ],
          assignmentReminders: [
            {
              dueDate: '2026-05-10T12:00:00Z',
              subjectName: 'Dansk',
              teamName: 'Læseopgave',
              reminderText: 'Læs kapitel 5',
            },
          ],
        },
      ]),
    });
    const client = new SystematicClient({ http: http.asHttpClient(), widgets: fakeWidgets() });
    const plan = await client.getReminders(ctx());
    expect(plan.items).toHaveLength(2);
    expect(plan.items[0]?.kind).toBe('huskelisten:team');
    expect(plan.items[1]?.kind).toBe('huskelisten:assignment');
    expect(plan.items[0]?.childName).toBe('Emilie');
  });

  test('uses the unusual Aula-Authorization header (not Authorization)', async () => {
    const http = new FakeHttp().enqueue({ status: 200, body: '[]' });
    const client = new SystematicClient({ http: http.asHttpClient(), widgets: fakeWidgets() });
    await client.getReminders(ctx());
    const headers = http.requested[0]?.headers;
    expect(headers?.['aula-authorization']).toBe('Bearer TKN-1');
    expect(headers?.authorization).toBeUndefined();
    expect(headers?.zone).toBe('Europe/Copenhagen');
  });

  test('respects fromDate / toDate when provided', async () => {
    const http = new FakeHttp().enqueue({ status: 200, body: '[]' });
    const client = new SystematicClient({ http: http.asHttpClient(), widgets: fakeWidgets() });
    await client.getReminders(ctx({ fromDate: '2026-05-01', toDate: '2026-05-31' }));
    const url = http.requested[0]?.url ?? '';
    expect(url).toContain('from=2026-05-01');
    expect(url).toContain('dueNoLaterThan=2026-05-31');
  });
});

// --------------------------------------------------------------------------
// EasyIQ SkolePortal (widget 0128)
// --------------------------------------------------------------------------

describe('EasyIqSkoleportalClient.getWeekPlan', () => {
  test('per-child auth + events + Danish-entity decode', async () => {
    const http = new FakeHttp().enqueue(
      // Auth response for child 1234567
      {
        status: 200,
        body: JSON.stringify({
          loginId: 'LOGIN-A',
          child: '1234567',
          childName: 'Emilie F&aelig;rgemand',
          schoolName: 'Demo Skole',
          schoolId: 'D12345',
        }),
      },
      // Events for that loginId
      {
        status: 200,
        body: JSON.stringify([
          {
            StartTime: '2026/05/04 08:00',
            StartTimeISO: '2026-05-04T08:00:00+02:00',
            EndTime: '2026/05/04 08:45',
            CoursesDisplay: 'Matematik',
            ActivitiesDisplay: '4D',
            ChapterTitle: 'Decimaltal',
            Description: 'Vi har arbejdet med s. 85',
          },
        ]),
      },
    );
    const client = new EasyIqSkoleportalClient({
      http: http.asHttpClient(),
      widgets: fakeWidgets(),
    });
    const plan = await client.getWeekPlan(ctx());
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      childName: 'Emilie Færgemand', // entity decoded
      date: '2026-05-04T08:00:00+02:00',
      subject: 'Matematik / 4D',
      title: 'Decimaltal',
      content: 'Vi har arbejdet med s. 85',
      kind: 'event',
    });
  });

  test('per-child failure surfaces as warning; other children still succeed', async () => {
    const http = new FakeHttp().enqueue(
      // child 1: auth fails (401-style)
      { status: 401, body: 'Unauthorized' },
      // child 2: auth ok
      {
        status: 200,
        body: JSON.stringify({ loginId: 'LOGIN-B', childName: 'Rasmus' }),
      },
      // child 2: events
      {
        status: 200,
        body: JSON.stringify([{ StartTime: '2026/05/04 09:00', CoursesDisplay: 'Engelsk' }]),
      },
    );
    const client = new EasyIqSkoleportalClient({
      http: http.asHttpClient(),
      widgets: fakeWidgets(),
    });
    const plan = await client.getWeekPlan(ctx({ childIds: [1, 2] }));
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.childName).toBe('Rasmus');
    expect(plan.warnings).toBeDefined();
    expect(plan.warnings?.[0]).toContain('child 1');
  });

  test('passes x-childfilter / x-institutionfilter / x-login per child', async () => {
    const http = new FakeHttp().enqueue(
      { status: 200, body: JSON.stringify({ loginId: 'LOGIN', childName: 'X' }) },
      { status: 200, body: '[]' },
    );
    const client = new EasyIqSkoleportalClient({
      http: http.asHttpClient(),
      widgets: fakeWidgets(),
    });
    await client.getWeekPlan(
      ctx({
        childIds: [42],
        childUserIds: ['abcd1234'],
        institutionCodes: ['G42', 'G99'],
      }),
    );
    const auth = http.requested[0];
    // x-childfilter is the per-child userId token, NOT the numeric child id —
    // SkolePortal 302→/Login on the wrong filter (PR scaarup/aula#352).
    expect(auth?.headers?.['x-childfilter']).toBe('abcd1234');
    expect(auth?.headers?.['x-institutionfilter']).toBe('G42,G99');
    expect(auth?.headers?.['x-login']).toBe('cj');
    // Authorization includes the literal `Bearer ` prefix. Aula's widget
    // token endpoint returns the raw JWT — we add the prefix; PR #352's
    // Python adds it inside `get_token` so the wire shape matches.
    expect(auth?.headers?.['authorization']).toBe('Bearer TKN-1');
    const events = http.requested[1];
    expect(events?.url).toContain('loginId=LOGIN');
  });
});

// --------------------------------------------------------------------------
// EasyIQ Lektier (widget 0142)
// --------------------------------------------------------------------------

describe('EasyIqLektierClient.getLektier', () => {
  test('auth + GetChildren + per-child events; maps to NormalisedWeekPlanItem', async () => {
    const http = new FakeHttp().enqueue(
      // 1. Auth — session loginId, ignored
      {
        status: 200,
        body: JSON.stringify({
          loginId: 9999,
          loginTypeId: 10,
          child: 'u1234567',
          childName: 'Emilie Færgemand',
          schoolName: 'Demo Skole',
          schoolId: 'D12345',
        }),
      },
      // 2. GetChildren — per-child Ids keyed by Login (the userId token)
      {
        status: 200,
        body: JSON.stringify({
          Children: [
            { Id: 3113339, Login: 'u1234567', Name: 'Emilie Færgemand' },
            { Id: 3053244, Login: 'u9876543', Name: 'Rasmus Færgemand' },
          ],
        }),
      },
      // 3. Lektier for u1234567
      {
        status: 200,
        body: JSON.stringify([
          {
            Id: 15529081,
            StartTime: '2026/05/13 08:00',
            StartTimeISO: '2026-05-13T08:00:00.0000000',
            CoursesDisplay: 'Matematik',
            ActivitiesDisplay: '1A',
            Title: ' ',
            ChapterTitle: null,
            Description: 'Aflevering af matematikh&aelig;fte med lektier.',
          },
        ]),
      },
      // 4. Lektier for u9876543 — empty
      { status: 200, body: '[]' },
    );
    const client = new EasyIqLektierClient({ http: http.asHttpClient(), widgets: fakeWidgets() });
    const plan = await client.getLektier(
      ctx({ childIds: [1234567, 9876543], childUserIds: ['u1234567', 'u9876543'] }),
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      childName: 'Emilie Færgemand',
      date: '2026-05-13T08:00:00.0000000',
      subject: 'Matematik / 1A',
      // Description's `&aelig;` decoded.
      content: expect.stringContaining('matematikhæfte'),
      kind: 'lektier',
    });
    // Title is whitespace-only ⇒ skipped (not set).
    expect(plan.items[0]?.title).toBeUndefined();
    expect(plan.warnings).toBeUndefined();
  });

  test('queries `/Aula/GetChildren` between auth and the per-child fetch', async () => {
    const http = new FakeHttp().enqueue(
      { status: 200, body: JSON.stringify({ loginId: 'session-id' }) },
      { status: 200, body: JSON.stringify({ Children: [{ Id: 1, Login: 'u1' }] }) },
      { status: 200, body: '[]' },
    );
    const client = new EasyIqLektierClient({ http: http.asHttpClient(), widgets: fakeWidgets() });
    await client.getLektier(ctx({ childIds: [1], childUserIds: ['u1'] }));
    expect(http.requested[0]?.url).toContain('/Aula/AuthenticateAulaUser');
    expect(http.requested[1]?.url).toContain('/Aula/GetChildren');
    expect(http.requested[2]?.url).toContain('/AulaHuskeliste/GetWeekplanEvents');
    // Per-child loginId from GetChildren feeds the events query as `loginId=1`.
    expect(http.requested[2]?.url).toContain('loginId=1');
    // activityFilter is sent as the literal string `null`.
    expect(http.requested[2]?.url).toContain('activityFilter=null');
  });

  test('child missing from GetChildren response surfaces as a warning', async () => {
    const http = new FakeHttp().enqueue(
      { status: 200, body: JSON.stringify({ loginId: 'session-id' }) },
      // GetChildren returns only u1; we ask for u1 + u2.
      { status: 200, body: JSON.stringify({ Children: [{ Id: 1, Login: 'u1', Name: 'A' }] }) },
      { status: 200, body: JSON.stringify([{ StartTime: '2026/05/04', CoursesDisplay: 'Dansk' }]) },
    );
    const client = new EasyIqLektierClient({ http: http.asHttpClient(), widgets: fakeWidgets() });
    const plan = await client.getLektier(ctx({ childIds: [1, 2], childUserIds: ['u1', 'u2'] }));
    expect(plan.items).toHaveLength(1);
    expect(plan.warnings).toBeDefined();
    expect(plan.warnings?.[0]).toContain('child 2');
    expect(plan.warnings?.[0]).toContain('GetChildren');
  });

  test('per-child Lektier fetch error surfaces as warning; other children still succeed', async () => {
    const http = new FakeHttp().enqueue(
      { status: 200, body: JSON.stringify({ loginId: 'session-id' }) },
      {
        status: 200,
        body: JSON.stringify({
          Children: [
            { Id: 1, Login: 'u1', Name: 'A' },
            { Id: 2, Login: 'u2', Name: 'B' },
          ],
        }),
      },
      // u1: 500
      { status: 500, body: 'oops' },
      // u2: ok
      { status: 200, body: JSON.stringify([{ StartTime: '2026/05/04', CoursesDisplay: 'Dansk' }]) },
    );
    const client = new EasyIqLektierClient({ http: http.asHttpClient(), widgets: fakeWidgets() });
    const plan = await client.getLektier(ctx({ childIds: [1, 2], childUserIds: ['u1', 'u2'] }));
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.childName).toBe('B');
    expect(plan.warnings?.[0]).toContain('child 1');
  });

  test('passes the Lektier-specific headers (referer, x-child, x-childfilter)', async () => {
    const http = new FakeHttp().enqueue(
      { status: 200, body: JSON.stringify({ loginId: 'session-id' }) },
      { status: 200, body: JSON.stringify({ Children: [{ Id: 99, Login: 'abcd1234' }] }) },
      { status: 200, body: '[]' },
    );
    const client = new EasyIqLektierClient({ http: http.asHttpClient(), widgets: fakeWidgets() });
    await client.getLektier(
      ctx({
        childIds: [42],
        childUserIds: ['abcd1234'],
        institutionCodes: ['G42', 'G99'],
        guardianId: 'dema9876',
      }),
    );
    const auth = http.requested[0];
    // Lektier referer = /LektierWidget (NOT /UgeplanWidget).
    expect(auth?.headers?.['referer']).toBe('https://skoleportal.easyiqcloud.dk/LektierWidget');
    // x-child = the child being acted on; x-childfilter = csv of all kids.
    expect(auth?.headers?.['x-child']).toBe('abcd1234');
    expect(auth?.headers?.['x-childfilter']).toBe('abcd1234');
    expect(auth?.headers?.['x-institutionfilter']).toBe('G42,G99');
    // x-login is the Aula guardianId, not the MitID username — confirmed
    // against a captured browser request (the real wire format).
    expect(auth?.headers?.['x-login']).toBe('dema9876');
    expect(auth?.headers?.['authorization']).toBe('Bearer TKN-1');
  });
});

// --------------------------------------------------------------------------
// decodeHtmlEntities (used by SkolePortal but also exported standalone)
// --------------------------------------------------------------------------

describe('decodeHtmlEntities', () => {
  test('decodes Danish-specific entities', () => {
    expect(decodeHtmlEntities('F&aelig;rgemand &Oslash;sterg&aring;rd')).toBe(
      'Færgemand Østergård',
    );
  });

  test('decodes the standard five', () => {
    expect(decodeHtmlEntities('&amp;&lt;&gt;&quot;&apos;')).toBe('&<>"\'');
  });

  test('decodes numeric entities', () => {
    expect(decodeHtmlEntities('&#8364;&#x20AC;')).toBe('€€');
  });

  test('leaves unrelated text alone', () => {
    expect(decodeHtmlEntities('hello world')).toBe('hello world');
  });
});
