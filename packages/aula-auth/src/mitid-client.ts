/**
 * MitID core-client port. Equivalent to Python's `BrowserClient`.
 *
 * APP completion uses the `/init → /prove → /verify → /next` dance — the
 * exact same sequence the Python reference does. We previously had a
 * speculative `/complete` path here, but it 404'd against real accounts and
 * appeared to corrupt server-side state when followed by the legacy fallback.
 * Removed; do not re-add without a clear positive signal that an account
 * actually needs it.
 *
 * The class is stateful: `identifyAsUser` selects an authenticator, then one
 * of the `authenticateWith*` methods drives that authenticator to completion,
 * then `finalize` returns the OAuth authorization code.
 *
 * Testing strategy: pure helpers (parseAuxResponse, password derivations) have
 * unit tests. The HTTP-driven methods are integration-tested via fixture
 * replay (see packages/aula-auth/src/__tests__/fixtures/).
 */

import { Buffer } from 'node:buffer';
import { sha256 } from './crypto.ts';
import { AulaAuthError } from './errors.ts';
import type { AulaHttpClient } from './http.ts';
import type { Logger } from './logger.ts';
import { silentLogger } from './logger.ts';
import {
  buildFlowProofMessage,
  type FlowProofContext,
  signFlowValueProof,
} from './mitid-flow-proof.ts';
import type { MitidPollResult } from './mitid-poll-machine.ts';
import { interpretPollResponse } from './mitid-poll-machine.ts';
import type {
  AppInitAuthResponse,
  AppPollResponse,
  AuthenticationSessionResponse,
  AvailableAuthenticators,
  FinalizationResponse,
  MitidAuthenticatorType,
  NextAuthenticator,
  NextAuthenticatorResponse,
  SrpInitResponse,
} from './mitid-types.ts';
import {
  AUTHENTICATOR_TO_COMBINATION_ID,
  COMBINATION_ID_TO_AUTHENTICATOR,
  normalizeAuthenticatorType,
} from './mitid-types.ts';
import { mitidUrls } from './mitid-urls.ts';
import { CustomSrp } from './srp.ts';

export class MitidError extends AulaAuthError {
  override readonly name: string = 'MitidError';
}

export class MitidIdentityNotFoundError extends MitidError {
  override readonly name: string = 'MitidIdentityNotFoundError';
}

export class MitidParallelSessionError extends MitidError {
  override readonly name: string = 'MitidParallelSessionError';
}

export class MitidAuthenticatorUnavailableError extends MitidError {
  override readonly name: string = 'MitidAuthenticatorUnavailableError';
}

export interface MitidAuxData {
  /** Hex of the base64-decoded aux.coreClient.checksum. */
  clientHash: string;
  /** UUID for the MitID core authentication session. */
  authenticationSessionId: string;
}

interface RawAux {
  coreClient?: { checksum?: string };
  parameters?: { authenticationSessionId?: string };
}

/**
 * Parse the body of the `/login/mitid/initialize` response.
 *
 * The response has *two* layers of JSON encoding:
 *
 *   1. The HTTP body is a JSON-encoded **string** (it starts with `"` and
 *      ends with `"`, with `\"` escapes inside). One JSON.parse turns that
 *      into a regular JSON object string; we have to parse a second time
 *      to get the actual object. The Python reference handles this with
 *      `if isinstance(resp_init_json, str): json.loads(resp_init_json)`.
 *   2. Then the `Aux` field is itself base64-encoded JSON describing the
 *      MitID core client (checksum + authenticationSessionId).
 */
