import { describe, expect, test } from 'bun:test';
import { AulaBotDefenseError, botDefenseMessage, isBotDefenseHost } from './aula-login-client.ts';

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
