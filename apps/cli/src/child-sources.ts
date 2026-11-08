/**
 * Which Aula endpoints report which children. `aula whoami` and
 * `aula.discover` take children from `profiles.getProfilesByLogin` only, and
 * at least one family sees fewer children there than the Aula app shows
 * (#150). Two other endpoints also list children: the profile context's
 * `relations` and `consents.getConsentResponses` (which already surfaces
 * club identities that getProfilesByLogin omits). Listing each child with
 * the sources that returned it tells us where the missing one lives before
 * we change how children are resolved.
 *
 * Children are keyed by institution-profile id, so a child enrolled at a
 * school and a club can appear twice, once per institution.
 */

import type { ProfileContextData, ProfilesByLoginData } from '@aula-mcp/aula-client';

export type ChildSource = 'profilesByLogin' | 'profileContext' | 'consents';

export interface ChildSighting {
  id: number;
  name?: string;
  institution?: string;
  sources: ChildSource[];
}

type ConsentEntry = {
  institutionProfile?: {
    id?: number;
    role?: string;
    name?: string;
    fullName?: string;
    institutionName?: string;
  };
};

export function collectChildSightings(
  profiles: ProfilesByLoginData | undefined,
  context: ProfileContextData | undefined,
  consents: unknown,
): ChildSighting[] {
  const byId = new Map<number, ChildSighting>();
  const see = (
    id: number | undefined,
    source: ChildSource,
    name?: string,
    institution?: string,
  ) => {
    if (typeof id !== 'number') return;
    const s = byId.get(id) ?? { id, sources: [] };
    if (!s.sources.includes(source)) s.sources.push(source);
    if (s.name === undefined && name !== undefined) s.name = name;
    if (s.institution === undefined && institution !== undefined) s.institution = institution;
    byId.set(id, s);
  };

  for (const profile of profiles?.profiles ?? []) {
    for (const child of profile.children ?? []) {
      see(child.id, 'profilesByLogin', child.name, child.institutionProfile?.institutionName);
    }
  }

  const contextProfiles = [
    ...(context?.institutionProfile ? [context.institutionProfile] : []),
    ...(context?.institutionProfiles ?? []),
  ];
  for (const ip of contextProfiles) {
    for (const rel of ip.relations ?? []) {
      for (const child of rel.children ?? []) {
        see(child.id, 'profileContext', child.name, rel.institutionName);
      }
    }
  }

  const raw = consents as { data?: ConsentEntry[] } | ConsentEntry[] | null | undefined;
  const entries: ConsentEntry[] = Array.isArray(raw) ? raw : (raw?.data ?? []);
  for (const { institutionProfile: ip } of entries) {
    if (!ip || ip.role === 'guardian') continue;
    see(ip.id, 'consents', ip.fullName ?? ip.name, ip.institutionName);
  }

  return [...byId.values()];
}
