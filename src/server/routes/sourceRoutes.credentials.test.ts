/**
 * `preserveSourceCredentials` — the "leave blank to keep existing" contract.
 *
 * A source's `config` is REPLACED wholesale on update, so any credential the
 * edit form does not resend is gone unless this function carries it forward. A
 * missing branch is silently data-destructive: the save succeeds, the UI says
 * nothing, and the broker starts failing auth on the next reconnect.
 *
 * `meshcore_mqtt` (#5040) was exactly that bug — the fieldset told the user
 * "leave blank to keep existing" while the server had no branch for it.
 */
import { describe, it, expect } from 'vitest';
import { preserveSourceCredentials } from './sourceRoutes.js';

describe('preserveSourceCredentials — meshcore_mqtt (#5040)', () => {
  const existing = { brokerUrl: 'wss://b.example', region: 'MCO', password: 'stored-secret' };

  it('carries the stored password forward when the field is OMITTED', () => {
    // The edit form omits a blank password rather than sending '', so absence
    // is the case that actually happens in the UI.
    const merged = preserveSourceCredentials('meshcore_mqtt', existing, {
      brokerUrl: 'wss://b.example',
      region: 'MCO',
    });
    expect(merged.password).toBe('stored-secret');
  });

  it("carries it forward when the field is sent as ''", () => {
    const merged = preserveSourceCredentials('meshcore_mqtt', existing, {
      brokerUrl: 'wss://b.example',
      region: 'MCO',
      password: '',
    });
    expect(merged.password).toBe('stored-secret');
  });

  it('lets a genuinely new password overwrite the stored one', () => {
    const merged = preserveSourceCredentials('meshcore_mqtt', existing, {
      brokerUrl: 'wss://b.example',
      region: 'MCO',
      password: 'new-secret',
    });
    expect(merged.password).toBe('new-secret');
  });

  it('adds no password when there was none stored', () => {
    const merged = preserveSourceCredentials(
      'meshcore_mqtt',
      { brokerUrl: 'wss://b.example', region: 'MCO' },
      { brokerUrl: 'wss://b.example', region: 'MCO' },
    );
    expect(merged).not.toHaveProperty('password');
  });

  it('passes non-credential fields through unchanged', () => {
    const merged = preserveSourceCredentials('meshcore_mqtt', existing, {
      brokerUrl: 'wss://other.example',
      region: 'AMS',
      autoConnect: false,
    });
    expect(merged).toMatchObject({
      brokerUrl: 'wss://other.example',
      region: 'AMS',
      autoConnect: false,
      password: 'stored-secret',
    });
  });
});

describe('preserveSourceCredentials — existing types still behave', () => {
  it('keeps a nested mqtt_broker auth.password', () => {
    const merged = preserveSourceCredentials(
      'mqtt_broker',
      { auth: { username: 'u', password: 'stored' } },
      { auth: { username: 'u', password: '' } },
    );
    expect((merged.auth as { password: string }).password).toBe('stored');
  });

  it('keeps a nested mqtt_bridge upstream.password', () => {
    const merged = preserveSourceCredentials(
      'mqtt_bridge',
      { upstream: { host: 'h', password: 'stored' } },
      { upstream: { host: 'h', password: '' } },
    );
    expect((merged.upstream as { password: string }).password).toBe('stored');
  });

  it('does not invent a password for a type that has none', () => {
    const merged = preserveSourceCredentials('meshtastic_tcp', { host: 'h' }, { host: 'h2' });
    expect(merged).toEqual({ host: 'h2' });
  });
});
