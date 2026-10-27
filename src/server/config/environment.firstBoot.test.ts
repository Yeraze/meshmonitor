/**
 * First-boot env vars for headless installs (#5874):
 * ENABLE_VIRTUAL_NODE, VIRTUAL_NODE_PORT and ADMIN_PASSWORD.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getEnvironmentConfig,
  parseAdminPassword,
  parseVirtualNodeEnv,
  resetEnvironmentConfig,
} from './environment.js';

describe('parseVirtualNodeEnv', () => {
  it('is off with the 4404 default when nothing is set', () => {
    const warn = vi.fn();
    expect(parseVirtualNodeEnv({}, warn)).toEqual({
      enabled: false, enabledProvided: false, port: 4404, portProvided: false,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['true', 'TRUE', '1', 'yes', ' Yes '])('treats ENABLE_VIRTUAL_NODE=%s as on', (v) => {
    const r = parseVirtualNodeEnv({ ENABLE_VIRTUAL_NODE: v });
    expect(r.enabled).toBe(true);
    expect(r.port).toBe(4404);
  });

  it.each(['false', '0', 'no', 'NO'])('treats ENABLE_VIRTUAL_NODE=%s as off without a warning', (v) => {
    const warn = vi.fn();
    expect(parseVirtualNodeEnv({ ENABLE_VIRTUAL_NODE: v }, warn).enabled).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and stays off for an unknown ENABLE_VIRTUAL_NODE value', () => {
    const warn = vi.fn();
    expect(parseVirtualNodeEnv({ ENABLE_VIRTUAL_NODE: 'maybe' }, warn).enabled).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('accepts a valid VIRTUAL_NODE_PORT', () => {
    const r = parseVirtualNodeEnv({ ENABLE_VIRTUAL_NODE: 'true', VIRTUAL_NODE_PORT: '4499' });
    expect(r).toEqual({ enabled: true, enabledProvided: true, port: 4499, portProvided: true });
  });

  it.each(['0', '65536', '70000', '-1', 'abc', '44.5', '4404x'])(
    'warns and ignores both vars for VIRTUAL_NODE_PORT=%s',
    (v) => {
      const warn = vi.fn();
      const r = parseVirtualNodeEnv({ ENABLE_VIRTUAL_NODE: 'true', VIRTUAL_NODE_PORT: v }, warn);
      expect(r.enabled).toBe(false);
      expect(r.port).toBe(4404);
      expect(warn).toHaveBeenCalledOnce();
    },
  );

  it('accepts the range edges 1 and 65535', () => {
    expect(parseVirtualNodeEnv({ ENABLE_VIRTUAL_NODE: 'true', VIRTUAL_NODE_PORT: '1' }).port).toBe(1);
    expect(parseVirtualNodeEnv({ ENABLE_VIRTUAL_NODE: 'true', VIRTUAL_NODE_PORT: '65535' }).port).toBe(65535);
  });

  it('does not enable from VIRTUAL_NODE_PORT alone, and warns', () => {
    const warn = vi.fn();
    const r = parseVirtualNodeEnv({ VIRTUAL_NODE_PORT: '4499' }, warn);
    expect(r.enabled).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('ENABLE_VIRTUAL_NODE');
  });

  it('does not warn about the port when ENABLE_VIRTUAL_NODE=false is explicit', () => {
    const warn = vi.fn();
    parseVirtualNodeEnv({ ENABLE_VIRTUAL_NODE: 'false', VIRTUAL_NODE_PORT: '4499' }, warn);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('parseAdminPassword', () => {
  it('is not provided when unset', () => {
    expect(parseAdminPassword(undefined)).toEqual({ value: undefined, wasProvided: false });
  });

  it('returns the value when it is long enough', () => {
    expect(parseAdminPassword('s3cret-pass')).toEqual({ value: 's3cret-pass', wasProvided: true });
  });

  it.each(['', '   '])('warns and falls back for an empty value (%j)', (v) => {
    const warn = vi.fn();
    expect(parseAdminPassword(v, warn)).toEqual({ value: undefined, wasProvided: false });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('warns and falls back for a value under 8 characters, without logging it', () => {
    const warn = vi.fn();
    expect(parseAdminPassword('short7!', warn)).toEqual({ value: undefined, wasProvided: false });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).not.toContain('short7!');
  });

  it('accepts exactly 8 characters', () => {
    expect(parseAdminPassword('12345678').wasProvided).toBe(true);
  });
});

describe('getEnvironmentConfig first-boot fields', () => {
  const KEYS = ['ENABLE_VIRTUAL_NODE', 'VIRTUAL_NODE_PORT', 'ADMIN_PASSWORD'] as const;
  const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

  afterEach(() => {
    for (const k of KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
    resetEnvironmentConfig();
  });

  it('exposes the parsed values', () => {
    process.env.ENABLE_VIRTUAL_NODE = 'true';
    process.env.VIRTUAL_NODE_PORT = '4499';
    process.env.ADMIN_PASSWORD = 'headless-pass';
    resetEnvironmentConfig();
    const env = getEnvironmentConfig();
    expect(env.virtualNodeEnabled).toBe(true);
    expect(env.virtualNodePort).toBe(4499);
    expect(env.virtualNodePortProvided).toBe(true);
    expect(env.adminPassword).toBe('headless-pass');
    expect(env.adminPasswordProvided).toBe(true);
  });

  it('defaults when unset', () => {
    for (const k of KEYS) delete process.env[k];
    resetEnvironmentConfig();
    const env = getEnvironmentConfig();
    expect(env.virtualNodeEnabled).toBe(false);
    expect(env.virtualNodePort).toBe(4404);
    expect(env.adminPassword).toBeUndefined();
    expect(env.adminPasswordProvided).toBe(false);
  });
});
