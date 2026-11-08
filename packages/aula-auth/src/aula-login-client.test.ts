import { describe, expect, test } from 'bun:test';
import {
  AulaBotDefenseError,
  AulaLoginClient,
  botDefenseMessage,
  isBotDefenseHost,
} from './aula-login-client.ts';

/**
 * STIL put a bot-defense gateway in front of the Unilogin broker (#83). The
 * chain walker cannot get past it and is not meant to try — what matters is
 * that it says so clearly instead of reporting a generic unexpected host,
 * because the fix is operational (log in elsewhere, move the tokens) rather
 * than something the user can change in the client.
 */
describe('bot-defense detection', () => {
  test('recognises the STIL security-check host', () => {
    expect(isBotDefenseHost('security-check.stil.dk')).toBe(true);
  });

  test('does not swallow the ordinary hosts in the chain', () => {
    expect(isBotDefenseHost('broker.unilogin.dk')).toBe(false);
    expect(isBotDefenseHost('nemlog-in.mitid.dk')).toBe(false);
    expect(isBotDefenseHost('login.aula.dk')).toBe(false);
    // Nor a lookalike that merely mentions the domain.
    expect(isBotDefenseHost('security-check.stil.dk.evil.example')).toBe(false);
  });
});

describe('botDefenseMessage', () => {
  const msg = botDefenseMessage('security-check.stil.dk', 3);

  test('names the host and the hop it happened at', () => {
    expect(msg).toContain('security-check.stil.dk');
    expect(msg).toContain('hop 3');
  });

  test('says plainly that this is upstream, not a local bug', () => {
    expect(msg).toContain('not a bug in aula-mcp');
  });

  test('heads off the two things people try first', () => {
    // The user-agent is the usual first guess, and it does not help.
    expect(msg).toContain('user-agent');
    expect(msg).toContain('datacenter');
  });

  test('gives the workaround that actually works', () => {
    expect(msg).toContain('aula tokens export');
    // Refresh never touches the broker, which is why the workaround holds.
    expect(msg).toContain('never touches the broker');
  });
});

describe('AulaBotDefenseError', () => {
  test('is distinguishable from a generic login failure', () => {
    const err = new AulaBotDefenseError(botDefenseMessage('security-check.stil.dk', 3));
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AulaBotDefenseError');
  });
});

/**
 * Issue #114: identities linked to a private organisation must go through
 * Loginvælger -> "Lokalt login" (showIdpList) -> "MitID for privat organisation"
 * (selectedIdp=nemlogin3_privat). The page shapes below are the real ones,
 * with the session parameters replaced.
 */
describe('private-organisation IdP selection', () => {
  const ACTION =
    'https://broker.unilogin.dk/auth/realms/broker/login-actions/authenticate?session_code=SC&execution=EX';
  const loginvaelger = `
    <form method="post" action="${ACTION.replace(/&/g, '&amp;')}" class="form">
      <button type="submit" disabled="disabled" name="selectedIdp" value="uni_idp"></button>
      <button type="submit" name="selectedIdp" value="nemlogin3"></button>
      <button type="submit" name="showIdpList" value="">Lokalt login</button>
    </form>`;
  const idpList = `
    <form method="post" action="${ACTION.replace(/&/g, '&amp;')}">
      <button type="submit" name="selectedIdp" value="nemlogin3_privat">MitID for privat organisation</button>
      <button type="submit" name="selectedIdp" value="aabenraa">Aabenraa Skoler</button>
    </form>`;

  type Call = { url: string; body: string };
  function fakeClient(responses: Array<{ status: number; body?: string; location?: string }>) {
    const calls: Call[] = [];
    const http = {
      request: async (url: string, opts: { body?: URLSearchParams } = {}) => {
        calls.push({ url, body: opts.body?.toString() ?? '' });
        const r = responses.shift();
        if (!r) throw new Error('unexpected request');
        return {
          status: r.status,
          url,
          body: r.body ?? '',
          headers: new Headers(r.location ? { location: r.location } : {}),
        };
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double for the HTTP client
    return { client: new AulaLoginClient({ http: http as any }), calls };
  }
  // biome-ignore lint/suspicious/noExplicitAny: exercising a private step directly
  const select = (c: AulaLoginClient) => (c as any).selectListedBrokerIdp.bind(c);

  test('submits showIdpList, then nemlogin3_privat, and follows the redirect', async () => {
    const { client, calls } = fakeClient([
      { status: 200, body: idpList },
      {
        status: 303,
        location: '/auth/realms/broker/broker/nemlogin3_privat/login?session_code=SC',
      },
    ]);
    const out = await select(client)(loginvaelger, ACTION, 'private-organisation');
    expect(out.nextUrl).toBe(
      'https://broker.unilogin.dk/auth/realms/broker/broker/nemlogin3_privat/login?session_code=SC',
    );
    expect(calls[0]?.body).toBe('showIdpList=');
    expect(calls[1]?.body).toBe('selectedIdp=nemlogin3_privat');
  });

  test('fails clearly when the list does not offer the IdP', async () => {
    const { client } = fakeClient([
      { status: 200, body: idpList.replace('nemlogin3_privat', 'x') },
    ]);
    await expect(select(client)(loginvaelger, ACTION, 'private-organisation')).rejects.toThrow(
      /does not offer "nemlogin3_privat"/,
    );
  });

  test('fails clearly when selecting the IdP does not redirect', async () => {
    const { client } = fakeClient([
      { status: 200, body: idpList },
      { status: 200, body: 'x' },
    ]);
    await expect(select(client)(loginvaelger, ACTION, 'private-organisation')).rejects.toThrow(
      /did not redirect/,
    );
  });
});
