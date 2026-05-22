/**
 * AulaLoginClient — top-level orchestrator that walks the full flow:
 *
 *   1.  Build the OIDC authorize URL with PKCE + state.
 *   2.  Walk the redirect chain through broker.unilogin.dk → MitID.
 *   3.  POST /login/mitid/initialize, parse the Aux blob.
 *   4.  Drive MitidClient (APP or CODE_TOKEN+PASSWORD).
 *   5.  POST /login/mitid with the MitID authorization code.
 *   6.  Optional identity selection (multi-child guardian).
 *   7.  POST broker SAML endpoint.
 *   8.  Handle post-broker-login (with #306 confirmation form fix).
 *   9.  POST Aula SAML ACS, follow to OAuth callback.
 *   10. Exchange `code` for tokens.
 *
 * Returns AulaTokens on success. Throws typed errors otherwise.
 */

import {
  type AulaOAuthConfig,
  type AulaTokens,
  buildAuthorizeUrl,
  DEFAULT_OAUTH_CONFIG,
  exchangeAuthorizationCode,
  oauthUrls,
  parseAuthorizationCallback,
  refreshAccessToken,
} from './aula-oauth.ts';
import {
  AulaSamlError,
  buildMitidCompletionForm,
  detectConfirmationForm,
  extractBrokerParams,
  extractSamlForm,
  type IdentityOption,
  parseBrokerIdpForm,
  parseIdentitySelectionPage,
  parseMitidVerificationToken,
} from './aula-saml-flow.ts';
import { AulaAuthError } from './errors.ts';
import { extractHiddenInputs, extractMetaRefreshUrl } from './html.ts';
import { AulaHttpClient, type AulaResponse } from './http.ts';
import type { Logger } from './logger.ts';
import { silentLogger } from './logger.ts';
import { type AppAuthCallbacks, MitidClient, parseAuxResponse } from './mitid-client.ts';
import type { AvailableAuthenticators } from './mitid-types.ts';
import { mitidUrls } from './mitid-urls.ts';
import { generatePkce } from './pkce.ts';
import { generateState } from './state.ts';

export type AulaAuthMethod = 'APP' | 'CODE_TOKEN';

export interface AulaLoginCredentials {
  /** MitID username — typically what the user enters in the MitID app. */
  username: string;
  /** Required for CODE_TOKEN. Aula calls this the MitID password. */
  password?: string;
}

export type IdentitySelector = (options: IdentityOption[]) => Promise<number>;

export interface AulaLoginOptions extends AulaLoginCredentials {
  /** Defaults to APP. */
  method?: AulaAuthMethod;
  /** Required for CODE_TOKEN — return the 6-digit value from the kodeviser. */
  promptForCodeToken?: () => Promise<string>;
  /**
   * Called when MitID returns multiple identities. Default: throw, since
   * picking blindly is rarely what the user wants. Return a 1-based index.
   */
  selectIdentity?: IdentitySelector;
  /** UI callbacks for the APP poll loop (QR / OTP rendering). */
  appCallbacks?: AppAuthCallbacks;
  /** Abort signal — cancels the poll loop. */
  signal?: AbortSignal;
  /** Override poll cadence + deadline. */
  pollIntervalMs?: number;
  maxPollMs?: number;
}

export interface AulaLoginClientOptions {
  http?: AulaHttpClient;
  logger?: Logger;
  oauth?: Partial<AulaOAuthConfig>;
}

export class AulaLoginError extends AulaAuthError {
  override readonly name: string = 'AulaLoginError';
}

/**
 * Thrown by attemptSilentReauthorize when the broker/MitID session has
 * lapsed and a fresh interactive login is required. Callers should fall
 * back to the full login() flow.
 */
export class AulaSilentSsoFailedError extends AulaAuthError {
  override readonly name: string = 'AulaSilentSsoFailedError';
}

export class AulaLoginClient {
  readonly http: AulaHttpClient;
  readonly oauth: AulaOAuthConfig;
  private readonly logger: Logger;