export function parseAuxResponse(rawBody: string | { Aux?: string }): MitidAuxData {
  let outer: { Aux?: string };
  if (typeof rawBody === 'string') {
    let parsed = JSON.parse(rawBody) as unknown;
    // Layer 1: nemlog-in.mitid.dk returns the JSON object as a JSON string,
    // so the first parse hands back a string. Re-parse to get the object.
    if (typeof parsed === 'string') {
      parsed = JSON.parse(parsed) as unknown;
    }
    outer = parsed as { Aux?: string };
  } else {
    outer = rawBody;
  }
  const auxB64 = outer?.Aux;
  if (!auxB64) throw new MitidError('initialize response is missing `Aux` field');

  let inner: RawAux;
  try {
    inner = JSON.parse(Buffer.from(auxB64, 'base64').toString('utf8')) as RawAux;
  } catch (e) {
    throw new MitidError('initialize response Aux is not valid base64-encoded JSON', { cause: e });
  }

  const checksumB64 = inner?.coreClient?.checksum;
  const sessionId = inner?.parameters?.authenticationSessionId;
  if (!checksumB64 || !sessionId) {
    throw new MitidError(
      'initialize response Aux is missing coreClient.checksum or authenticationSessionId',
    );
  }

  return {
    clientHash: Buffer.from(checksumB64, 'base64').toString('hex'),
    authenticationSessionId: sessionId,
  };
}

export interface AppAuthCallbacks {
  /**
   * Fired once, as soon as the app-auth session is armed and before the
   * first poll.
   *
   * Nothing happens in this phase until the user opens the MitID app, so a
   * caller with no output here looks like a hung process. It must fire
   * before polling starts, not on the first `waiting` result: the first
   * poll is a long-poll that blocks for ~25 s, which is long past the point
   * where the user has already concluded the process is stuck.
   */
  onWaiting?: () => void | Promise<void>;
  onOtp?: (otp: string) => void | Promise<void>;
  /** Called every time a new pair of QR JSON payloads is received. */
  onQr?: (qr: { qr1Json: string; qr2Json: string; updateCount: number }) => void | Promise<void>;
  onVerified?: () => void | Promise<void>;
  /** Called for every poll, even waiting/error — useful for verbose logs. */
  onPoll?: (result: MitidPollResult) => void | Promise<void>;
}

export interface AppAuthLoopOptions {
  /** Time between polls. Default 1 s — matches Python. */
  pollIntervalMs?: number;
  /** Hard stop after this many ms. Default 10 minutes. */
  maxPollMs?: number;
  /** Stop signal from outside (e.g. CLI Ctrl-C). */
  signal?: AbortSignal;
}

export interface MitidClientOptions {
  http: AulaHttpClient;
  aux: MitidAuxData;
  logger?: Logger;
}

export interface MitidClientState {
  authenticationSessionId: string;
  currentAuthenticatorType?: MitidAuthenticatorType;
  currentAuthenticatorSessionId?: string;
  finalizationSessionId?: string;
  hasPollUrl: boolean;
  hasAuthResponse: boolean;
}

export class MitidClient {
  readonly clientHash: string;
  readonly authenticationSessionId: string;

  private readonly http: AulaHttpClient;
  private readonly logger: Logger;

  // Populated by init():
  private brokerSecurityContext = '';
  private serviceProviderName = '';
  private referenceTextHeader = '';
  private referenceTextBody = '';

  // Populated by identifyAsUser / select-authenticator:
  private currentAuthenticatorType?: MitidAuthenticatorType;
  private currentAuthenticatorSessionFlowKey?: string;
  private currentAuthenticatorEafeHash?: string;
  private currentAuthenticatorSessionId?: string;

  // APP poll state:
  private pollUrl?: string;
  private ticket?: string;
  private authResponse?: string;
  /** Used by /verify to encrypt-sign the response with the SRP shared key. */
  private authResponseSignature?: string;

  // After authentication:
  private finalizationSessionId?: string;

  private constructor(opts: MitidClientOptions) {
    this.http = opts.http;
    this.logger = opts.logger ?? silentLogger;
    this.clientHash = opts.aux.clientHash;
    this.authenticationSessionId = opts.aux.authenticationSessionId;
  }

  /** Async constructor — fetches the session info immediately. */
  static async create(opts: MitidClientOptions): Promise<MitidClient> {
    const client = new MitidClient(opts);
    await client.init();
    return client;
  }

