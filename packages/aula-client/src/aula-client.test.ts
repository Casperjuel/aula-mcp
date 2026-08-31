import { describe, expect, test } from 'bun:test';
import type { AulaTokens } from '@aula-mcp/aula-auth';
import { AulaClient } from './aula-client.ts';
import { AulaApiVersionError, AulaStepUpRequiredError } from './errors.ts';
import { FakeHttp } from './test-helpers.ts';

const TOKENS: AulaTokens = {
  access_token: 'TEST_AT',
  refresh_token: 'TEST_RT',
  token_type: 'Bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  obtained_at: Math.floor(Date.now() / 1000),
};

function envelope<T>(data: T, code = 0): string {
  return JSON.stringify({ status: { code, message: 'OK' }, data });
}

function makeClient(
  http: FakeHttp,
  opts: Partial<{ initialApiVersion: number; maxApiVersion: number }> = {},
) {
  return new AulaClient({
    tokens: TOKENS,
    http: http.asHttpClient(),
    ...(opts.initialApiVersion !== undefined ? { initialApiVersion: opts.initialApiVersion } : {}),
    ...(opts.maxApiVersion !== undefined ? { maxApiVersion: opts.maxApiVersion } : {}),
  });
}

describe('AulaClient.ensureApiVersion', () => {
  test('returns the initial version when v22 already works', async () => {
    const http = new FakeHttp();
    http.enqueue({ status: 200, body: envelope({ profiles: [] }) });
    const c = makeClient(http);
    await expect(c.ensureApiVersion()).resolves.toBe(22);
  });

  test('bumps past 410 responses until it finds a working version', async () => {
    const http = new FakeHttp();
    http.enqueue(
      { status: 410, body: '' },
      { status: 410, body: '' },
      { status: 200, body: envelope({ profiles: [] }) },
    );
    const c = makeClient(http, { initialApiVersion: 22 });
    const v = await c.ensureApiVersion();
    expect(v).toBe(24);
    expect(c.currentApiVersion).toBe(24);
  });

  test('fires onApiVersionChanged callback on bump', async () => {
    const http = new FakeHttp();
    http.enqueue({ status: 410, body: '' }, { status: 200, body: envelope({ profiles: [] }) });
    const calls: Array<[number, number]> = [];
    const c = new AulaClient({
      tokens: TOKENS,
      http: http.asHttpClient(),
      onApiVersionChanged: (from, to) => calls.push([from, to]),
    });
    await c.ensureApiVersion();
    expect(calls).toEqual([[22, 23]]);
  });

  test('throws AulaApiVersionError when nothing in range works', async () => {
    const http = new FakeHttp();
    for (let i = 0; i <= 3; i++) http.enqueue({ status: 410, body: '' });
    const c = makeClient(http, { initialApiVersion: 22, maxApiVersion: 25 });
    await expect(c.ensureApiVersion()).rejects.toBeInstanceOf(AulaApiVersionError);
  });

  test('caches the verified version (no re-probe on next call)', async () => {
    const http = new FakeHttp();
    http.enqueue({ status: 200, body: envelope({ profiles: [] }) });
    const c = makeClient(http);
    await c.ensureApiVersion();
    await c.ensureApiVersion();
    // Only one probe request — no extra queued, so a second probe would throw.
    expect(http.requested.length).toBe(1);
  });
});