  constructor(options: AulaLoginClientOptions = {}) {
    this.http = options.http ?? new AulaHttpClient({ logger: options.logger ?? silentLogger });
    this.logger = options.logger ?? silentLogger;
    this.oauth = { ...DEFAULT_OAUTH_CONFIG, ...(options.oauth ?? {}) };
  }

  /** Run the full MitID-backed login. Returns Aula OAuth tokens. */
  async login(opts: AulaLoginOptions): Promise<AulaTokens> {
    const method = opts.method ?? 'APP';
    let codeTokenPrompt: (() => Promise<string>) | undefined;
    let codeTokenPassword: string | undefined;
    if (method === 'CODE_TOKEN') {
      if (!opts.promptForCodeToken || !opts.password) {
        throw new AulaLoginError(
          'CODE_TOKEN method requires both `password` and `promptForCodeToken`',
        );
      }
      codeTokenPrompt = opts.promptForCodeToken;
      codeTokenPassword = opts.password;
    }

    // 1. PKCE + state + authorize URL.
    const pkce = generatePkce();
    const state = generateState(16);
    const authorizeUrl = buildAuthorizeUrl({
      config: this.oauth,
      state,
      codeChallenge: pkce.challenge,
    });
    this.logger.info('aula.login.start', { method, username: opts.username });
    this.logger.debug('oauth.authorize_url', { authorizeUrl });

    // 2. Walk OAuth redirect chain → broker page or MitID page.
    const reachedMitid = await this.walkOauthChain(authorizeUrl);
    const verificationToken = parseMitidVerificationToken(reachedMitid.body);

    // 3. POST /login/mitid/initialize → Aux.
    const initRes = await this.http.request(mitidUrls.loginMitidInitialize, {
      method: 'POST',
      headers: {
        accept: '*/*',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        origin: 'https://nemlog-in.mitid.dk',
        referer: 'https://nemlog-in.mitid.dk/login/mitid',
        'x-requested-with': 'XMLHttpRequest',
      },
      body: new URLSearchParams({ __RequestVerificationToken: verificationToken }),
    });
    if (initRes.status !== 200) {
      throw new AulaLoginError(
        `MitID initialize failed (status ${initRes.status}): ${initRes.body.slice(0, 300)}`,
      );
    }
    const aux = parseAuxResponse(initRes.body);

    // 4. Drive MitidClient.
    const mitid = await MitidClient.create({ http: this.http, aux, logger: this.logger });
    const available = await mitid.identifyAsUser(opts.username);
    this.assertMethodAvailable(method, available);

    if (method === 'APP') {
      await mitid.authenticateWithApp(opts.appCallbacks ?? {}, {
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.pollIntervalMs ? { pollIntervalMs: opts.pollIntervalMs } : {}),
        ...(opts.maxPollMs ? { maxPollMs: opts.maxPollMs } : {}),
      });
    } else {
      // Asserted non-null above when method === 'CODE_TOKEN'.
      const prompt = codeTokenPrompt;
      const password = codeTokenPassword;
      if (!prompt || !password) {
        throw new AulaLoginError('Internal error: CODE_TOKEN prompt/password lost');
      }
      const digits = await prompt();
      await mitid.authenticateWithToken(digits.trim());
      await mitid.authenticateWithPassword(password);
    }
    const authorizationCode = await mitid.finalize();

    // 5. POST /login/mitid completion.
    const samlForm = await this.completeMitidAndGetSamlForm({
      verificationToken,
      authorizationCode,
      ...(opts.selectIdentity ? { selectIdentity: opts.selectIdentity } : {}),
    });

    // 6+7. SAML to broker → broker page → post-broker-login → final SAML form.
    const finalSamlForm = await this.runBrokerHandoff(samlForm.samlResponse, samlForm.relayState);

    // 8. POST Aula SAML ACS, follow until callback URL.
    const callbackUrl = await this.postAulaSamlAcs(
      finalSamlForm.samlResponse,
      finalSamlForm.relayState,
      finalSamlForm.action,
    );
    const { code, state: returnedState } = parseAuthorizationCallback(callbackUrl);
    if (returnedState !== state) {
      throw new AulaLoginError(`OAuth state mismatch: expected ${state}, got ${returnedState}`);
    }

