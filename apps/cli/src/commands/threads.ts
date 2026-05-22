/**
 * `aula threads list-ids` — print just the (threadId, latestMessageId)
 * pairs for the most recent threads, as JSON. Cheap pre-check for
 * polling scripts: compare against a state-file `seenMessageIds`
 * list and only fire downstream classification when something is
 * actually new.
 *
 * Why not use `messaging.getThreads` through the MCP server?
 * openclaw's `/tools/invoke` HTTP surface doesn't expose
 * MCP-plugin-server tools (only the built-in operator tools like
 * `sessions_list`). So a shell-script poller can't reach
 * `aula.messages.list_threads` from outside the LLM path. A CLI
 * command sidesteps that entirely.
 *
 * `aula thread fetch <id>` (in this same file) is the diagnostic
 * sibling: it issues the raw `messaging.getMessagesForThread` call
 * and prints HTTP status + full response body verbatim, so we can
 * see what Aula actually returns for sensitive threads that come
 * back as 410. Useful when AulaApiError's 300-char `body.slice()`
 * truncates the interesting bit.
 */

import { AulaHttpClient, withFreshTokens } from '@aula-mcp/aula-auth';
import { AulaClient } from '@aula-mcp/aula-client';
import { fail, fmt, printJson } from '../io.ts';
import { defaultStore } from '../store.ts';

export interface ThreadsListIdsCommandArgs {
  pageSize?: number;
}

export interface ThreadFetchCommandArgs {
  threadId: number;
  page?: number;
}

export async function runThreadsListIds(args: ThreadsListIdsCommandArgs = {}): Promise<void> {
  const store = defaultStore();
  const http = new AulaHttpClient();
  let record: Awaited<ReturnType<typeof withFreshTokens>>;
  try {
    record = await withFreshTokens({ store, http });
  } catch (e) {
    printJson({
      ok: false,
      error: 'tokens',
      message: (e as Error).message,
      hint: `Run ${fmt.bold('aula login')} or ${fmt.bold('aula refresh-stepup')} to recover.`,
    });
    process.exit(1);
  }

  const client = new AulaClient({ tokens: record.tokens, http });
  try {
    // Prime the session: messaging endpoints 403 if the guardian profile
    // hasn't been activated. The MCP path always does this implicitly via
    // `aula.discover` → `context.getGuardianUserId()`; doctor does it via
    // its own preflight checks. A fresh-per-invocation CLI has neither, so
    // we need an explicit call before `getThreads`. One extra API hop, but
    // still no LLM cost.
    await client.getProfileContext('guardian');
    const threads = await client.getThreads({ pageSize: args.pageSize ?? 20 });
    printJson({
      ok: true,
      threads: threads.map((t) => ({
        threadId: t.id,
        latestMessageId: t.latestMessage?.id ?? null,
        read: t.read,
      })),
    });
  } catch (e) {
    printJson({
      ok: false,
      error: 'api',
      message: (e as Error).message,
    });
    fail((e as Error).message);
    process.exit(1);
  }
}

/**
 * Diagnostic: hit `messaging.getMessagesForThread` directly and print the
 * raw HTTP status + full response body. AulaClient.getMessagesForThread
 * throws on non-200, swallowing the body in a 300-char slice — fine for
 * normal error reporting, but not enough to understand a 410 on a
 * sensitive thread. This sidesteps the typed wrapper.
 *
 * Same auth path as the MCP child (withFreshTokens + silent reauth
 * inherited from the store) so the result reflects exactly what the
 * server would see.
 */
export async function runThreadFetch(args: ThreadFetchCommandArgs): Promise<void> {
  const store = defaultStore();
  const http = new AulaHttpClient();
  let record: Awaited<ReturnType<typeof withFreshTokens>>;
  try {
    record = await withFreshTokens({ store, http });
  } catch (e) {
    printJson({
      ok: false,
      error: 'tokens',
      message: (e as Error).message,
      hint: `Run ${fmt.bold('aula login')} or ${fmt.bold('aula refresh-stepup')} to recover.`,
    });
    process.exit(1);
  }

  const client = new AulaClient({ tokens: record.tokens, http });
  try {
    await client.getProfileContext('guardian');
    const version = await client.ensureApiVersion();
    const params = new URLSearchParams({
      method: 'messaging.getMessagesForThread',
      threadId: String(args.threadId),
      page: String(args.page ?? 0),
      access_token: record.tokens.access_token,
    });
    const url = `https://www.aula.dk/api/v${version}/?${params.toString()}`;
    const res = await http.request(url, { method: 'GET' });
    const headersObj: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headersObj[k] = v;
    });
    printJson({
      ok: res.status === 200,
      threadId: args.threadId,
      apiVersion: version,
      httpStatus: res.status,
      bodyLength: res.body.length,
      headers: headersObj,
      body: res.body,
    });
  } catch (e) {
    printJson({
      ok: false,
      error: 'api',
      message: (e as Error).message,
    });
    process.exit(1);
  }
}