  private async init(): Promise<void> {
    const url = mitidUrls.authenticationSession(this.authenticationSessionId);
    const res = await this.http.request(url, { method: 'GET' });
    if (res.status !== 200) {
      throw new MitidError(`Failed to fetch authentication session (status ${res.status})`);
    }
    const session = JSON.parse(res.body) as AuthenticationSessionResponse;
    this.brokerSecurityContext = session.brokerSecurityContext;
    this.serviceProviderName = session.serviceProviderName;
    this.referenceTextHeader = session.referenceTextHeader;
    this.referenceTextBody = session.referenceTextBody;
    this.logger.info('mitid.session_loaded', {
      serviceProviderName: this.serviceProviderName,
    });
  }

  /** Step: PUT identityClaim, POST /next, return available authenticators. */
  async identifyAsUser(userId: string): Promise<AvailableAuthenticators> {
    const idClaimRes = await this.postJson(
      mitidUrls.authenticationSession(this.authenticationSessionId),
      {
        identityClaim: userId,
      },
      'PUT',
    );
    if (idClaimRes.status !== 200) {
      const errCode = safeJson(idClaimRes.body)?.errorCode;
      if (idClaimRes.status === 400 && errCode === 'control.identity_not_found') {
        throw new MitidIdentityNotFoundError(`MitID user "${userId}" does not exist`);
      }
      if (idClaimRes.status === 400 && errCode === 'control.authentication_session_not_found') {
        throw new MitidError('MitID authentication session not found');
      }
      throw new MitidError(
        `identifyAsUser failed (status ${idClaimRes.status}): ${idClaimRes.body.slice(0, 300)}`,
      );
    }

    const next = await this.postNext('');
    this.assertNoFatalErrors(next);
    if (!next.nextAuthenticator) throw new MitidError('identifyAsUser: missing nextAuthenticator');

    this.applyNextAuthenticator(next.nextAuthenticator);

    const available: AvailableAuthenticators = {};
    for (const combo of next.combinations ?? []) {
      const human = COMBINATION_ID_TO_AUTHENTICATOR[combo.id];
      if (!human) continue;
      available[human] = combo.combinationItems[0]?.name ?? '';
    }
    this.logger.info('mitid.authenticators_available', { available });
    return available;
  }

  // ============ APP authenticator (modern /complete path) ====================

  async startAppAuth(): Promise<{ pollUrl: string; ticket: string }> {
    await this.selectAuthenticator('APP');
    if (!this.currentAuthenticatorSessionId) {
      throw new MitidError('startAppAuth: no current authenticator session id');
    }

    const res = await this.postJson(mitidUrls.appInitAuth(this.currentAuthenticatorSessionId), {});
    if (res.status !== 200) {
      throw new MitidError(`startAppAuth failed (status ${res.status})`);
    }
    const json = JSON.parse(res.body) as AppInitAuthResponse;
    if (json.errorCode === 'auth.codeapp.authentication.parallel_sessions_detected') {
      throw new MitidParallelSessionError(
        'MitID detected a parallel app session. Wait a few minutes and try again.',
      );
    }
    this.pollUrl = json.pollUrl;
    this.ticket = json.ticket;
    return { pollUrl: json.pollUrl, ticket: json.ticket };
  }

  /** Single poll. Caller decides cadence. */
  async pollAppAuth(): Promise<MitidPollResult> {
    if (!this.pollUrl || !this.ticket) {
      throw new MitidError('pollAppAuth called before startAppAuth');
    }
    const res = await this.postJson(this.pollUrl, { ticket: this.ticket });
    if (res.status !== 200) {
      return { kind: 'error', message: `Poll request failed (status ${res.status})` };
    }
    const interpreted = interpretPollResponse(JSON.parse(res.body) as AppPollResponse);
    if (interpreted.kind === 'completed') {
      this.authResponse = interpreted.response;
      this.authResponseSignature = interpreted.responseSignature;
    }
    return interpreted;
  }

