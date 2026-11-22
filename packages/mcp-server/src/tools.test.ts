import { describe, expect, test } from 'bun:test';
import { TokenStoreError } from '@aula-mcp/aula-auth';
import { AulaApiError, AulaStepUpRequiredError, htmlToText } from '@aula-mcp/aula-client';
import {
  describeReadFailure,
  plainTextToHtml,
  previewMessage,
  registerTools,
  slimPost,
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
 * aula.messages.mark_read / mark_unread are on unless AULA_MCP_MARK_READ=0,
 * and their interesting behaviour is resolving ids the caller omits. Capture
 * the handlers off a stub McpServer rather than driving the whole transport —
 * the registration shape is all we need.
 */
describe('aula.messages.mark_read', () => {
  type ToolHandler = (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
  }>;
  type Stored = { kind: string; id: string; occurredAt: number | null; data: unknown };

  /** `pages` models Aula's 20-per-page paging: one array per page. */
  function register(pages: unknown[][], stored: Stored[] = []) {
    const calls: Array<[number, string]> = [];
    const unread: Array<[number[], boolean]> = [];
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
      async setThreadsRead(subscriptionIds: number[], isRead: boolean) {
        unread.push([subscriptionIds, isRead]);
        return true;
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
    const audit: Array<Record<string, unknown>> = [];
    const local = {
      async audit(entry: Record<string, unknown>) {
        audit.push(entry);
      },
      async get(kind: string, id: string) {
        return stored.find((item) => item.kind === kind && item.id === id) ?? null;
      },
      async put(items: Stored[]) {
        for (const item of items) {
          const at = stored.findIndex((s) => s.kind === item.kind && s.id === item.id);
          if (at >= 0) stored[at] = item;
        }
        return { changed: items.length };
      },
    };
    const handlers = new Map<string, ToolHandler>();
    const server = {
      registerTool(name: string, _config: unknown, fn: ToolHandler) {
        handlers.set(name, fn);
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: structural stubs for McpServer/AulaContext/ParentStorage
    registerTools(server as any, context as any, {}, { local: local as any });
    const call = (name: string) => async (args: Record<string, unknown>) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`${name} was not registered`);
      const [first] = (await handler(args)).content;
      if (!first) throw new Error('tool returned no content');
      return JSON.parse(first.text) as Record<string, unknown>;
    };
    return {
      markRead: call('aula.messages.mark_read'),
      markUnread: call('aula.messages.mark_unread'),
      calls,
      unread,
      pagesRequested,
      stored,
      audit,
    };
  }

  test('each write is in the audit log with its ids, failures with the error', async () => {
    const t = register([]);
    await t.markRead({ threadId: 7, messageId: 'm.1' });
    expect(t.audit).toEqual([
      {
        category: 'aula',
        action: 'mark_read',
        ok: true,
        durationMs: expect.any(Number),
        details: { trigger: 'tool', threadId: 7, messageId: 'm.1' },
      },
    ]);
    await t.markUnread({ threadId: 7, subscriptionId: 3 });
    expect(t.audit[1]).toMatchObject({ action: 'mark_unread', ok: true });
  });

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

  test('marks unread by subscription id, looked up when left out', async () => {
    const { markUnread, unread } = register([[{ id: 42, subscriptionId: 9001 }]]);
    const out = await markUnread({ threadId: 42 });
    expect(unread).toEqual([[[9001], false]]);
    expect(out).toMatchObject({ ok: true, subscriptionId: 9001, read: false });
    expect(await markUnread({ threadId: 42, subscriptionId: 77 })).toMatchObject({ ok: true });
    expect(unread[1]).toEqual([[77], false]);
    const missing = await markUnread({ threadId: 5 });
    expect(missing.error).toBe('subscription_id_unresolved');
    expect(unread).toHaveLength(2);
  });

  test('the stored thread follows, so the local copy agrees with Aula', async () => {
    const { markRead, markUnread, stored } = register(
      [[{ id: 42, subscriptionId: 9001, latestMessage: { id: 'bbb.2' } }]],
      [{ kind: 'message_thread', id: '42', occurredAt: 1, data: { id: 42, read: true } }],
    );
    await markUnread({ threadId: 42 });
    expect(stored[0]?.data).toEqual({ id: 42, read: false });
    await markRead({ threadId: 42 });
    expect(stored[0]?.data).toEqual({ id: 42, read: true });
    // A thread that was never stored is left alone.
    expect((await markRead({ threadId: 43, messageId: 'x.1' })).ok).toBe(true);
    expect(stored).toHaveLength(1);
  });

  test('takes the ids from the stored thread, without asking Aula for them', async () => {
    const { markRead, markUnread, calls, unread, pagesRequested, stored } = register(
      [[{ id: 42, subscriptionId: 1, latestMessage: { id: 'aula.9' } }]],
      [
        {
          kind: 'message_thread',
          id: '42',
          occurredAt: 1,
          data: {
            id: 42,
            read: false,
            subscriptionId: 9001,
            latestMessage: { id: 'stored.2' },
            // Queued from the dashboard: done with once this tool writes it.
            pendingAula: { read: true, marked: true },
          },
        },
      ],
    );
    expect(await markRead({ threadId: 42 })).toMatchObject({ ok: true, messageId: 'stored.2' });
    expect(calls).toEqual([[42, 'stored.2']]);
    expect(stored[0]?.data).toMatchObject({ read: true, pendingAula: { marked: true } });
    expect(await markUnread({ threadId: 42 })).toMatchObject({ ok: true, subscriptionId: 9001 });
    expect(unread).toEqual([[[9001], false]]);
    expect(pagesRequested).toEqual([]);
    expect(stored[0]?.data).toMatchObject({ read: false, pendingAula: { marked: true } });
  });

  test('are on by default, and off with AULA_MCP_MARK_READ=0', () => {
    const seen = (env: NodeJS.ProcessEnv) => {
      const names: string[] = [];
      // biome-ignore lint/suspicious/noExplicitAny: structural stub for McpServer
      registerTools({ registerTool: (name: string) => names.push(name) } as any, {} as any, env);
      return names.filter((n) => n.startsWith('aula.messages.mark_'));
    };
    expect(seen({})).toEqual(['aula.messages.mark_read', 'aula.messages.mark_unread']);
    expect(seen({ AULA_MCP_WRITE: '1', AULA_MCP_MARK_READ: '0' })).toEqual([]);
  });
});

describe('describeReadFailure', () => {
  test('classifies step-up, expired session, network and unknown', () => {
    expect(describeReadFailure(new AulaStepUpRequiredError('x')).error).toBe('step_up_required');
    expect(describeReadFailure(new AulaApiError('x', 401, 'https://a/b', '')).error).toBe(
      'session_expired',
    );
    const server = describeReadFailure(new AulaApiError('x', 500, 'https://a/b', ''));
    expect(server).toMatchObject({ error: 'unreadable', retryable: true });
    expect(describeReadFailure(new TypeError('fetch failed')).error).toBe('network');
    expect(describeReadFailure(new Error('boom')).error).toBe('unreadable');
  });

  test('410 is a retired API version, not an expired session', () => {
    const out = describeReadFailure(new AulaApiError('x', 410, 'https://a/b', ''));
    expect(out).toMatchObject({ error: 'unreadable', retryable: false });
  });

  test('missing tokens on disk is session_expired; other token store errors are not', () => {
    const missing = new TokenStoreError('No tokens on disk. Run `aula login` first.');
    expect(describeReadFailure(missing).error).toBe('session_expired');
    expect(describeReadFailure(new TokenStoreError('Token file is not valid JSON')).error).toBe(
      'unreadable',
    );
    expect(describeReadFailure(new Error('No tokens here')).error).toBe('unreadable');
  });

  test('never echoes raw error text for non-step-up failures', () => {
    const out = describeReadFailure(new Error('access_token=SECRET'));
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });
});

describe('previewMessage', () => {
  test('short messages come back whole', () => {
    const p = previewMessage({
      text: { html: '<p>Husk badetøj</p>' },
      sender: { fullName: 'Lærer' },
      sendDateTime: '2026-10-29T08:00:00+01:00',
    });
    expect(p.text).toBe('Husk badetøj');
    expect(p.needsSummary).toBe(false);
    expect(p.excerpt).toBeUndefined();
    expect(p.sender).toBe('Lærer');
  });

  test('long messages get an excerpt and a summarise flag, not the full text', () => {
    const long = `${'ord '.repeat(400)}slut`;
    const p = previewMessage({ text: { plain: long }, attachments: [{}] });
    expect(p.needsSummary).toBe(true);
    expect(p.text).toBeUndefined();
    expect(p.excerpt?.length).toBeLessThan(320);
    expect(p.excerpt?.endsWith('…')).toBe(true);
    expect(p.length).toBe(long.length);
    expect(p.hasAttachments).toBe(true);
  });
});

describe('aula.messages.list_threads content', () => {
  type H = (a: { includeContent?: 'unread' | 'all' | 'none' }) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
  }>;

  function run(
    getMessages: (id: number) => Promise<{ messages: unknown[] }>,
  ): (a: { includeContent?: 'unread' | 'all' | 'none' }) => Promise<Record<string, unknown>> {
    const client = {
      async getThreadsPage() {
        return {
          threads: [
            { id: 1, read: false },
            { id: 2, read: true },
          ],
          page: 0,
          hasMorePages: false,
        };
      },
      getMessagesForThread: getMessages,
    };
    const context = {
      async getClient() {
        return client;
      },
      async getGuardianUserId() {
        return '5000';
      },
    };
    let handler: H | undefined;
    const server = {
      registerTool(name: string, _c: unknown, fn: H) {
        if (name === 'aula.messages.list_threads') handler = fn;
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: structural stubs for McpServer/AulaContext
    registerTools(server as any, context as any);
    if (!handler) throw new Error('list_threads was not registered');
    const h = handler;
    return async (a) => {
      const first = (await h(a)).content[0];
      if (!first) throw new Error('no content');
      return JSON.parse(first.text) as Record<string, unknown>;
    };
  }

  test('adds the newest message to each thread and marks unreadable ones', async () => {
    const list = run(async (id) => {
      if (id === 2) throw new AulaStepUpRequiredError('step up');
      return {
        messages: [
          { text: { plain: 'gammel' }, sendDateTime: '2026-10-01' },
          { text: { plain: 'nyeste' }, sendDateTime: '2026-10-02' },
        ],
      };
    });
    const out = (await list({ includeContent: 'all' })) as {
      threads: Array<{ latest: Record<string, unknown> }>;
    };
    expect(out.threads[0]?.latest.text).toBe('nyeste');
    expect(out.threads[0]?.latest.readable).toBe(true);
    const blocked = out.threads[1] as unknown as { sensitive?: boolean; id: number };
    expect(blocked.id).toBe(2);
    expect(blocked.sensitive).toBe(true);
    expect(out.threads[1]?.latest).toMatchObject({
      readable: false,
      error: 'step_up_required',
      retryable: true,
    });
    expect(String(out.threads[1]?.latest.action)).toContain('aula login');
  });

  test('by default only unread threads are fetched', async () => {
    const fetched: number[] = [];
    const list = run(async (id) => {
      fetched.push(id);
      return { messages: [{ text: { plain: 'ny' }, sendDateTime: '2026-10-02' }] };
    });
    const out = (await list({})) as { threads: Array<Record<string, unknown>> };
    expect(fetched).toEqual([1]);
    expect(out.threads[0]?.latest).toBeDefined();
    expect(out.threads[1]?.latest).toBeUndefined();
  });

  test("includeContent: 'none' skips the per-thread fetch", async () => {
    let fetched = 0;
    const list = run(async () => {
      fetched++;
      return { messages: [] };
    });
    const out = (await list({ includeContent: 'none' })) as {
      threads: Array<Record<string, unknown>>;
    };
    expect(fetched).toBe(0);
    expect(out.threads[0]?.latest).toBeUndefined();
  });
});

describe('plainTextToHtml', () => {
  test('escapes markup and builds paragraphs and line breaks', () => {
    expect(plainTextToHtml('Hej <b>&\nTak\n\nVenlig hilsen')).toBe(
      '<p>Hej &lt;b&gt;&amp;<br>Tak</p><p>Venlig hilsen</p>',
    );
  });
});

describe('aula.messages.reply', () => {
  type Args = { threadId: number; text: string; send?: boolean };
  type Handler = (a: Args) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;

  function register(): { reply: (a: Args) => Promise<Record<string, unknown>>; sent: unknown[][] } {
    const sent: unknown[][] = [];
    const context = {
      async getClient() {
        return {
          async replyToThread(id: number, html: string) {
            sent.push([id, html]);
            return { ok: true };
          },
        };
      },
      async getGuardianUserId() {
        return '5000';
      },
    };
    let handler: Handler | undefined;
    const server = {
      registerTool(name: string, _c: unknown, fn: Handler) {
        if (name === 'aula.messages.reply') handler = fn;
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
    if (!handler) throw new Error('aula.messages.reply was not registered');
    const h = handler;
    return {
      async reply(a) {
        const first = (await h(a)).content[0];
        if (!first) throw new Error('tool returned no content');
        return JSON.parse(first.text) as Record<string, unknown>;
      },
      sent,
    };
  }

  test('without send it only previews and posts nothing', async () => {
    const { reply, sent } = register();
    const out = await reply({ threadId: 42, text: 'Tak' });
    expect(out.sent).toBe(false);
    expect(sent).toEqual([]);
  });

  test('send: true posts the HTML-encoded text', async () => {
    const { reply, sent } = register();
    const out = await reply({ threadId: 42, text: 'Tak <3', send: true });
    expect(out.sent).toBe(true);
    expect(sent).toEqual([[42, '<p>Tak &lt;3</p>']]);
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

  test('keeps webUrl when the client set one, and omits it otherwise', () => {
    expect(slimPost({ id: 1, webUrl: 'https://www.aula.dk/portal/#/overblik/1' }).webUrl).toBe(
      'https://www.aula.dk/portal/#/overblik/1',
    );
    expect('webUrl' in slimPost({ id: 1 })).toBe(false);
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