describe('AulaClient API method wrappers', () => {
  test('getProfilesByLogin sends access_token + method as query params', async () => {
    const http = new FakeHttp();
    // ensureApiVersion probes via profiles.getProfilesByLogin, then the
    // wrapper makes its own call — two requests in total.
    http.enqueue(
      { status: 200, body: envelope({ profiles: [] }) }, // probe
      // Field names match what Aula actually returns: profileId/displayName.
      {
        status: 200,
        body: envelope({ profiles: [{ profileId: 1, displayName: 'Casper' }] }),
      }, // actual call
    );
    const c = makeClient(http);
    const data = await c.getProfilesByLogin();
    expect(data.profiles?.[0]?.displayName).toBe('Casper');
    expect(data.profiles?.[0]?.profileId).toBe(1);
    expect(http.requested[1]?.url).toMatch(/method=profiles\.getProfilesByLogin/);
    expect(http.requested[1]?.url).toMatch(/access_token=TEST_AT/);
  });

  test('getDailyOverview repeats childIds[] for each id', async () => {
    const http = new FakeHttp();
    http.enqueue(
      { status: 200, body: envelope([]) }, // probe
      { status: 200, body: envelope([{ status: 1 }]) }, // actual call
    );
    const c = makeClient(http);
    await c.getDailyOverview([10, 20]);
    const url = http.requested[1]?.url ?? '';
    expect(url).toContain('childIds%5B%5D=10');
    expect(url).toContain('childIds%5B%5D=20');
  });

  test('getDailyOverview returns [] when given no ids without hitting the network', async () => {
    const http = new FakeHttp();
    const c = makeClient(http);
    await expect(c.getDailyOverview([])).resolves.toEqual([]);
    expect(http.requested.length).toBe(0);
  });

  test('postJson includes csrfp-token header from cookie jar', async () => {
    const http = new FakeHttp();
    http.setCookie('Csrfp-Token', 'CSRF-XYZ');
    http.enqueue(
      { status: 200, body: envelope([]) }, // probe
      { status: 200, body: envelope({}) }, // profile-context bootstrap
      { status: 200, body: envelope([]) }, // post
    );
    const c = makeClient(http);
    await c.getCalendarEvents({ profileIds: [1], start: 'a', end: 'b' });
    const post = http.requested[2];
    expect(post?.method).toBe('POST');
    expect(post?.headers?.['csrfp-token']).toBe('CSRF-XYZ');
  });

  test('postJson establishes the profile context before the first POST', async () => {
    // Aula answers 403 (envelope code 10 / subCode 23) on any POST until
    // profiles.getProfileContext has run on the session. A server that
    // restores tokens from the store has never called it, so postJson must
    // do it itself — the Csrfp-Token cookie alone is not enough.
    const http = new FakeHttp();
    http.setCookie('Csrfp-Token', 'CSRF-XYZ');
    http.enqueue(
      { status: 200, body: envelope([]) }, // probe
      { status: 200, body: envelope({}) }, // profile-context bootstrap
      { status: 200, body: envelope([]) }, // post
    );
    const c = makeClient(http);
    await c.getCalendarEvents({ profileIds: [1], start: 'a', end: 'b' });
    expect(http.requested[1]?.method).toBe('GET');
    expect(http.requested[1]?.url).toContain('method=profiles.getProfileContext');
    expect(http.requested[2]?.method).toBe('POST');
  });

  test('profile context is established only once per client', async () => {
    const http = new FakeHttp();
    http.enqueue(
      { status: 200, body: envelope([]) }, // probe
      { status: 200, body: envelope({}) }, // profile-context bootstrap
      { status: 200, body: envelope([]) }, // first post
      { status: 200, body: envelope([]) }, // second post — no re-bootstrap
    );
    const c = makeClient(http);
    await c.getCalendarEvents({ profileIds: [1], start: 'a', end: 'b' });
    await c.getCalendarEvents({ profileIds: [2], start: 'a', end: 'b' });
    const contextCalls = http.requested.filter((r) =>
      r.url.includes('method=profiles.getProfileContext'),
    );
    expect(contextCalls.length).toBe(1);
  });

  test('concurrent POSTs share a single profile-context bootstrap', async () => {
    // Two tools fired at once (an agent asking for both children's calendars)
    // must not each race past the in-flight bootstrap — that left one of them
    // POSTing before the context existed, and Aula 403'd it.
    const http = new FakeHttp();
    http.enqueue(
      { status: 200, body: envelope([]) }, // probe
      { status: 200, body: envelope({}) }, // profile-context bootstrap
      { status: 200, body: envelope([]) }, // post A
      { status: 200, body: envelope([]) }, // post B
    );
    const c = makeClient(http);
    await Promise.all([
      c.getCalendarEvents({ profileIds: [1], start: 'a', end: 'b' }),
      c.getCalendarEvents({ profileIds: [2], start: 'a', end: 'b' }),
    ]);
    const contextCalls = http.requested.filter((r) =>
      r.url.includes('method=profiles.getProfileContext'),
    );
    expect(contextCalls.length).toBe(1);
    const posts = http.requested.filter((r) => r.method === 'POST');
    expect(posts.length).toBe(2);
    // Both POSTs must come after the single bootstrap GET.
    const bootstrapIdx = http.requested.findIndex((r) =>
      r.url.includes('method=profiles.getProfileContext'),
    );
    for (const post of posts) {
      expect(http.requested.indexOf(post)).toBeGreaterThan(bootstrapIdx);
    }
  });
});

