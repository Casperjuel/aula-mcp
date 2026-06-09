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
