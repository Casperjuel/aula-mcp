/**
 * Walk the redirect/SAML chain that connects Aula's OAuth start to MitID and
 * back. Pure functions where possible (parsers, URL builders), so the
 * surprises in upstream issues #310 / #306 / #287 are testable.
 *
 * Critical bake-ins from upstream Python issues:
 *   - #310: the final SAML form may be missing `RelayState` (Level 3 flow).
 *           We now treat it as optional and pass an empty string downstream.
 *   - #306, #287: `post-broker-login` sometimes returns 200 with a "confirm
 *           continue" form (button id="confirmation-button") instead of the
 *           expected 302. We detect and submit the confirmation form.
 */

import * as cheerio from 'cheerio';
import { AulaAuthError } from './errors.ts';
import { extractAttr, extractFormAction, extractHiddenInputs, extractText } from './html.ts';

export class AulaSamlError extends AulaAuthError {
  override readonly name: string = 'AulaSamlError';
  /** Snippet of the offending HTML — handy for debugging mismatched parsers. */
  readonly htmlSnippet?: string;
  constructor(message: string, options?: { cause?: unknown; htmlSnippet?: string }) {
    super(message, options);
    if (options?.htmlSnippet !== undefined) this.htmlSnippet = options.htmlSnippet;
  }
}

/**
 * On the broker IdP-selection page we look for the form and fill in
 * `selectedIdp=nemlogin3`. The Python reference brute-forces several
 * (selector, value) combinations; we stick to the one that's worked for years
 * and let callers override if MitID renames it.
 */
export interface BrokerFormData {
  /** Where to POST. */
  action: string;
  /** All hidden inputs from the form. */
  data: Record<string, string>;
}

export function parseBrokerIdpForm(
  html: string,
  options: { idpField?: string; idpValue?: string } = {},
): BrokerFormData {
  const action = extractFormAction(html);
  if (!action) {
    throw new AulaSamlError('Broker IdP page has no form', { htmlSnippet: html.slice(0, 500) });
  }
  const fields = extractHiddenInputs(html);
  fields[options.idpField ?? 'selectedIdp'] = options.idpValue ?? 'nemlogin3';
  return { action, data: fields };
}

/** The `__RequestVerificationToken` injected in MitID pages. */
export function parseMitidVerificationToken(html: string): string {
  const inputs = extractHiddenInputs(html);
  const token = inputs.__RequestVerificationToken;
  if (!token) {
    throw new AulaSamlError('Could not find __RequestVerificationToken on MitID page', {
      htmlSnippet: html.slice(0, 500),
    });
  }
  return token;
}

/**
 * Extract the SAML form values from the page returned after MitID accepts the
 * authorization code. Per #310, RelayState may be absent; we tolerate that.
 *
 * `action` is the form's POST target. Aula's SimpleSAMLphp routes by SP id in
 * the URL (e.g. `…/saml2-acs.php/uni-sp` vs `…/app-level3-sp`); using the
 * wrong one yields a generic "Unhandled exception" page because the SP
 * key/cert can't decrypt the assertion. Always POST to the form's own action.
 */
export interface ExtractedSamlForm {
  samlResponse: string;
  relayState: string;
  /** True if RelayState was present in the source HTML. */
  hadRelayState: boolean;
  /** The form's `action` attribute, or empty if the form had none. */
  action: string;
}

export function extractSamlForm(html: string): ExtractedSamlForm {
  const inputs = extractHiddenInputs(html);
  const samlResponse = inputs.SAMLResponse;
  if (!samlResponse) {
    throw new AulaSamlError('Could not find SAMLResponse in form', {
      htmlSnippet: html.slice(0, 500),
    });
  }
  const relayState = inputs.RelayState ?? '';
  const action = extractSamlFormAction(html);
  return {
    samlResponse,
    relayState,
    hadRelayState: 'RelayState' in inputs && inputs.RelayState != null,
    action,
  };
}