describe('AulaClient envelope handling', () => {
  test('mid-session 410 retries the call after re-probing', async () => {
    const http = new FakeHttp();
    http.enqueue(
      { status: 200, body: envelope([]) }, // probe v22 ok
      { status: 410, body: '' }, // first real call → bumped
      { status: 200, body: envelope([{ status: 1 }]) }, // re-probe v23 ok
      { status: 200, body: envelope([{ status: 1 }]) }, // retried call
    );
    const c = makeClient(http);
    await c.ensureApiVersion(); // probe runs once
    const out = await c.getDailyOverview([10]);
    expect(out).toEqual([{ status: 1 } as never]);
    expect(c.currentApiVersion).toBe(23);
  });

  test('non-zero status.code throws AulaApiError', async () => {
    const http = new FakeHttp();
    http.enqueue(
      { status: 200, body: envelope([]) }, // probe
      { status: 200, body: JSON.stringify({ status: { code: 99, message: 'broke' } }) },
    );
    const c = makeClient(http);
    await expect(c.getDailyOverview([1])).rejects.toThrow(/broke/);
  });
});

describe('AulaClient.getMessagesForThread step-up', () => {
  // getMessagesForThread calls ensureApiVersion() at the top (probe-aware,
  // same contract as the rest of the client) so each test queues a
  // version-probe response first, then the actual fetch response.

  test('throws AulaStepUpRequiredError on status.code 403', async () => {
    const http = new FakeHttp();
    http.enqueue(
      // version probe: profiles.getProfilesByLogin at v22 OK
      { status: 200, body: envelope({ profiles: [] }) },
      // actual fetch: envelope code 403 = sensitive thread
      {
        status: 200,
        body: JSON.stringify({
          status: { code: 403, message: 'sensitive thread requires step-up' },
        }),
      },
    );
    const c = makeClient(http);
    await expect(c.getMessagesForThread(123)).rejects.toBeInstanceOf(AulaStepUpRequiredError);
  });

  test('returns subject + messages when status is OK', async () => {
    const http = new FakeHttp();
    http.enqueue(
      // version probe: profiles.getProfilesByLogin at v22 OK
      { status: 200, body: envelope({ profiles: [] }) },
      // actual fetch
      {
        status: 200,
        body: envelope({
          subject: 'Skoleudflugt',
          messages: [{ text: { plain: 'hej' }, sender: { fullName: 'Anders' } }],
        }),
      },
    );
    const c = makeClient(http);
    const out = await c.getMessagesForThread(123);
    expect(out.subject).toBe('Skoleudflugt');
    expect(out.messages[0]?.sender?.fullName).toBe('Anders');
  });
});

describe('AulaClient.getThreadsPage', () => {
  test("surfaces Aula's moreMessagesExist as hasMorePages", async () => {
    const http = new FakeHttp();
    http.enqueue(
      // version probe: profiles.getProfilesByLogin at v22 OK
      { status: 200, body: envelope({ profiles: [] }) },
      {
        status: 200,
        body: envelope({ threads: [{ id: 1, read: false }], page: 0, moreMessagesExist: true }),
      },
    );
    const c = makeClient(http);
    const out = await c.getThreadsPage();
    expect(out.threads).toHaveLength(1);
    expect(out.page).toBe(0);
    expect(out.hasMorePages).toBe(true);
  });

  test('treats a missing moreMessagesExist as the last page', async () => {
    const http = new FakeHttp();
    http.enqueue(
      { status: 200, body: envelope({ profiles: [] }) },
      { status: 200, body: envelope({ threads: [] }) },
    );
    const c = makeClient(http);
    const out = await c.getThreadsPage({ page: 4 });
    expect(out.hasMorePages).toBe(false);
    // Aula echoes the page back; fall back to what we asked for when it does not.
    expect(out.page).toBe(4);
  });

  test('getThreads still returns a bare array', async () => {
    const http = new FakeHttp();
    http.enqueue(
      { status: 200, body: envelope({ profiles: [] }) },
      { status: 200, body: envelope({ threads: [{ id: 1 }, { id: 2 }], moreMessagesExist: true }) },
    );
    const c = makeClient(http);
    expect(await c.getThreads()).toHaveLength(2);
  });
});