  /**
   * Finish the APP flow via `/init → /prove → /verify → /next`.
   *
   *   • Derive SRP shared key K against the authenticator session.
   *   • POST /prove with M1 + a HEX-encoded flowValueProof; server returns M2
   *     which we verify via SRP stage 5.
   *   • PKCS#7-pad and AES-GCM-encrypt the responseSignature with K, POST
   *     to /verify (204 on success).
   *   • POST /next to advance the outer authenticationSession.
   *
   * `frontEndProcessingTime` is the wall-clock ms spent on cryptographic
   * work between /init and /verify. The Python reference sums per-stage
   * timers; we measure the same span as one elapsed value. Empty/zero
   * timings have been observed to upset the server-side bot heuristics, so
   * we send a real number.
   */
  async completeAppAuth(): Promise<void> {
    if (
      !this.authResponse ||
      !this.authResponseSignature ||
      !this.currentAuthenticatorSessionId ||
      !this.currentAuthenticatorSessionFlowKey
    ) {
      throw new MitidError('completeAppAuth called before APP poll completed');
    }

    const sessionId = this.currentAuthenticatorSessionId;
    const flowKey = this.currentAuthenticatorSessionFlowKey;

    const cryptoStartMs = Date.now();

    const srp = new CustomSrp();
    const aHex = srp.stage1();

    const initRes = await this.postJson(mitidUrls.appInit(sessionId), {
      randomA: { value: aHex },
    });
    if (initRes.status !== 200) {
      throw new MitidError(`appInit failed (status ${initRes.status})`);
    }
    const init = JSON.parse(initRes.body) as SrpInitResponse;

    // SRP password input = SHA256(decoded(authResponse) || flowKey.utf8).hex
    const passwordHex = sha256(
      Buffer.concat([Buffer.from(this.authResponse, 'base64'), Buffer.from(flowKey, 'utf8')]),
    ).toString('hex');

    const { m1Hex, K } = srp.stage3({
      srpSaltHex: init.srpSalt.value,
      randomBHex: init.randomB.value,
      passwordHex,
      authSessionId: sessionId,
    });

    const flowProofMessage = buildFlowProofMessage(this.flowProofContext());
    const flowValueProofHex = signFlowValueProof(flowProofMessage, K, 'flowValues', 'hex');

    const proveRes = await this.postJson(mitidUrls.appProve(sessionId), {
      m1: { value: m1Hex },
      flowValueProof: { value: flowValueProofHex },
    });
    if (proveRes.status !== 200) {
      throw new MitidError(
        `appProve failed (status ${proveRes.status}): ${proveRes.body.slice(0, 300)}`,
      );
    }
    const proveJson = JSON.parse(proveRes.body) as { m2?: { value?: string } };
    const m2 = proveJson.m2?.value;
    if (!m2 || !srp.stage5(m2)) {
      throw new MitidError('appProve: server M2 verification failed');
    }

    // The signature goes into AES-GCM *unpadded*. Python's reference
    // appends PKCS#7-style chars to the **base64 string**, then b64decodes
    // the result; b64decode silently discards those non-alphabet chars, so
    // the pad call is effectively a no-op there. GCM is a stream cipher and
    // doesn't need block padding — sending padded bytes makes the server
    // reject the auth on the next /next call ("Try again", no errorCode).
    const sigBytes = Buffer.from(this.authResponseSignature, 'base64');
    const encAuth = srp.authEnc(sigBytes).toString('base64');

    const frontEndProcessingTime = Date.now() - cryptoStartMs;

    const verifyRes = await this.postJson(mitidUrls.appVerify(sessionId), {
      encAuth,
      frontEndProcessingTime,
    });
    if (verifyRes.status !== 204) {
      throw new MitidError(
        `appVerify failed (status ${verifyRes.status}): ${verifyRes.body.slice(0, 300)}`,
      );
    }

    const next = await this.postNext('');
    this.assertNoFatalErrors(next);
    if (!next.nextSessionId) {
      throw new MitidError('appVerify succeeded but /next missing nextSessionId');
    }
    this.finalizationSessionId = next.nextSessionId;
    this.logger.info('mitid.app_authenticated', { frontEndProcessingTime });
  }

