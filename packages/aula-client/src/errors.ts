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
 * are Aula's error texts, not mailbox content. Empty when the body is not
 * such an envelope.
 */
export function aulaReason(body: string | undefined): string {
  if (!body) return '';
  let status: Record<string, unknown> | undefined;
  try {
    status = (JSON.parse(body) as { status?: Record<string, unknown> })?.status;
  } catch {
    return '';
  }
  if (!status || typeof status !== 'object') return '';
  const clean = (v: unknown) =>
    typeof v === 'string' || typeof v === 'number'
      ? String(v)
          .replace(/[^\p{L}\p{N} .,:;_()'-]/gu, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120)
      : '';
  return [clean(status.message), status.subCode != null ? `subCode ${clean(status.subCode)}` : '']
    .filter(Boolean)
    .join(', ');
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