interface PostedTemplate {
  institutionProfileId: number;
  byDate: string;
  repeatPattern: string;
  expiresAt: string | null;
  comment: string | null;
  presenceActivity: {
    activityType: number;
    pickup?: { entryTime: string | null; exitTime: string | null; exitWith: string | null };
    selfDecider?: {
      entryTime: string | null;
      exitStartTime: string | null;
      exitEndTime: string | null;
    };
    sendHome?: { entryTime: string | null; exitTime: string | null };
    goHomeWith?: { entryTime: string | null; exitTime: string | null; exitWith: string | null };
  };
}

describe('AulaClient presence templates', () => {
  test('getPresenceTemplates sends filterInstitutionProfileIds[] + the date window', async () => {
    const http = new FakeHttp();
    http.enqueue(
      { status: 200, body: envelope({ presenceWeekTemplates: [] }) }, // probe
      {
        status: 200,
        body: envelope({ presenceWeekTemplates: [{ institutionProfile: { id: 10 } }] }),
      },
    );
    const c = makeClient(http);
    const data = await c.getPresenceTemplates({
      institutionProfileIds: [10, 20],
      fromDate: '2026-05-18',
      toDate: '2026-05-24',
    });
    expect(data.presenceWeekTemplates?.[0]?.institutionProfile.id).toBe(10);
    const url = http.requested[1]?.url ?? '';
    expect(url).toContain('method=presence.getPresenceTemplates');
    expect(url).toContain('filterInstitutionProfileIds%5B%5D=10');
    expect(url).toContain('filterInstitutionProfileIds%5B%5D=20');
    expect(url).toContain('fromDate=2026-05-18');
    expect(url).toContain('toDate=2026-05-24');
  });

  test('getPresenceTemplates returns {} for empty ids without hitting the network', async () => {
    const http = new FakeHttp();
    const c = makeClient(http);
    await expect(
      c.getPresenceTemplates({ institutionProfileIds: [], fromDate: 'a', toDate: 'b' }),
    ).resolves.toEqual({});
    expect(http.requested.length).toBe(0);
  });

  test('updatePresenceTemplate (picked_up_by) posts the nested pickup block + CSRF', async () => {
    const http = new FakeHttp();
    http.setCookie('Csrfp-Token', 'CSRF-1');
    http.enqueue(
      { status: 200, body: envelope({}) }, // probe
      { status: 200, body: envelope({}) }, // profile-context bootstrap
      { status: 200, body: envelope({ id: 555 }) }, // post
    );
    const c = makeClient(http);
    await c.updatePresenceTemplate({
      institutionProfileId: 42,
      date: '2026-05-25',
      activityType: 'picked_up_by',
      entryTime: '08:00',
      exitTime: '15:30',
      pickedUpBy: 'Mormor',
    });
    const post = http.requested[2];
    expect(post?.method).toBe('POST');
    expect(post?.headers?.['csrfp-token']).toBe('CSRF-1');
    expect(post?.url).toContain('method=presence.updatePresenceTemplate');
    const body = JSON.parse(String(post?.body)) as PostedTemplate;
    expect(body.institutionProfileId).toBe(42);
    expect(body.byDate).toBe('2026-05-25');
    expect(body.repeatPattern).toBe('never');
    expect(body.expiresAt).toBeNull();
    expect(body.presenceActivity.activityType).toBe(0);
    expect(body.presenceActivity.pickup).toEqual({
      entryTime: '08:00',
      exitTime: '15:30',
      exitWith: 'Mormor',
    });
  });

  test('updatePresenceTemplate (self_decider) posts the selfDecider window', async () => {
    const http = new FakeHttp();
    http.enqueue(
      { status: 200, body: envelope({}) }, // probe
      { status: 200, body: envelope({}) }, // profile-context bootstrap
      { status: 200, body: envelope({}) }, // post
    );
    const c = makeClient(http);
    await c.updatePresenceTemplate({
      institutionProfileId: 7,
      date: '2026-05-26',
      activityType: 'self_decider',
      selfDeciderStartTime: '14:00',
      selfDeciderEndTime: '16:00',
    });
    const body = JSON.parse(String(http.requested[2]?.body)) as PostedTemplate;
    expect(body.presenceActivity.activityType).toBe(1);
    // entryTime defaults to null when the drop-off time is left unset.
    expect(body.presenceActivity.selfDecider).toEqual({
      entryTime: null,
      exitStartTime: '14:00',
      exitEndTime: '16:00',
    });
  });

  test('updatePresenceTemplate carries expiresAt only for a repeating template', async () => {
    const http = new FakeHttp();
    http.enqueue(
      { status: 200, body: envelope({}) }, // probe
      { status: 200, body: envelope({}) }, // profile-context bootstrap
      { status: 200, body: envelope({}) }, // post
    );
    const c = makeClient(http);
    await c.updatePresenceTemplate({
      institutionProfileId: 7,
      date: '2026-05-26',
      activityType: 'send_home',
      exitTime: '16:00',
      repeatPattern: 'weekly',
      repeatUntil: '2026-06-30',
    });
    const body = JSON.parse(String(http.requested[2]?.body)) as PostedTemplate;
    expect(body.repeatPattern).toBe('weekly');
    expect(body.expiresAt).toBe('2026-06-30');
    expect(body.presenceActivity.sendHome).toEqual({ entryTime: null, exitTime: '16:00' });
  });

  // The status number is the whole payload here, and it is not verifiable
  // against a live institution from CI — so pin it. A later refactor that
  // reaches for a plausible-looking constant instead of SICK=1 would
  // otherwise silently report the wrong thing to a school.
  test('updatePresenceStatus posts SICK=1 with CSRF', async () => {
    const http = new FakeHttp();
    http.setCookie('Csrfp-Token', 'CSRF-9');
    http.enqueue(
      { status: 200, body: envelope({}) }, // probe
      { status: 200, body: envelope({}) }, // profile-context bootstrap
      { status: 200, body: envelope({ ok: true }) }, // post
    );
    const c = makeClient(http);
    await c.updatePresenceStatus({ institutionProfileIds: [42], status: 1 });
    const post = http.requested[2];
    expect(post?.method).toBe('POST');
    expect(post?.headers?.['csrfp-token']).toBe('CSRF-9');
    expect(post?.url).toContain('method=presence.updateStatusByInstitutionProfileIds');
    expect(JSON.parse(String(post?.body))).toEqual({
      institutionProfileIds: [42],
      status: 1,
    });
  });

  test('updatePresenceStatus carries every id through for a multi-child call', async () => {
    const http = new FakeHttp();
    http.enqueue(
      { status: 200, body: envelope({}) }, // probe
      { status: 200, body: envelope({}) }, // profile-context bootstrap
      { status: 200, body: envelope({}) }, // post
    );
    const c = makeClient(http);
    await c.updatePresenceStatus({ institutionProfileIds: [1, 2, 3], status: 0 });
    expect(JSON.parse(String(http.requested[2]?.body))).toEqual({
      institutionProfileIds: [1, 2, 3],
      status: 0,
    });
  });
});

