import { describe, it, expect } from 'vitest';
import {
  endpointIdentity,
  hasHiddenUrlParts,
  hasStoredSecret,
  isMaskedForViewer,
  storedSecretWillBeDropped,
} from './DashboardPage.maskedFields';

describe('stored credentials in the source form', () => {
  const admin = { config: { password: 'p', upstream: { url: 'mqtt://h', password: 'q' }, token: '' } };
  const editor = {
    config: { upstream: { url: 'mqtt://h' } },
    maskedConfigFields: ['upstream.password', 'upstream.url'],
  };

  it('reads a stored secret from the full config an admin gets', () => {
    expect(isMaskedForViewer(admin)).toBe(false);
    expect(hasStoredSecret(admin, 'password')).toBe(true);
    expect(hasStoredSecret(admin, 'upstream.password')).toBe(true);
    expect(hasStoredSecret(admin, 'token')).toBe(false);
    expect(hasStoredSecret(admin, 'auth.password')).toBe(false);
  });

  it('reads a stored secret from the masked-field list an editor gets', () => {
    expect(isMaskedForViewer(editor)).toBe(true);
    expect(hasStoredSecret(editor, 'upstream.password')).toBe(true);
    expect(hasStoredSecret(editor, 'password')).toBe(false);
  });

  it('never reports a stored secret with no source', () => {
    expect(hasStoredSecret(undefined, 'password')).toBe(false);
    expect(hasStoredSecret(null, 'password')).toBe(false);
  });

  it('reports hidden URL parts only from the masked-field list', () => {
    expect(hasHiddenUrlParts(editor, 'upstream.url')).toBe(true);
    expect(hasHiddenUrlParts(editor, 'brokerUrl')).toBe(false);
    expect(hasHiddenUrlParts(admin, 'upstream.url')).toBe(false);
  });

  it('compares endpoints by scheme, host and port', () => {
    expect(endpointIdentity('WSS://u:p@Host:443/a?b#c')).toBe('wss://host:443');
    expect(endpointIdentity(' host:1883 ')).toBe('host:1883');
    expect(endpointIdentity('mqtt://u:p@ss@host')).toBe('mqtt://host');
  });

  it('warns only a non-admin, only for a stored secret left blank, only on an endpoint change', () => {
    const drop = (source: unknown, typed: string, to: string) =>
      storedSecretWillBeDropped(source as never, 'upstream.password', typed, 'mqtt://h:1883/a', to);
    expect(drop(editor, '', 'mqtt://other:1883')).toBe(true);
    expect(drop(editor, '', 'mqtts://h:1883')).toBe(true);
    expect(drop(editor, '', 'mqtt://h:1883/b')).toBe(false);
    expect(drop(editor, 'typed', 'mqtt://other:1883')).toBe(false);
    expect(drop(admin, '', 'mqtt://other:1883')).toBe(false);
    expect(drop({ config: {}, maskedConfigFields: [] }, '', 'mqtt://other:1883')).toBe(false);
  });
});
