import type { AulaClient } from '@aula-mcp/aula-client';

type ConsentEntry = {
  institutionProfile?: {
    id?: number;
    role?: string; // "guardian" | "child"
  };
};

/**
 * Every institution profile (guardian + child, across all institutions) for
 * the authenticated guardian, read from consents.getConsentResponses — the
 * only endpoint that surfaces the club child identity that profiles.list and
 * discover both omit. Returns a guardian id first so the posts call is
 * authorized. Only the logged-in user's own profiles appear here, so the
 * other parent can never leak in.
 */
export async function resolveFamilyProfileIds(
  client: Pick<AulaClient, 'rawRequest'>,
): Promise<number[]> {
  // rawRequest unwraps the Aula envelope to `.data`, so this is the
  // consent-entry array directly. Guard against either shape regardless.
  const raw = (await client.rawRequest('consents.getConsentResponses', {
    returnOnlyPendingConsentResponses: 'false',
  })) as { data?: ConsentEntry[] } | ConsentEntry[] | null;

  const entries: ConsentEntry[] = Array.isArray(raw) ? raw : (raw?.data ?? []);

  const guardianIds: number[] = [];
  const childIds: number[] = [];
  for (const { institutionProfile: ip } of entries) {
    if (!ip?.id) continue;
    (ip.role === 'guardian' ? guardianIds : childIds).push(ip.id);
  }

  if (guardianIds.length === 0) {
    throw new Error(
      'resolveFamilyProfileIds: consents.getConsentResponses returned no guardian ' +
        'profile to authorize the request.',
    );
  }
  // Guardian(s) first, then children; dedupe.
  return [...new Set([...guardianIds, ...childIds])];
}
