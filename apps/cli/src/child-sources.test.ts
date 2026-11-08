import { describe, expect, test } from 'bun:test';
import type { ProfileContextData, ProfilesByLoginData } from '@aula-mcp/aula-client';
import { collectChildSightings } from './child-sources.ts';

const profiles: ProfilesByLoginData = {
  profiles: [
    {
      profileId: 1,
      displayName: 'Guardian',
      children: [
        { id: 11, name: 'A', institutionProfile: { id: 11, institutionName: 'School' } },
        { id: 12, name: 'B' },
      ],
    },
  ],
};

const context: ProfileContextData = {
  userId: 'g1',
  institutionProfile: {
    id: 100,
    relations: [
      {
        institutionCode: 'X1',
        institutionName: 'Daycare',
        children: [
          { id: 12, name: 'B' },
          { id: 13, name: 'C' },
        ],
      },
    ],
  },
};

const consents = [
  { institutionProfile: { id: 100, role: 'guardian' } },
  { institutionProfile: { id: 11, role: 'child' } },
  { institutionProfile: { id: 11, role: 'child' } },
  { institutionProfile: { id: 14, role: 'child', name: 'D' } },
];

describe('collectChildSightings', () => {
  test('merges children from all three sources by institution-profile id', () => {
    const out = collectChildSightings(profiles, context, consents);
    const byId = Object.fromEntries(out.map((c) => [c.id, c]));
    expect(Object.keys(byId).map(Number).sort()).toEqual([11, 12, 13, 14]);
    expect(byId[11]?.sources).toEqual(['profilesByLogin', 'consents']);
    expect(byId[11]?.institution).toBe('School');
    expect(byId[12]?.sources).toEqual(['profilesByLogin', 'profileContext']);
    expect(byId[13]).toEqual({
      id: 13,
      name: 'C',
      institution: 'Daycare',
      sources: ['profileContext'],
    });
    expect(byId[14]?.name).toBe('D');
  });

  test('skips guardian consent entries and tolerates missing sources', () => {
    expect(collectChildSightings(undefined, undefined, { data: consents.slice(0, 1) })).toEqual([]);
    expect(collectChildSightings(undefined, undefined, null)).toEqual([]);
  });
});
