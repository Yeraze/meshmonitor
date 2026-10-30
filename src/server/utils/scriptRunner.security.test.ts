import { describe, it, expect } from 'vitest';
import { isSecretEnvKey, sanitizeScriptEnv, buildScriptChildEnv } from './scriptRunner.js';

// Regression coverage for the C1 script-engine findings:
//   INJ-01 (#6052)  — server secrets must never reach a user script's env.
//   MISC-01 (#6057) — Python must not import a shadow module from the scripts dir.

describe('isSecretEnvKey', () => {
  it('flags the named server secrets', () => {
    for (const k of [
      'SESSION_SECRET',
      'ADMIN_PASSWORD',
      'DATABASE_URL',
      'DATABASE_PATH',
      'OIDC_CLIENT_SECRET',
      'OIDC_ISSUER',
      'VAPID_PRIVATE_KEY',
      'VAPID_PUBLIC_KEY',
      'SMTP_PASSWORD',
      'SMTP_HOST',
    ]) {
      expect(isSecretEnvKey(k), k).toBe(true);
    }
  });

  it('flags anything whose name advertises a secret', () => {
    for (const k of ['MY_API_KEY', 'SOME_TOKEN', 'X_CREDENTIAL', 'FOO_PASSWORD', 'APIKEY']) {
      expect(isSecretEnvKey(k), k).toBe(true);
    }
  });

  it('leaves the mundane process environment alone', () => {
    for (const k of ['PATH', 'HOME', 'LANG', 'PYTHONPATH', 'NODE_PATH', 'MESHTASTIC_IP', 'NODE_NUM', 'SHORT_NAME']) {
      expect(isSecretEnvKey(k), k).toBe(false);
    }
  });
});

describe('sanitizeScriptEnv', () => {
  it('drops every secret key but keeps the rest', () => {
    const out = sanitizeScriptEnv({
      SESSION_SECRET: 'leak-me',
      ADMIN_PASSWORD: 'leak-me',
      DATABASE_URL: 'postgres://leak',
      OIDC_CLIENT_SECRET: 'leak',
      PATH: '/usr/bin',
      MESHTASTIC_IP: '127.0.0.1',
    });
    expect(out.SESSION_SECRET).toBeUndefined();
    expect(out.ADMIN_PASSWORD).toBeUndefined();
    expect(out.DATABASE_URL).toBeUndefined();
    expect(out.OIDC_CLIENT_SECRET).toBeUndefined();
    expect(out.PATH).toBe('/usr/bin');
    expect(out.MESHTASTIC_IP).toBe('127.0.0.1');
  });

  it('does not mutate the input', () => {
    const input = { SESSION_SECRET: 'x', PATH: '/bin' };
    sanitizeScriptEnv(input);
    expect(input.SESSION_SECRET).toBe('x');
  });
});

describe('buildScriptChildEnv', () => {
  it('strips secrets for every interpreter', () => {
    const out = buildScriptChildEnv({ SESSION_SECRET: 'x', PATH: '/bin' }, 'sh');
    expect(out.SESSION_SECRET).toBeUndefined();
    expect(out.PATH).toBe('/bin');
  });

  it('sets PYTHONSAFEPATH for Python so the scripts dir cannot shadow modules', () => {
    const out = buildScriptChildEnv({ PATH: '/bin' }, 'py');
    expect(out.PYTHONSAFEPATH).toBe('1');
  });

  it('does not set PYTHONSAFEPATH for non-Python interpreters', () => {
    expect(buildScriptChildEnv({ PATH: '/bin' }, 'js').PYTHONSAFEPATH).toBeUndefined();
    expect(buildScriptChildEnv({ PATH: '/bin' }, 'sh').PYTHONSAFEPATH).toBeUndefined();
  });
});
