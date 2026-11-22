/**
 * Base error for everything the auth package throws.
 * Subclass for distinct failure modes that callers should branch on.
 */

import { sanitizeUrl } from './wire-tracer.ts';

export class AulaAuthError extends Error {
  override readonly name: string = 'AulaAuthError';
  override readonly cause: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.cause = options?.cause;
  }
}

export class RedirectLoopError extends AulaAuthError {
  override readonly name: string = 'RedirectLoopError';
  /** Sanitised — the URL we got stuck on may carry `?code=` or `?access_token=`,
   *  and this message ends up in the login log and in issue reports. */
  readonly lastUrl: string;
  constructor(
    public readonly hops: number,
    lastUrl: string,
  ) {
    const safeUrl = sanitizeUrl(lastUrl);
    super(`Exceeded ${hops} redirect hops; stuck at ${safeUrl}`);
    this.lastUrl = safeUrl;
  }
}

export class HtmlParseError extends AulaAuthError {
  override readonly name: string = 'HtmlParseError';
  constructor(
    message: string,
    public readonly snippet?: string,
  ) {
    super(message);
  }
}

/**
 * Aula is down for planned maintenance. During a maintenance window every
 * path on login.aula.dk (authorize.php, token.php, even the OIDC discovery
 * document) 302s to `/`, which serves a static notice with HTTP **200**:
 * "Aula bliver opdateret og er derfor ikke tilgængelig på nuværende
 * tidspunkt", linking to aulainfo.dk/driftstatus. Without this check the
 * login chain reports "unexpected host (login.aula.dk)" and refresh reports
 * "status 302", both of which read like client bugs (issue #139).
 *
 * Nothing needs fixing on the user's side: stored tokens stay valid unless
 * they expire during the window, so retrying after it is the answer.
 */
export class AulaMaintenanceError extends AulaAuthError {
  override readonly name: string = 'AulaMaintenanceError';
  constructor(context: string, options?: { cause?: unknown }) {
    super(
      `Aula is down for maintenance (${context}). Aula shows "Aula bliver opdateret og er ` +
        'derfor ikke tilgængelig". This is not an aula-mcp error. Check ' +
        'https://aulainfo.dk/driftstatus and retry once Aula is back.',
      options,
    );
  }
}

/** Text markers of Aula's maintenance notice. Any one is enough; the
 *  driftstatus link is the most stable, the sentence the most specific. */
const MAINTENANCE_MARKERS: readonly RegExp[] = [
  /aula bliver opdateret/i,
  /ikke tilgængelig på nuværende tidspunkt/i,
  /aulainfo\.dk\/driftstatus/i,
];

/** True when an HTML body is Aula's maintenance notice. */
export function isAulaMaintenancePage(body: string): boolean {
  return MAINTENANCE_MARKERS.some((re) => re.test(body));
}