  /** Convenience: drive the APP authenticator end-to-end with UI callbacks. */
  async authenticateWithApp(
    callbacks: AppAuthCallbacks = {},
    opts: AppAuthLoopOptions = {},
  ): Promise<void> {
    const pollIntervalMs = opts.pollIntervalMs ?? 1_000;
    const maxPollMs = opts.maxPollMs ?? 10 * 60 * 1_000;
    const deadline = Date.now() + maxPollMs;

    await this.startAppAuth();
    await callbacks.onWaiting?.();

    while (true) {
      if (opts.signal?.aborted) throw new MitidError('APP poll aborted by caller');
      if (Date.now() > deadline) throw new MitidError('APP poll timed out');

      const result = await this.pollAppAuth();
      await callbacks.onPoll?.(result);

      switch (result.kind) {
        case 'waiting':
          break;
        case 'otp':
          await callbacks.onOtp?.(result.otpCode);
          break;
        case 'qr':
          await callbacks.onQr?.({
            qr1Json: result.qr1Json,
            qr2Json: result.qr2Json,
            updateCount: result.updateCount,
          });
          break;
        case 'verified':
          await callbacks.onVerified?.();
          break;
        case 'completed':
          await this.completeAppAuth();
          return;
        case 'error':
          throw new MitidError(`APP poll error: ${result.message}`);
      }
      await sleep(pollIntervalMs, opts.signal);
    }
  }

  // ============ CODE_TOKEN + PASSWORD authenticators =========================

  async authenticateWithToken(digits: string): Promise<void> {
    await this.selectAuthenticator('CODE_TOKEN');
    if (!this.currentAuthenticatorSessionId || !this.currentAuthenticatorSessionFlowKey) {
      throw new MitidError('CODE_TOKEN: missing session id / flow key');
    }

    const srp = new CustomSrp();
    const aHex = srp.stage1();

    const initRes = await this.postJson(
      mitidUrls.codeTokenInit(this.currentAuthenticatorSessionId),
      { randomA: { value: aHex } },
    );
    if (initRes.status !== 200) {
      throw new MitidError(`codeTokenInit failed (status ${initRes.status})`);
    }
    const init = JSON.parse(initRes.body) as SrpInitResponse;

    // The SRP password for CODE_TOKEN is the flow key bytes hex-encoded.
    const passwordHex = Buffer.from(this.currentAuthenticatorSessionFlowKey, 'utf8').toString(
      'hex',
    );

    const { m1Hex, K } = srp.stage3({
      srpSaltHex: init.srpSalt.value,
      randomBHex: init.randomB.value,
      passwordHex,
      authSessionId: this.currentAuthenticatorSessionId,
    });

    const flowProofMessage = buildFlowProofMessage(this.flowProofContext());
    const flowValueProof = signFlowValueProof(flowProofMessage, K, `OTP${digits}`, 'hex');

    const proveRes = await this.postJson(
      mitidUrls.codeTokenProve(this.currentAuthenticatorSessionId),
      {
        m1: { value: m1Hex },
        flowValueProof: { value: flowValueProof },
        frontEndProcessingTime: 100,
      },
    );
    if (proveRes.status !== 204) {
      throw new MitidError(`codeTokenProve failed (status ${proveRes.status})`);
    }

    const next = await this.postNext('');
    this.assertNoFatalErrors(next);

    if (next.errors?.[0]?.errorCode === 'TOTP_INVALID') {
      throw new MitidError(`CODE_TOKEN rejected: ${next.errors[0].message ?? 'invalid token'}`);
    }
    if (next.nextAuthenticator?.authenticatorType !== 'PASSWORD') {
      throw new MitidError('CODE_TOKEN succeeded but next authenticator is not PASSWORD');
    }
    this.applyNextAuthenticator(next.nextAuthenticator);
  }

