/**
 * Script Secrets reach the child env through buildScriptChildEnv, after the
 * INJ-01 deny filter — and only there. They never override a variable the
 * caller or process set, never use a reserved name, and never reach the
 * dependency installer's env (sanitizeScriptEnv).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { buildScriptChildEnv, sanitizeScriptEnv, runScript, isReservedScriptSecretName } from './scriptRunner.js';
import { setScriptSecretsSnapshot } from './scriptSecretsSnapshot.js';

const VALUE = 'sk-live-RUNNER-SENTINEL-55aa';

let scriptsRoot: string;
let originalDataDir: string | undefined;

beforeAll(() => {
  scriptsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'script-secrets-runner-'));
  fs.mkdirSync(path.join(scriptsRoot, 'scripts'), { recursive: true });
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = scriptsRoot;
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(scriptsRoot, { recursive: true, force: true });
});

afterEach(() => setScriptSecretsSnapshot(new Map()));

describe('buildScriptChildEnv with Script Secrets', () => {
  it('adds a stored secret, even one whose name the deny filter would strip', () => {
    setScriptSecretsSnapshot(new Map([['OPENAI_API_KEY', VALUE], ['WEATHER_KEY', 'w']]));
    const env = buildScriptChildEnv({ PATH: '/usr/bin', OPENAI_API_KEY: 'from-container' }, 'sh');
    expect(env.OPENAI_API_KEY).toBe(VALUE);
    expect(env.WEATHER_KEY).toBe('w');
  });

  it('never overrides a variable the caller or process set', () => {
    setScriptSecretsSnapshot(new Map([['CITY', 'from-secret']]));
    const env = buildScriptChildEnv({ PATH: '/usr/bin', CITY: 'from-caller' }, 'sh');
    expect(env.CITY).toBe('from-caller');
  });

  it('drops reserved names even if they reach the snapshot', () => {
    setScriptSecretsSnapshot(
      new Map([
        ['PATH', '/evil'],
        ['MESSAGE', 'spoof'],
        ['PARAM_CITY', 'spoof'],
        ['SESSION_SECRET', 'x'],
        ['DATABASE_URL', 'x'],
        ['LD_PRELOAD', '/evil.so'],
        ['NODE_OPTIONS', '--require /evil'],
        ['PYTHONSAFEPATH', '0'],
        ['lower', 'x'],
      ]),
    );
    const env = buildScriptChildEnv({ PATH: '/usr/bin' }, 'py');
    expect(env.PATH).toBe('/usr/bin');
    for (const k of ['MESSAGE', 'PARAM_CITY', 'SESSION_SECRET', 'DATABASE_URL', 'LD_PRELOAD', 'NODE_OPTIONS', 'lower']) {
      expect(env[k], k).toBeUndefined();
    }
    expect(env.PYTHONSAFEPATH).toBe('1');
  });

  it('keeps PYTHONSAFEPATH=1 for Python', () => {
    setScriptSecretsSnapshot(new Map([['WEATHER_KEY', 'w']]));
    expect(buildScriptChildEnv({}, 'py').PYTHONSAFEPATH).toBe('1');
  });

  it('drops a value holding a NUL', () => {
    setScriptSecretsSnapshot(new Map([['WEATHER_KEY', 'a\0b']]));
    expect(buildScriptChildEnv({}, 'sh').WEATHER_KEY).toBeUndefined();
  });

  it('sanitizeScriptEnv (the dependency installer env) never gets secrets', () => {
    setScriptSecretsSnapshot(new Map([['WEATHER_KEY', VALUE]]));
    expect(sanitizeScriptEnv({ PATH: '/usr/bin' }).WEATHER_KEY).toBeUndefined();
  });

  it('reserves shell/loader controls, in any letter case', () => {
    for (const name of ['SHELLOPTS', 'BASHOPTS', 'PS4', 'GCONV_PATH', 'OPENSSL_CONF', 'OPENSSL_MODULES', 'Path', 'ld_preload', 'pythonpath']) {
      expect(isReservedScriptSecretName(name), name).toBe(true);
    }
    expect(isReservedScriptSecretName('HTTPS_PROXY')).toBe(false);
    expect(isReservedScriptSecretName('SSL_CERT_FILE')).toBe(false);
  });

  it('does not add a secret whose name the caller set in another letter case (Windows env)', () => {
    setScriptSecretsSnapshot(new Map([['COMSPEC', 'evil.exe']]));
    const env = buildScriptChildEnv({ ComSpec: 'C:\\Windows\\cmd.exe' }, 'sh');
    expect(env.COMSPEC).toBeUndefined();
    expect(env.ComSpec).toBe('C:\\Windows\\cmd.exe');
  });

  it('reserves caller families and process basics', () => {
    for (const name of ['PATH', 'HOME', 'MSG_TEXT', 'MM_SOURCE_ID', 'FROM_NODE', 'MESHCORE_SOURCE_ID', 'TIMER_NAME', 'GEOFENCE_ID', 'NODE_ID', 'PYTHONPATH', 'OIDC_CLIENT_SECRET', 'ADMIN_PASSWORD']) {
      expect(isReservedScriptSecretName(name), name).toBe(true);
    }
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PIRATE_WEATHER_API_KEY', 'GITHUB_TOKEN', 'MM_API_TOKEN', 'MM_API_URL']) {
      expect(isReservedScriptSecretName(name), name).toBe(false);
    }
  });
});

describe('runScript end to end', () => {
  it('a shell script reads the secret from its environment', async () => {
    fs.writeFileSync(path.join(scriptsRoot, 'scripts', 'echo-secret.sh'), 'printf "%s" "$WEATHER_KEY"\n', { mode: 0o755 });
    setScriptSecretsSnapshot(new Map([['WEATHER_KEY', VALUE]]));
    const r = await runScript({ scriptPath: 'echo-secret.sh', env: {} });
    expect(r.success).toBe(true);
    expect(r.stdout).toBe(VALUE);
  });

  it('masks the secret in the failure message (execFile quotes stderr there)', async () => {
    fs.writeFileSync(path.join(scriptsRoot, 'scripts', 'fail-secret.sh'), 'echo "$WEATHER_KEY" >&2\nexit 3\n', { mode: 0o755 });
    setScriptSecretsSnapshot(new Map([['WEATHER_KEY', VALUE]]));
    const r = await runScript({ scriptPath: 'fail-secret.sh', env: {} });
    expect(r.success).toBe(false);
    expect(r.error ?? '').not.toContain(VALUE);
  });
});
