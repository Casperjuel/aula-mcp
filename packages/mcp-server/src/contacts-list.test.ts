/**
 * aula.contacts.list must show phone numbers, email and address only where
 * Aula's own contacts page shows them. Every name, number and address below
 * is invented for this file.
 */

import { describe, expect, test } from 'bun:test';
import { registerTools } from './tools.ts';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
}>;

const MOTHER = {
  id: 501,
  fullName: 'Mor Testesen',
  role: 'guardian',
  relation: 'Mor',
  userHasGivenConsentToShowContactInformation: true,
  mobilePhoneNumber: '11223344',
  email: 'mor@example.invalid',
  address: { street: 'Testvej 1', postalCode: 9999, postalDistrict: 'Testby' },
};

const OTHER_PARENT = {
  id: 502,
  fullName: 'Far Prøvesen',
  role: 'guardian',
  relation: 'Far',
  userHasGivenConsentToShowContactInformation: false,
  mobilePhoneNumber: '99887766',
  email: 'skjult@example.invalid',
  address: { street: 'Skjultvej 2', postalCode: 9999, postalDistrict: 'Testby' },
};

function register(rows: unknown) {
  const calls: Array<Record<string, unknown>> = [];
  const fakeClient = {
    async getContactList(opts: Record<string, unknown>) {
      calls.push(opts);
      return rows;
    },
  };
  const context = {
    async getClient() {
      return fakeClient;
    },
    async getGuardianUserId() {
      return '5000';
    },
  };
  let handler: ToolHandler | undefined;
  const server = {
    registerTool(name: string, _config: unknown, fn: ToolHandler) {
      if (name === 'aula.contacts.list') handler = fn;
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: structural stubs for McpServer/AulaContext
  registerTools(server as any, context as any);
  if (!handler) throw new Error('aula.contacts.list was not registered');
  const registered = handler;
  return {
    async list(args: Record<string, unknown>): Promise<string> {
      const res = await registered(args);
      const [first] = res.content;
      if (!first) throw new Error('tool returned no content');
      return first.text;
    },
    calls,
  };
}

describe('aula.contacts.list', () => {
  test('a list row shows contact details only with consent, view right and no alias', async () => {
    const visible = { ...MOTHER, currentUserCanViewContactInformation: true };
    const noConsent = { ...OTHER_PARENT, currentUserCanViewContactInformation: true };
    const alias = {
      ...MOTHER,
      id: 503,
      fullName: 'Alias Testesen',
      mobilePhoneNumber: '55554444',
      email: 'alias@example.invalid',
      currentUserCanViewContactInformation: true,
      alias: true,
    };
    // Consent given, but Aula does not let this user see the details.
    const noViewRight = {
      ...MOTHER,
      id: 504,
      fullName: 'Mor Afprøvesen',
      mobilePhoneNumber: '33332222',
      email: 'noview@example.invalid',
    };
    // The contact list sends some alias profiles without the flag, only with
    // Aula's placeholder name.
    const placeholderAlias = {
      ...MOTHER,
      id: 505,
      fullName: undefined,
      firstName: 'Alias-fornavn',
      lastName: 'Alias-efternavn',
      mobilePhoneNumber: '66665555',
      currentUserCanViewContactInformation: true,
    };
    const { list, calls } = register([visible, noConsent, alias, noViewRight, placeholderAlias]);
    const text = await list({ groupId: 11, filter: 'guardian' });
    expect(text).not.toContain('33332222');
    expect(text).not.toContain('noview@example.invalid');
    expect(text).not.toContain('66665555');
    // Known negatives: no consent, and an alias profile.
    expect(text).not.toContain('99887766');
    expect(text).not.toContain('skjult@example.invalid');
    expect(text).not.toContain('Skjultvej');
    expect(text).not.toContain('55554444');
    expect(text).not.toContain('alias@example.invalid');
    // Known positive: consent given and Aula lets this user see it.
    expect(text).toContain('11223344');
    expect(text).toContain('mor@example.invalid');
    expect(text).toContain('Testvej 1');
    // Names stay: the list is still a member list.
    expect(text).toContain('Far Prøvesen');
    expect(calls).toHaveLength(1);
  });

  test("a child's guardians (the default filter) follow the same consent", async () => {
    const child = {
      id: 601,
      fullName: 'Barn Testesen',
      role: 'child',
      // A child's address is never shown on Aula's contacts page.
      userHasGivenConsentToShowContactInformation: true,
      currentUserCanViewContactInformation: true,
      address: { street: 'Barnevej 3', postalCode: 9999, postalDistrict: 'Testby' },
      relations: [MOTHER, OTHER_PARENT],
    };
    const { list } = register([child]);
    const text = await list({ groupId: 11 });
    expect(text).not.toContain('99887766');
    expect(text).not.toContain('skjult@example.invalid');
    expect(text).not.toContain('Barnevej');
    expect(text).toContain('11223344');
    expect(text).toContain('Far Prøvesen');
  });

  test('relations in a shape other than a list are dropped, not passed through', async () => {
    const child = { id: 602, fullName: 'Barn Prøvesen', role: 'child', relations: OTHER_PARENT };
    const { list } = register([child]);
    const text = await list({ groupId: 11 });
    expect(text).not.toContain('99887766');
    expect(text).not.toContain('skjult@example.invalid');
    expect(text).toContain('Barn Prøvesen');
  });

  test('an answer that is not a list of rows is an error, not passed through', async () => {
    const { list } = register({ rows: [{ ...OTHER_PARENT }] });
    const text = await list({ groupId: 11 });
    expect(text).not.toContain('99887766');
    expect(JSON.parse(text)).toMatchObject({ error: 'unexpected_shape' });
  });

  test('refuses a filter the consent rules have not been checked for', async () => {
    const { list, calls } = register([
      { ...OTHER_PARENT, currentUserCanViewContactInformation: true },
    ]);
    const out = JSON.parse(await list({ groupId: 11, filter: 'all' })) as Record<string, unknown>;
    expect(out).toMatchObject({ error: 'unsupported_filter' });
    expect(calls).toEqual([]);
  });
});