  async authenticateWithPassword(password: string): Promise<void> {
    if (this.currentAuthenticatorType !== 'PASSWORD') {
      throw new MitidError(
        `authenticateWithPassword requires PASSWORD step (current: ${this.currentAuthenticatorType ?? 'none'})`,
      );
    }
    if (!this.currentAuthenticatorSessionId) {
      throw new MitidError('PASSWORD: missing session id');
    }

    const srp = new CustomSrp();
    const aHex = srp.stage1();

    const initRes = await this.postJson(
      mitidUrls.passwordInit(this.currentAuthenticatorSessionId),
      { randomA: { value: aHex } },
    );
    if (initRes.status !== 200) {
      throw new MitidError(`passwordInit failed (status ${initRes.status})`);
    }
    const init = JSON.parse(initRes.body) as SrpInitResponse;
    if (!init.pbkdf2Salt) {
      throw new MitidError('passwordInit response missing pbkdf2Salt');
    }

    const { pbkdf2Sha256 } = await import('./crypto.ts');
    const pbkdfSaltBytes = Buffer.from(init.pbkdf2Salt.value, 'hex');
    const passwordHex = pbkdf2Sha256(password, pbkdfSaltBytes, 20_000, 32).toString('hex');

    const { m1Hex, K } = srp.stage3({
      srpSaltHex: init.srpSalt.value,
      randomBHex: init.randomB.value,
      passwordHex,
      authSessionId: this.currentAuthenticatorSessionId,
    });

    const flowProofMessage = buildFlowProofMessage(this.flowProofContext());
    const flowValueProof = signFlowValueProof(flowProofMessage, K, 'flowValues', 'hex');

    const proveRes = await this.postJson(
      mitidUrls.passwordProve(this.currentAuthenticatorSessionId),
      {
        m1: { value: m1Hex },
        flowValueProof: { value: flowValueProof },
        frontEndProcessingTime: 100,
      },
    );
    if (proveRes.status !== 204) {
      throw new MitidError(`passwordProve failed (status ${proveRes.status})`);
    }

    const next = await this.postNext('');
    this.assertNoFatalErrors(next);
    if (next.errors?.length) {
      const msg = next.errors[0]?.message ?? 'password rejected';
      throw new MitidError(`PASSWORD rejected: ${msg}`);
    }
    if (!next.nextSessionId) {
      throw new MitidError('PASSWORD prove succeeded but nextSessionId missing');
    }
    this.finalizationSessionId = next.nextSessionId;
    this.logger.info('mitid.password_authenticated');
  }

  // ============ Finalization =================================================

  async finalize(): Promise<string> {
    if (!this.finalizationSessionId) {
      throw new MitidError('finalize called before authenticator completed');
    }
    const res = await this.http.request(mitidUrls.finalization(this.finalizationSessionId), {
      method: 'PUT',
    });
    if (res.status !== 200) {
      throw new MitidError(`finalize failed (status ${res.status})`);
    }
    const json = JSON.parse(res.body) as FinalizationResponse;
    if (!json.authorizationCode) {
      throw new MitidError('finalize response missing authorizationCode');
    }
    this.logger.info('mitid.finalized');
    return json.authorizationCode;
  }

  // ============ State / debug ================================================

  getState(): MitidClientState {
    const state: MitidClientState = {
      authenticationSessionId: this.authenticationSessionId,
      hasPollUrl: this.pollUrl != null,
      hasAuthResponse: this.authResponse != null,
    };
    if (this.currentAuthenticatorType !== undefined) {
      state.currentAuthenticatorType = this.currentAuthenticatorType;
    }
    if (this.currentAuthenticatorSessionId !== undefined) {
      state.currentAuthenticatorSessionId = this.currentAuthenticatorSessionId;
    }
    if (this.finalizationSessionId !== undefined) {
      state.finalizationSessionId = this.finalizationSessionId;
    }
    return state;
  }

  // ============ Internals ====================================================

  private async selectAuthenticator(target: MitidAuthenticatorType): Promise<void> {
    if (this.currentAuthenticatorType === target) return;
    const combinationId = AUTHENTICATOR_TO_COMBINATION_ID[target];
    if (!combinationId) {
      throw new MitidError(`Cannot select authenticator type ${target}`);
    }

    const next = await this.postNext(combinationId);
    this.assertNoFatalErrors(next);
    if (!next.nextAuthenticator) {
      throw new MitidError(`selectAuthenticator(${target}) missing nextAuthenticator`);
    }
    this.applyNextAuthenticator(next.nextAuthenticator);
    if (this.currentAuthenticatorType !== target) {
      throw new MitidAuthenticatorUnavailableError(
        `Asked for ${target} but server returned ${this.currentAuthenticatorType ?? 'none'}`,
      );
    }
  }

