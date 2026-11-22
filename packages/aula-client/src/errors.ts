/**
 * Typed errors the aula-client surface throws. Subclassing AulaAuthError
 * (re-exported here under our own namespace) keeps callers' catch blocks
 * focused on the kind of failure rather than which package raised it.
 */

import { AulaAuthError, sanitizeUrl } from '@aula-mcp/aula-auth';

export class AulaClientError extends AulaAuthError {
  override readonly name: string = 'AulaClientError';
}

export class AulaApiVersionError extends AulaClientError {
  override readonly name: string = 'AulaApiVersionError';
  constructor(
    message: string,
    public readonly triedVersions: number[],
  ) {
    super(message);
  }
}

/** 403 from messaging.getMessagesForThread → user must MitID step-up. */
export class AulaStepUpRequiredError extends AulaClientError {
  override readonly name: string = 'AulaStepUpRequiredError';
}

/**
 * Aula's own reason for a failed call, from the `status` of its JSON envelope:
 * the message and sub code, cut short and reduced to plain characters. These
 * are Aula's error texts, not mailbox content. When Aula gives no message,
 * the body's shape is named instead (field names, Aula's own status code,
 * length), never its values. A body that is not JSON comes from the web
 * server in front of the API, not from a mailbox, so its words are kept, cut
 * short: an HTML page's title (or text), with long tokens such as a JWT
 * removed in case the page echoes the request URL.
 */
export function aulaReason(body: string | undefined): string {
  if (!body) return 'empty body';
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const text = errorPageText(body);
    return `not JSON, ${body.length} characters${text ? `: ${text}` : ''}`;
  }
  const keys = (v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.keys(v)
          .filter((k) => /^[A-Za-z_]{1,40}$/.test(k))
          .slice(0, 12)
          .join(' ')
      : typeof v;
  const status = (parsed as { status?: Record<string, unknown> } | null)?.status;
  if (!status || typeof status !== 'object') return `no status; fields ${keys(parsed)}`;
  const clean = (v: unknown) =>
    typeof v === 'string' || typeof v === 'number'
      ? String(v)
          .replace(/[^\p{L}\p{N} .,:;_()'-]/gu, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120)
      : '';
  const reason = [
    clean(status.message),
    status.subCode != null ? `subCode ${clean(status.subCode)}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  if (reason) return reason;
  const code = typeof status.code === 'number' ? `code ${status.code}; ` : '';
  return `no message; ${code}status fields ${keys(status)}; fields ${keys(parsed)}`;
}

/** The gist of a web server's error page, plain characters only. */
function errorPageText(body: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1];
  return (title ?? body.replace(/<[^>]*>/g, ' '))
    .replace(/[A-Za-z0-9_.~+/=-]{25,}/g, ' ')
    .replace(/[^\p{L}\p{N} .,:;_()'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** Catch-all for non-2xx responses that aren't otherwise typed. */
export class AulaApiError extends AulaClientError {
  override readonly name: string = 'AulaApiError';
  /** Sanitised on the way in. Every Aula API URL carries `?access_token=<JWT>`,
   *  and this error is surfaced to MCP clients, printed by the CLI and written
   *  to the login log — so the raw URL must never be stored here. */
  readonly url: string;
  constructor(
    message: string,
    public readonly status: number,
    url: string,
    public readonly body?: string,
  ) {
    super(message);
    this.url = sanitizeUrl(url);
  }
}
