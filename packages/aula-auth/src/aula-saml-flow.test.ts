import { describe, expect, test } from 'bun:test';
import {
  AulaSamlError,
  buildMitidCompletionForm,
  detectConfirmationForm,
  extractBrokerParams,
  extractSamlForm,
  parseBrokerIdpForm,
  parseIdentitySelectionPage,
  parseMitidVerificationToken,
} from './aula-saml-flow.ts';

describe('parseBrokerIdpForm', () => {
  test('returns the form action and sets selectedIdp=nemlogin3 by default', () => {
    const html = `
      <html><body>
        <form action="/auth/realms/broker/login-actions/authenticate?session_code=SC">
          <input type="hidden" name="csrf" value="abc" />
          <input type="hidden" name="other" value="def" />
        </form>
      </body></html>`;
    const out = parseBrokerIdpForm(html);
    expect(out.action).toBe('/auth/realms/broker/login-actions/authenticate?session_code=SC');
    expect(out.data).toEqual({ csrf: 'abc', other: 'def', selectedIdp: 'nemlogin3' });
  });

  test('respects custom IdP field/value', () => {
    const html = '<form action="/x"><input name="csrf" value="abc"/></form>';
    const out = parseBrokerIdpForm(html, { idpField: 'idp', idpValue: 'mitid' });
    expect(out.data.idp).toBe('mitid');
  });

  test('throws if no form is present', () => {
    expect(() => parseBrokerIdpForm('<html></html>')).toThrow(AulaSamlError);
  });
});

describe('parseMitidVerificationToken', () => {
  test('extracts the token from a hidden input', () => {
    const html = `<form><input name="__RequestVerificationToken" value="TOKEN" /></form>`;
    expect(parseMitidVerificationToken(html)).toBe('TOKEN');
  });

  test('throws when token is missing', () => {
    expect(() => parseMitidVerificationToken('<form></form>')).toThrow(AulaSamlError);
  });
});

describe('extractSamlForm', () => {
  test('returns SAMLResponse + RelayState + form action', () => {
    const html = `
      <form action="https://login.aula.dk/sp/acs/app-level3-sp">
        <input name="SAMLResponse" value="SAML"/>
        <input name="RelayState" value="STATE"/>
      </form>`;
    const out = extractSamlForm(html);
    expect(out).toEqual({
      samlResponse: 'SAML',
      relayState: 'STATE',
      hadRelayState: true,
      action: 'https://login.aula.dk/sp/acs/app-level3-sp',
    });
  });

  test('tolerates missing RelayState (issue #310)', () => {
    const html = `<form action="/acs"><input name="SAMLResponse" value="SAML"/></form>`;
    const out = extractSamlForm(html);
    expect(out.samlResponse).toBe('SAML');
    expect(out.relayState).toBe('');
    expect(out.hadRelayState).toBe(false);
    expect(out.action).toBe('/acs');
  });

  test('returns empty action when the form has none', () => {
    const html = `<form><input name="SAMLResponse" value="SAML"/></form>`;
    expect(extractSamlForm(html).action).toBe('');
  });

  test('throws when SAMLResponse is missing', () => {
    expect(() => extractSamlForm('<form></form>')).toThrow(AulaSamlError);
  });
});

describe('parseIdentitySelectionPage', () => {
  const html = `
    <form>
      <input type="hidden" name="csrf" value="x" />
    </form>
    <a class="list-link" data-loginoptions='{"id":"1","name":"Child A"}'>
      <div class="list-link-text">Child A (Forælder)</div>
    </a>
    <a class="list-link" data-loginoptions='{"id":"2","name":"Child B"}'>
      <div class="list-link-text">Child B (Forælder)</div>
    </a>`;

  test('returns one option per identity in document order', () => {
    const { options, formInputs } = parseIdentitySelectionPage(html);
    expect(options).toHaveLength(2);
    expect(options[0]).toEqual({
      index: 1,
      name: 'Child A (Forælder)',
      loginOptionsJson: '{"id":"1","name":"Child A"}',
    });
    expect(options[1]?.index).toBe(2);
    expect(formInputs.csrf).toBe('x');
  });

  test('does not duplicate identities when anchors are wrapped in list-link-box', () => {
    // The live page wraps each anchor in a `div.list-link-box`; the selector
    // matches both the box and its nested anchor. Each identity must appear once.
    const wrapped = `
      <form><input type="hidden" name="csrf" value="x" /></form>
      <div class="list-link-box">
        <a class="list-link" data-loginoptions='{"id":"1","name":"Child A"}'>
          <div class="list-link-text">Child A (Forælder)</div>
        </a>
      </div>
      <div class="list-link-box">
        <a class="list-link" data-loginoptions='{"id":"2","name":"Child B"}'>
          <div class="list-link-text">Child B (Forælder)</div>
        </a>
      </div>`;
    const { options } = parseIdentitySelectionPage(wrapped);
    expect(options).toHaveLength(2);
    expect(options.map((o) => o.name)).toEqual(['Child A (Forælder)', 'Child B (Forælder)']);
    expect(options.map((o) => o.index)).toEqual([1, 2]);
  });

  test('throws when no identity options are present', () => {
    expect(() => parseIdentitySelectionPage('<html></html>')).toThrow(AulaSamlError);
  });
});

describe('extractBrokerParams', () => {
  test('extracts from URL query string', () => {
    const params = extractBrokerParams(
      'https://broker.unilogin.dk/x?session_code=SC&execution=EX&client_id=CID&tab_id=TID',
    );
    expect(params).toEqual({ sessionCode: 'SC', execution: 'EX', clientId: 'CID', tabId: 'TID' });
  });

  test('falls back to form action when URL is missing fields', () => {
    const html = `<form action="https://broker/x?session_code=SC&execution=EX&client_id=CID&tab_id=TID"></form>`;
    const params = extractBrokerParams('https://broker/page', html);
    expect(params.sessionCode).toBe('SC');
    expect(params.execution).toBe('EX');
  });

  test('returns empty strings when nothing is present', () => {
    expect(extractBrokerParams('https://broker/page')).toEqual({
      sessionCode: '',
      execution: '',
      clientId: '',
      tabId: '',
    });
  });
});

describe('detectConfirmationForm', () => {
  test('returns null when no #confirmation-button is present', () => {
    expect(detectConfirmationForm('<html><form></form></html>')).toBeNull();
  });

  test('returns the form to submit when the confirmation button is present', () => {
    const html = `
      <form action="/post-broker-login/confirm">
        <input type="hidden" name="csrf" value="x" />
        <button id="confirmation-button" type="submit">Continue</button>
      </form>`;
    const out = detectConfirmationForm(html);
    expect(out).not.toBeNull();
    expect(out?.action).toBe('/post-broker-login/confirm');
    expect(out?.data).toEqual({ csrf: 'x' });
  });
});

describe('buildMitidCompletionForm', () => {
  test('includes every required param', () => {
    const body = buildMitidCompletionForm({
      verificationToken: 'V',
      authorizationCode: 'AC',
      sessionStorageActiveSessionUuid: 'SU',
      sessionStorageActiveChallenge: 'CH',
    });
    expect(body.get('__RequestVerificationToken')).toBe('V');
    expect(body.get('MitIDAuthCode')).toBe('AC');
    expect(body.get('MitIDUseConfirmed')).toBe('True');
    expect(body.get('SessionStorageActiveSessionUuid')).toBe('SU');
    expect(body.get('SessionStorageActiveChallenge')).toBe('CH');
  });
});
