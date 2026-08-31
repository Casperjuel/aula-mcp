import { describe, expect, test } from 'bun:test';
import { htmlToText, registerTools, slimPost, validateSetTemplateArgs } from './tools.ts';

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