    // 9. Token exchange.
    const tokens = await exchangeAuthorizationCode(
      this.http,
      this.oauth,
      { code, codeVerifier: pkce.verifier },
      this.logger,
    );
    this.logger.info('aula.login.success');
    return tokens;
  }

  /** Refresh tokens. Returns new tokens (caller decides whether to persist). */
  async refresh(refreshToken: string): Promise<AulaTokens> {
    return refreshAccessToken(this.http, this.oauth, refreshToken, this.logger);
  }

  /**
   * Attempt a silent OIDC re-authorize using whatever cookies are
   * already in the HTTP client's jar. Walks the authorize chain and
   * expects the broker (unilogin Keycloak) to silent-SSO via its session
   * cookie — if the upstream MitID assurance is still valid, this hands
   * back fresh tokens (including a refreshed step-up level) without any
   * user interaction.
   *
   * Throws AulaSilentSsoFailedError when the chain lands on a MitID UI
   * page or the broker IdP-selection page — i.e., when the broker
   * session has expired and a fresh `login()` is required. Throws
   * AulaLoginError for protocol-level surprises.
   */
  async attemptSilentReauthorize(): Promise<AulaTokens> {
    const pkce = generatePkce();
    const state = generateState(16);
    const authorizeUrl = buildAuthorizeUrl({
      config: this.oauth,
      state,
      codeChallenge: pkce.challenge,
    });
    this.logger.info('aula.silent_reauthorize.start');
    this.logger.debug('oauth.silent.authorize_url', { authorizeUrl });

    let currentUrl = authorizeUrl;
    for (let hop = 0; hop < 15; hop++) {
      const res = await this.http.request(currentUrl, { method: 'GET' });
      this.logger.debug('oauth.silent.hop', { hop, status: res.status, url: currentUrl });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) {
          throw new AulaLoginError(`Silent SSO: ${res.status} with no Location at hop ${hop}`);
        }
        const next = new URL(loc, currentUrl).toString();
        // Silent-SSO success terminus: redirect URI carrying ?code=...
        if (next.startsWith(this.oauth.redirectUri) && next.includes('code=')) {
          const code = new URL(next).searchParams.get('code');
          const returnedState = new URL(next).searchParams.get('state');
          if (returnedState !== state) {
            throw new AulaLoginError(
              `OAuth state mismatch in silent flow: expected ${state}, got ${returnedState}`,
            );
          }
          if (!code) {
            throw new AulaSilentSsoFailedError(
              `Silent SSO terminus had no code in URL: ${next.slice(0, 200)}`,
            );
          }
          this.logger.info('aula.silent_reauthorize.code_received');
          const tokens = await exchangeAuthorizationCode(
            this.http,
            this.oauth,
            { code, codeVerifier: pkce.verifier },
            this.logger,
          );
          this.logger.info('aula.silent_reauthorize.success');
          return tokens;
        }
        currentUrl = next;
        continue;
      }

      if (res.status === 200) {
        const url = new URL(currentUrl);
        if (url.host === 'nemlog-in.mitid.dk' || url.host === 'www.mitid.dk') {
          throw new AulaSilentSsoFailedError(
            'Broker session lapsed; silent re-authorize landed on MitID. Run `aula login` to re-authenticate.',
          );
        }
        if (url.host === 'broker.unilogin.dk') {
          throw new AulaSilentSsoFailedError(
            'Silent re-authorize hit the broker IdP-selection page; broker session is gone. Run `aula login`.',
          );
        }
        const metaUrl = extractMetaRefreshUrl(res.body);
        if (metaUrl) {
          currentUrl = new URL(metaUrl, currentUrl).toString();
          continue;
        }
        throw new AulaLoginError(
          `Silent SSO landed on unexpected host (${url.host}) at hop ${hop}`,
        );
      }

      throw new AulaLoginError(
        `Silent SSO unexpected status ${res.status} at hop ${hop}: ${res.body.slice(0, 200)}`,
      );
    }
    throw new AulaLoginError('Silent SSO chain exceeded 15 hops');
  }

  // ============ Private orchestration helpers ================================

  /**
   * Visit the authorize URL and follow redirects until we reach either a
   * MitID page (with __RequestVerificationToken) or a broker IdP-selection
   * page (which we then submit and continue from). Returns the final response
   * sitting on a MitID page.
   *
   * Broker IdP form is fragile — Aula has historically named the field
   * `selectedIdp` with value `nemlogin3`, but the Python reference brute-
   * forces 4 selectors × 4 values when the obvious combo doesn't redirect.
   * We mirror that fallback so a renamed field doesn't kill login.
   */
  private async walkOauthChain(authorizeUrl: string): Promise<AulaResponse> {
    let currentUrl = authorizeUrl;
    let currentMethod: 'GET' | 'POST' = 'GET';
    let currentBody: URLSearchParams | undefined;

    for (let hop = 0; hop < 15; hop++) {
      const res = await this.http.request(currentUrl, {
        method: currentMethod,
        ...(currentBody ? { body: currentBody } : {}),
      });
      this.logger.debug('oauth.chain.hop', { hop, status: res.status, url: currentUrl });

      // 3xx — follow Location.
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) {
          throw new AulaLoginError(`OAuth chain: ${res.status} with no Location at hop ${hop}`);
        }
        currentUrl = new URL(loc, currentUrl).toString();
        currentMethod = 'GET';
        currentBody = undefined;
        continue;
      }

      // 200 — figure out where we are.
      if (res.status === 200) {
        const url = new URL(currentUrl);
        if (url.host === 'broker.unilogin.dk') {
          // IdP-selection page; try the field/value combinations until one
          // returns a 3xx that takes us off the broker page.
          const submitted = await this.tryBrokerIdpCombinations(res.body, currentUrl);
          currentUrl = submitted.nextUrl;
          currentMethod = 'GET';
          currentBody = undefined;
          continue;
        }
        if (url.host === 'nemlog-in.mitid.dk' || url.host === 'www.mitid.dk') {
          return res;
        }
        // Some intermediate hops carry a `<meta http-equiv="refresh">` redirect
        // instead of an HTTP Location. The Python `step3_follow_redirect_chain`
        // also looks for these — without the fallback, login fails with
        // "unexpected host" on perfectly valid pages.
        const metaUrl = extractMetaRefreshUrl(res.body);
        if (metaUrl) {
          this.logger.debug('oauth.chain.meta_refresh', { metaUrl });
          currentUrl = new URL(metaUrl, currentUrl).toString();
          currentMethod = 'GET';
          currentBody = undefined;
          continue;
        }
        throw new AulaLoginError(
          `OAuth chain landed on unexpected host (${url.host}) at hop ${hop}`,
        );
      }

      throw new AulaLoginError(
        `OAuth chain unexpected status ${res.status} at hop ${hop}: ${res.body.slice(0, 200)}`,
      );
    }
    throw new AulaLoginError('OAuth chain exceeded 15 hops');
  }

  /**
   * Try each (field, value) combination at the broker IdP form. First one
   * that produces a 3xx with a Location header wins.
   */
  private async tryBrokerIdpCombinations(
    pageHtml: string,
    pageUrl: string,
  ): Promise<{ nextUrl: string }> {
    const selectors = ['selectedIdp', 'idp', 'authMethod', 'provider'];
    const values = ['nemlogin3', 'mitid', 'MitID', 'nemlogin'];
    const triedDescriptions: string[] = [];

    for (const idpField of selectors) {
      for (const idpValue of values) {
        const broker = parseBrokerIdpForm(pageHtml, { idpField, idpValue });
        const action = new URL(broker.action, pageUrl).toString();
        const res = await this.http.request(action, {
          method: 'POST',
          body: new URLSearchParams(broker.data),
        });
        triedDescriptions.push(`${idpField}=${idpValue} → ${res.status}`);
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (loc) {
            this.logger.info('aula.broker.idp_selection_succeeded', { idpField, idpValue });
            return { nextUrl: new URL(loc, action).toString() };
          }
        }
      }
    }
    throw new AulaLoginError(`Broker IdP selection failed; tried: ${triedDescriptions.join(', ')}`);
  }

  private assertMethodAvailable(method: AulaAuthMethod, available: AvailableAuthenticators): void {
    if (method === 'APP' && available.APP == null) {
      throw new AulaLoginError(
        `APP authenticator not available. Found: ${Object.keys(available).join(', ') || 'none'}`,
      );
    }
    if (method === 'CODE_TOKEN' && available.CODE_TOKEN == null) {
      throw new AulaLoginError(
        `CODE_TOKEN authenticator not available. Found: ${Object.keys(available).join(', ') || 'none'}`,
      );
    }
  }

  private async completeMitidAndGetSamlForm(args: {
    verificationToken: string;
    authorizationCode: string;
    selectIdentity?: IdentitySelector;
  }): Promise<{ samlResponse: string; relayState: string }> {
    const sessionUuid =
      (await this.http.jar.getCookieValue(mitidUrls.loginMitid, 'SessionUuid')) ?? '';
    const challenge = (await this.http.jar.getCookieValue(mitidUrls.loginMitid, 'Challenge')) ?? '';

    const body = buildMitidCompletionForm({
      verificationToken: args.verificationToken,
      authorizationCode: args.authorizationCode,
      sessionStorageActiveSessionUuid: sessionUuid,
      sessionStorageActiveChallenge: challenge,
    });

    // Python's reference uses `requests` with default redirect-following
    // here. We have a manual-redirect HTTP client (so the OAuth chain can
    // inspect each hop), so we explicitly follow until the final 200 — that
    // lands either on the SAML form or on the /loginoption identity picker.
    let res = (await this.http.followRedirects(mitidUrls.loginMitid, { method: 'POST', body }))
      .final;

    // Identity selection page.
    if (res.url.startsWith(mitidUrls.loginOption) || res.url === mitidUrls.loginOption) {
      const { options, formInputs } = parseIdentitySelectionPage(res.body);
      if (!args.selectIdentity) {
        throw new AulaLoginError(
          `MitID asked for identity selection (${options.length} options) but no selectIdentity callback was provided`,
        );
      }
      const choice = await args.selectIdentity(options);
      const picked = options.find((o) => o.index === choice);
      if (!picked) {
        throw new AulaLoginError(`selectIdentity returned ${choice}, no such option`);
      }
      const newSessionUuid =
        (await this.http.jar.getCookieValue(mitidUrls.loginOption, 'SessionUuid')) ?? sessionUuid;
      const newChallenge =
        (await this.http.jar.getCookieValue(mitidUrls.loginOption, 'Challenge')) ?? challenge;
      const reBody = new URLSearchParams(formInputs);
      reBody.set('ChosenOptionJson', picked.loginOptionsJson);
      reBody.set('SessionStorageActiveSessionUuid', newSessionUuid);
      reBody.set('SessionStorageActiveChallenge', newChallenge);
      res = (
        await this.http.followRedirects(mitidUrls.loginOption, {
          method: 'POST',
          body: reBody,
        })
      ).final;
    }

    return extractSamlForm(res.body);
  }

  /**
   * SAML hop into the broker, post-broker-login (with #306 fallback), and
   * return the final SAML form whose POST hits Aula's ACS.
   */
  private async runBrokerHandoff(
    samlResponse: string,
    relayState: string,
  ): Promise<{ samlResponse: string; relayState: string; action: string }> {
    const samlBody = new URLSearchParams({ SAMLResponse: samlResponse, RelayState: relayState });
    const samlRes = await this.http.request(oauthUrls.brokerSamlEndpoint(this.oauth), {
      method: 'POST',
      headers: {
        origin: 'https://nemlog-in.mitid.dk',
        referer: 'https://nemlog-in.mitid.dk/login/mitid',
      },
      body: samlBody,
    });

    let brokerPageRes: AulaResponse;
    if (samlRes.status >= 300 && samlRes.status < 400) {
      const loc = samlRes.headers.get('location');
      if (!loc) throw new AulaSamlError('Broker SAML POST returned 3xx without Location');
      const followUrl = new URL(loc, oauthUrls.brokerSamlEndpoint(this.oauth)).toString();
      brokerPageRes = await this.http.request(followUrl);
    } else if (samlRes.status === 200) {
      brokerPageRes = samlRes;
    } else {
      throw new AulaSamlError(
        `Broker SAML POST failed (status ${samlRes.status}): ${samlRes.body.slice(0, 300)}`,
        { htmlSnippet: samlRes.body.slice(0, 500) },
      );
    }

    const params = extractBrokerParams(brokerPageRes.url, brokerPageRes.body);
    if (!params.sessionCode || !params.execution) {
      throw new AulaSamlError(
        `Broker page missing session_code/execution params (url=${brokerPageRes.url})`,
        { htmlSnippet: brokerPageRes.body.slice(0, 500) },
      );
    }

    const formData: Record<string, string> = { ...extractHiddenInputs(brokerPageRes.body) };
    // Role selection: the prod code defaults to KONTAKT (= guardian).
    if ('selected-aktoer' in formData) formData['selected-aktoer'] = 'KONTAKT';

    let postRes = await this.http.request(oauthUrls.postBrokerLogin(this.oauth, params), {
      method: 'POST',
      body: new URLSearchParams(formData),
    });

    // #306/#287 fix: 200 with confirmation form → submit it.
    if (postRes.status === 200) {
      const conf = detectConfirmationForm(postRes.body);
      if (conf) {
        this.logger.info('aula.broker.confirmation_form_detected');
        const confAction = new URL(conf.action, postRes.url).toString();
        postRes = await this.http.request(confAction, {
          method: 'POST',
          body: new URLSearchParams(conf.data),
        });
      }
    }

    if (postRes.status < 300 || postRes.status >= 400) {
      throw new AulaSamlError(
        `post-broker-login expected redirect, got ${postRes.status} (url=${postRes.url})`,
        { htmlSnippet: postRes.body.slice(0, 500) },
      );
    }
    const afterLoc = postRes.headers.get('location');
    if (!afterLoc) {
      throw new AulaSamlError('post-broker-login returned 3xx without Location');
    }
    const afterRes = await this.http.request(new URL(afterLoc, postRes.url).toString());

    const {
      samlResponse: finalSaml,
      relayState: finalRelay,
      hadRelayState,
      action: finalAction,
    } = extractSamlForm(afterRes.body);
    if (!hadRelayState) {
      this.logger.warn('aula.saml.relay_state_missing', {
        note: 'Tolerating per upstream issue #310 — Level 3 flows sometimes omit it',
      });
    }
    return { samlResponse: finalSaml, relayState: finalRelay, action: finalAction };
  }

  /**
   * POST the SAML response to Aula's ACS, then walk the resulting redirects
   * until we reach the OAuth callback URL with `code` in the query string.
   *
   * `action` comes from the auto-submit form returned by the broker — Aula
   * routes by SP id in the URL (`…/uni-sp` vs `…/app-level3-sp`); using the
   * wrong one yields SimpleSAMLphp's "Unhandled exception" because the SP
   * key/cert can't decrypt the assertion.
   */
  private async postAulaSamlAcs(
    samlResponse: string,
    relayState: string,
    action: string,
  ): Promise<string> {
    const body = new URLSearchParams({ SAMLResponse: samlResponse, RelayState: relayState });
    const acsUrl = action || oauthUrls.samlAcs(this.oauth);
    let res = await this.http.request(acsUrl, {
      method: 'POST',
      body,
    });

    for (let hop = 0; hop < 10; hop++) {
      // The Aula redirect to `app-private.aula.dk?code=...` is what we want.
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new AulaLoginError(`Aula ACS chain: ${res.status} with no Location`);
        const next = new URL(loc, res.url).toString();
        if (next.startsWith(this.oauth.redirectUri) && next.includes('code=')) {
          return next;
        }
        res = await this.http.request(next);
        continue;
      }
      // 200: see if the URL contains the callback (some flows land here directly).
      if (res.url.startsWith(this.oauth.redirectUri) && res.url.includes('code=')) {
        return res.url;
      }
      throw new AulaLoginError(`Aula ACS chain stopped at status ${res.status} on ${res.url}`);
    }
    throw new AulaLoginError('Aula ACS chain exceeded 10 hops');
  }
}