  private async postNext(combinationId: string): Promise<NextAuthenticatorResponse> {
    const res = await this.postJson(
      mitidUrls.authenticationSessionNext(this.authenticationSessionId),
      { combinationId },
    );
    if (res.status !== 200) {
      throw new MitidError(`POST /next failed (status ${res.status}): ${res.body.slice(0, 300)}`);
    }
    return JSON.parse(res.body) as NextAuthenticatorResponse;
  }

  private applyNextAuthenticator(next: NextAuthenticator): void {
    // The server may use a different label than our human type — notably it
    // returns `TOKEN` for the hardware kodeviser, which we call `CODE_TOKEN`.
    const human = normalizeAuthenticatorType(next.authenticatorType);
    this.currentAuthenticatorType = human;
    this.currentAuthenticatorSessionFlowKey = next.authenticatorSessionFlowKey;
    this.currentAuthenticatorEafeHash = next.eafeHash;
    this.currentAuthenticatorSessionId = next.authenticatorSessionId;
  }

  private assertNoFatalErrors(next: NextAuthenticatorResponse): void {
    const err = next.errors?.[0];
    if (!err) return;
    const text =
      err.userMessage?.text?.text ?? err.message ?? err.errorCode ?? 'unknown MitID error';
    const supportId = (err.userMessage as { supportErrorId?: string } | undefined)?.supportErrorId;

    // CAP008 — MitID's parallel-sessions detector ("user ID in two places at
    // the same time"). Comes through as control.authenticator_cannot_be_started
    // with this specific supportErrorId. Surfaces as a dedicated typed error
    // so the CLI can show a friendly "wait 60 s, close other tabs" hint.
    if (
      supportId === 'CAP008' ||
      /two places at the same time/i.test(text) ||
      /parallel/i.test(text)
    ) {
      throw new MitidParallelSessionError(
        'MitID detected a parallel session: your account is in use elsewhere ' +
          '(another browser tab logging into Aula, a previous failed login that ' +
          "didn't fully tear down, etc.). Wait ~60 seconds, close other Aula " +
          'tabs / sessions, then retry.',
      );
    }

    // Specific error code → typed subclass so callers can branch on it.
    if (err.errorCode === 'control.authenticator_cannot_be_started') {
      throw new MitidAuthenticatorUnavailableError(text);
    }
    // Everything else still surfaces — Python treats any non-empty errors[]
    // as fatal (BrowserClient.py:551, :291). Don't drop them silently.
    throw new MitidError(`MitID /next error${err.errorCode ? ` (${err.errorCode})` : ''}: ${text}`);
  }

  private flowProofContext(): FlowProofContext {
    if (
      !this.currentAuthenticatorSessionId ||
      !this.currentAuthenticatorSessionFlowKey ||
      !this.currentAuthenticatorEafeHash
    ) {
      throw new MitidError('flow-proof context requested before authenticator selected');
    }
    return {
      authenticatorSessionId: this.currentAuthenticatorSessionId,
      authenticatorSessionFlowKey: this.currentAuthenticatorSessionFlowKey,
      clientHash: this.clientHash,
      authenticatorEafeHash: this.currentAuthenticatorEafeHash,
      brokerSecurityContext: this.brokerSecurityContext,
      referenceTextHeader: this.referenceTextHeader,
      referenceTextBody: this.referenceTextBody,
      serviceProviderName: this.serviceProviderName,
    };
  }

  /** JSON POST/PUT helper. Returns AulaResponse-like shape. */
  private async postJson(
    url: string,
    body: unknown,
    method: 'POST' | 'PUT' = 'POST',
  ): Promise<{ status: number; body: string }> {
    const res = await this.http.request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: res.body };
  }
}

function safeJson(text: string): { errorCode?: string } | null {
  try {
    return JSON.parse(text) as { errorCode?: string };
  } catch {
    return null;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new MitidError('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new MitidError('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
