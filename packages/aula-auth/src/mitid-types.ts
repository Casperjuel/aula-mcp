/**
 * MitID JSON wire types. Names mirror the on-the-wire field names exactly so
 * spotting drift between the spec and our parsing is easy.
 *
 * MitID's API generally wraps every "primitive" value in `{ value: T }`, even
 * for scalar fields like `randomA`. We replicate that.
 */

/** Aula's three "human" authenticator names. CODE_TOKEN is what Aula calls
 *  "kodeviser" in Danish — the physical hardware code generator. */
export type MitidAuthenticatorType = 'APP' | 'CODE_TOKEN' | 'PASSWORD';

/**
 * The Python reference uses 'TOKEN' as the human alias for combination IDs S1.
 * Aula UI calls this "kodeviser". We use 'CODE_TOKEN' for clarity but keep a
 * mapping for combination IDs.
 */
export const COMBINATION_ID_TO_AUTHENTICATOR: Readonly<Record<string, MitidAuthenticatorType>> =
  Object.freeze({
    S4: 'APP', // App + MitID chip
    S3: 'APP',
    L2: 'APP',
    S1: 'CODE_TOKEN',
  });

export const AUTHENTICATOR_TO_COMBINATION_ID: Readonly<Record<MitidAuthenticatorType, string>> =
  Object.freeze({
    APP: 'S3',
    CODE_TOKEN: 'S1',
    PASSWORD: '', // reached implicitly after CODE_TOKEN
  });

/**
 * Which combination ID to send for each authenticator, given the
 * `combinations` MitID offered after identifyAsUser. One authenticator can
 * hide behind several IDs — an APP user may be offered S3, S4 (app + chip) or
 * L2 (low-assurance app) — and /next rejects an ID it didn't offer, so always
 * sending the static S3 fails the login for S4/L2-only accounts (upstream
 * scaarup/aula#365). Prefer the static ID when it was offered, else the first
 * offered ID for that authenticator. Unknown IDs are skipped.
 */
export function resolveOfferedCombinationIds(
  combinations: ReadonlyArray<{ id: string }>,
): Partial<Record<MitidAuthenticatorType, string>> {
  const offered: Partial<Record<MitidAuthenticatorType, string[]>> = {};
  for (const combo of combinations) {
    const human = COMBINATION_ID_TO_AUTHENTICATOR[combo.id];
    if (!human) continue;
    offered[human] = [...(offered[human] ?? []), combo.id];
  }
  const resolved: Partial<Record<MitidAuthenticatorType, string>> = {};
  for (const [human, ids] of Object.entries(offered) as Array<[MitidAuthenticatorType, string[]]>) {
    const preferred = AUTHENTICATOR_TO_COMBINATION_ID[human];
    resolved[human] = ids.includes(preferred) ? preferred : (ids[0] as string);
  }
  return resolved;
}

/**
 * Normalize the server's raw `authenticatorType` string into our human type.
 *
 * The MitID backend labels the hardware code generator ("kodeviser") as
 * `TOKEN`, while we call it `CODE_TOKEN` everywhere (matching Aula's UI and
 * the combination-id table above). Without this, an account that logs in with
 * a physical kodeviser gets `currentAuthenticatorType = 'TOKEN'`, and the
 * `selectAuthenticator('CODE_TOKEN')` guard then throws because the strings
 * don't match.
 *
 * `APP` and `PASSWORD` pass through unchanged. Unknown values are returned
 * as-is (cast), so a genuinely new authenticator surfaces loudly downstream
 * rather than being silently swallowed.
 */
export function normalizeAuthenticatorType(raw: string): MitidAuthenticatorType {
  if (raw === 'TOKEN') return 'CODE_TOKEN';
  return raw as MitidAuthenticatorType;
}

/** Returned by `GET /authentication-sessions/{id}` on construction. */
export interface AuthenticationSessionResponse {
  brokerSecurityContext: string;
  serviceProviderName: string;
  referenceTextHeader: string;
  referenceTextBody: string;
}

/** Shape of `nextAuthenticator` — the only field we actually use from /next. */
export interface NextAuthenticator {
  authenticatorType: string;
  authenticatorSessionFlowKey: string;
  eafeHash: string;
  authenticatorSessionId: string;
}

/** Raw response from `POST /next`. Errors shaped per Python parse path. */
export interface NextAuthenticatorResponse {
  nextAuthenticator?: NextAuthenticator;
  combinations?: ReadonlyArray<{
    id: string;
    combinationItems: ReadonlyArray<{ name: string }>;
  }>;
  errors?: ReadonlyArray<{
    errorCode?: string;
    message?: string;
    userMessage?: { text?: { text?: string } };
  }>;
  /** Set after PASSWORD prove; named differently because MitID. */
  nextSessionId?: string;
}

/** Returned by `POST /init-auth` (APP). Polled via `pollUrl`. */
export interface AppInitAuthResponse {
  pollUrl: string;
  ticket: string;
  errorCode?: string;
}

/** Single poll response shape. We discriminate on `status`. */
export interface AppPollResponse {
  status: string;
  channelBindingValue?: string;
  updateCount?: number;
  confirmation?: boolean;
  payload?: {
    response: string;
    responseSignature: string;
  };
}

/** Common SRP init response (init / codetoken-init / password-init). */
export interface SrpInitResponse {
  pbkdf2Salt?: { value: string };
  srpSalt: { value: string };
  randomB: { value: string };
}

/** Response from `PUT /finalization`. */
export interface FinalizationResponse {
  authorizationCode: string;
}

/** What `identifyAsUser` returns to the caller — the available auth methods. */
export type AvailableAuthenticators = Partial<Record<MitidAuthenticatorType, string>>;