describe('AulaClient.getPosts', () => {
  test('scopes the feed to parent=profile and institutionProfileIds[]', async () => {
    const http = new FakeHttp();
    http.enqueue({ status: 200, body: envelope({ profiles: [] }) }); // version probe
    http.enqueue({ status: 200, body: envelope({ posts: [], moreMessagesExist: false }) });
    const c = makeClient(http);

    await c.getPosts({ institutionProfileIds: [3288873, 3288893], limit: 5 });

    const url = http.requested.at(-1)?.url ?? '';
    // Without these two the endpoint answers 200 with an empty posts array
    // rather than an error, which is what made #75 so hard to spot.
    expect(url).toContain('parent=profile');
    expect(url).toContain('institutionProfileIds%5B%5D=3288873');
    expect(url).toContain('institutionProfileIds%5B%5D=3288893');
    expect(url).toContain('limit=5');
    // index defaults to 0 rather than being omitted.
    expect(url).toContain('index=0');
  });

  test('isUnread defaults to false and follows onlyUnread when set', async () => {
    const http = new FakeHttp();
    http.enqueue({ status: 200, body: envelope({ profiles: [] }) });
    http.enqueue({ status: 200, body: envelope({ posts: [] }) });
    http.enqueue({ status: 200, body: envelope({ posts: [] }) });
    const c = makeClient(http);

    await c.getPosts({ institutionProfileIds: [1] });
    expect(http.requested.at(-1)?.url).toContain('isUnread=false');

    await c.getPosts({ institutionProfileIds: [1], onlyUnread: true });
    expect(http.requested.at(-1)?.url).toContain('isUnread=true');
  });
});