/** Pull the action attribute off the first form that contains a SAMLResponse input. */
function extractSamlFormAction(html: string): string {
  // Quick regex scan — we only need the first <form> wrapping a SAMLResponse,
  // which is how the broker's auto-submitting page is shaped.
  const formMatch = html.match(
    /<form\b[^>]*\baction=("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/form>/i,
  );
  if (!formMatch) return '';
  const body = formMatch[4] ?? '';
  if (!/name=["']SAMLResponse["']/i.test(body)) return '';
  return formMatch[2] ?? formMatch[3] ?? '';
}

export interface IdentityOption {
  /** 1-based index for human display. */
  index: number;
  /** Human label (typically a child's name + role in Danish). */
  name: string;
  /** Raw `data-loginoptions` JSON string — POST verbatim as `ChosenOptionJson`. */
  loginOptionsJson: string;
}

/**
 * Parse the `/loginoption` page that MitID shows when a guardian has multiple
 * children. The caller pairs the chosen option with the form's hidden inputs
 * and POSTs to the same URL.
 */
export function parseIdentitySelectionPage(html: string): {
  options: IdentityOption[];
  formInputs: Record<string, string>;
} {
  const formInputs = extractHiddenInputs(html);
  const optionsJson: string[] = [];
  const labels: string[] = [];
  // We can't easily get aligned arrays from extractAllAttr because the labels
  // live in a child div, so use cheerio directly here.
  const $ = cheerio.load(html);
  // The live page wraps each `a.list-link` inside a `div.list-link-box`, so
  // this selector matches both the container *and* its nested anchor — and
  // each identity would be yielded twice (the duplicated-list bug). Dedupe on
  // the underlying anchor element so every identity is emitted exactly once.
  // Bare anchors (no wrapping box, as in our fixtures) still match once.
  const seenAnchors = new Set<unknown>();
  $('a.list-link, div.list-link-box').each((_: number, el) => {
    const $el = $(el);
    const $a = $el.is('a') ? $el : $el.find('a').first();
    const anchor = $a.get(0);
    if (!anchor || seenAnchors.has(anchor)) return;
    const json = $a.attr('data-loginoptions');
    if (!json) return;
    seenAnchors.add(anchor);
    optionsJson.push(json);
    const labelEl = $el.find('div.list-link-text').first();
    labels.push(labelEl.length ? labelEl.text().trim() : `Option ${optionsJson.length}`);
  });
  if (optionsJson.length === 0) {
    throw new AulaSamlError('No identity options found on /loginoption page', {
      htmlSnippet: html.slice(0, 500),
    });
  }
  const options: IdentityOption[] = optionsJson.map((loginOptionsJson, i) => {
    const name = labels[i] ?? `Option ${i + 1}`;
    return { index: i + 1, name, loginOptionsJson };
  });
  return { options, formInputs };
}

/** Brokerpage params used to build the post-broker-login URL. */
export interface BrokerSessionParams {
  sessionCode: string;
  execution: string;
  clientId: string;
  tabId: string;
}

/**
 * Pull `session_code`, `execution`, `client_id`, `tab_id` from either a URL or
 * a form action's query string. Empty fields are returned as empty strings;
 * the caller decides what's mandatory.
 */
export function extractBrokerParams(urlOrForm: string, html?: string): BrokerSessionParams {
  const fromUrl = (s: string) => {
    try {
      const u = new URL(s);
      return {
        sessionCode: u.searchParams.get('session_code') ?? '',
        execution: u.searchParams.get('execution') ?? '',
        clientId: u.searchParams.get('client_id') ?? '',
        tabId: u.searchParams.get('tab_id') ?? '',
      };
    } catch {
      return { sessionCode: '', execution: '', clientId: '', tabId: '' };
    }
  };
  const fromUrlParams = fromUrl(urlOrForm);
  if (fromUrlParams.sessionCode && fromUrlParams.execution) return fromUrlParams;
  if (!html) return fromUrlParams;

  const formAction = extractFormAction(html);
  if (!formAction) return fromUrlParams;
  // Form action may be relative; we only need its query string.
  let absForm: string;
  try {
    absForm = new URL(formAction, urlOrForm).toString();
  } catch {
    absForm = formAction;
  }
  const fromForm = fromUrl(absForm);
  return {
    sessionCode: fromUrlParams.sessionCode || fromForm.sessionCode,
    execution: fromUrlParams.execution || fromForm.execution,
    clientId: fromUrlParams.clientId || fromForm.clientId,
    tabId: fromUrlParams.tabId || fromForm.tabId,
  };
}

/**
 * Detect the #306 confirmation page on a 200 response from
 * `post-broker-login`. Returns the form to submit, or null if the response is
 * the normal happy path (and the caller should look for a 302 instead).
 */
export interface ConfirmationFormData {
  action: string;
  data: Record<string, string>;
}

export function detectConfirmationForm(html: string): ConfirmationFormData | null {
  const buttonId = extractAttr(html, 'button#confirmation-button', 'id');
  if (!buttonId) return null;
  const action = extractFormAction(html);
  if (!action) return null;
  return { action, data: extractHiddenInputs(html) };
}

/** Bundle of values needed to drive `POST /login/mitid` after MitID auth. */
export interface MitidCompletionParams {
  verificationToken: string;
  authorizationCode: string;
  /** From the `SessionUuid` cookie at nemlog-in.mitid.dk. */
  sessionStorageActiveSessionUuid: string;
  /** From the `Challenge` cookie at nemlog-in.mitid.dk. */
  sessionStorageActiveChallenge: string;
}

export function buildMitidCompletionForm(params: MitidCompletionParams): URLSearchParams {
  const body = new URLSearchParams();
  body.set('__RequestVerificationToken', params.verificationToken);
  body.set('NewCulture', '');
  body.set('MitIDUseConfirmed', 'True');
  body.set('MitIDAuthCode', params.authorizationCode);
  body.set('MitIDAuthenticationCancelled', '');
  body.set('MitIDCoreClientError', '');
  body.set('SessionStorageActiveSessionUuid', params.sessionStorageActiveSessionUuid);
  body.set('SessionStorageActiveChallenge', params.sessionStorageActiveChallenge);
  return body;
}

/** Convenience to produce the page title (or some text) for error reports. */
export function pageTitle(html: string): string | null {
  return extractText(html, 'title');
}
