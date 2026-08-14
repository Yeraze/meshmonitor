/**
 * Tests for reticulumConfig.ts (#3960 Phase 1a WP3).
 *
 * `Source['type']` does not include `'reticulum'` yet (that union widening is
 * WP5's job, src/db/repositories/sources.ts — out of scope and off-limits for
 * this WP). `reticulumConfigFromSource` only reads `source.config`, so the
 * fake source below uses the existing `'meshcore'` literal as a stand-in type
 * value; it has no bearing on the logic under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reticulumConfigFromSource, ensureReticulumManagerStarted, type ReticulumSourceConfig } from './reticulumConfig.js';
import { PROTOCOL_VERSION } from './reticulumProtocol.js';
import type { Source } from '../db/repositories/sources.js';
import { logger } from '../utils/logger.js';

function fakeSource(config: ReticulumSourceConfig, overrides: Partial<Source> = {}): Source {
  return {
    id: 'src-a',
    name: 'A',
    type: 'meshcore',
    // ReticulumSourceConfig has no index signature, so it isn't directly
    // assignable to Source['config'] (Record<string, unknown>) once this
    // return type is unioned with Partial<Source>'s optional `config` via the
    // `...overrides` spread below. Spreading into a fresh object literal
    // erases the named-interface shape TS otherwise insists on preserving.
    config: { ...config },
    enabled: true,
    displayOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    createdBy: null,
    ...overrides,
  };
}

describe('reticulumConfigFromSource', () => {
  describe('attach mode', () => {
    it('maps a valid attach config', () => {
      const cfg = reticulumConfigFromSource(fakeSource({ mode: 'attach', configDir: '/rns', token: 'secret' }));
      expect(cfg).toEqual({
        mode: 'attach',
        bridgeUrl: 'ws://127.0.0.1:8765',
        token: 'secret',
        protocolVersion: PROTOCOL_VERSION,
        configDir: '/rns',
      });
    });

    it('returns null when configDir is missing', () => {
      const cfg = reticulumConfigFromSource(fakeSource({ mode: 'attach', token: 'secret' }));
      expect(cfg).toBeNull();
    });

    it('returns null when configDir is blank', () => {
      const cfg = reticulumConfigFromSource(fakeSource({ mode: 'attach', configDir: '   ', token: 'secret' }));
      expect(cfg).toBeNull();
    });

    it('trims configDir', () => {
      const cfg = reticulumConfigFromSource(fakeSource({ mode: 'attach', configDir: '  /rns  ', token: 'secret' }));
      expect(cfg?.configDir).toBe('/rns');
    });

    it('honors an explicit bridgeUrl override (loopback, non-default port)', () => {
      const cfg = reticulumConfigFromSource(
        fakeSource({ mode: 'attach', configDir: '/rns', token: 'secret', bridgeUrl: 'ws://127.0.0.1:9000' }),
      );
      expect(cfg?.bridgeUrl).toBe('ws://127.0.0.1:9000');
    });

    it('does not require a token — an absent token yields empty string, not null', () => {
      const cfg = reticulumConfigFromSource(fakeSource({ mode: 'attach', configDir: '/rns' }));
      expect(cfg).not.toBeNull();
      expect(cfg?.token).toBe('');
    });

    it('returns null (fail-fast) when bridgeUrl is a non-loopback host not on the allowlist', () => {
      const cfg = reticulumConfigFromSource(
        fakeSource({ mode: 'attach', configDir: '/rns', token: 'secret', bridgeUrl: 'ws://evil.example.com:1/' }),
      );
      expect(cfg).toBeNull();
    });

    it('returns null (fail-fast) when bridgeUrl uses a non-ws scheme', () => {
      const cfg = reticulumConfigFromSource(
        fakeSource({ mode: 'attach', configDir: '/rns', token: 'secret', bridgeUrl: 'http://127.0.0.1:8765' }),
      );
      expect(cfg).toBeNull();
    });
  });

  describe('remoteAllowed (#3960 Phase 4 WP3, build spec §0 R5)', () => {
    it('omits remoteAllowed entirely when not configured', () => {
      const cfg = reticulumConfigFromSource(fakeSource({ mode: 'attach', configDir: '/rns', token: 'secret' }));
      expect(cfg?.remoteAllowed).toBeUndefined();
    });

    it('lowercases, trims, and deduplicates remoteAllowed hashes', () => {
      const cfg = reticulumConfigFromSource(
        fakeSource({
          mode: 'attach',
          configDir: '/rns',
          token: 'secret',
          remoteAllowed: ['  AABB1122  ', 'ccdd3344', 'aabb1122'],
        }),
      );
      expect(cfg?.remoteAllowed).toEqual(['aabb1122', 'ccdd3344']);
    });

    it('ignores non-array/non-string entries', () => {
      const cfg = reticulumConfigFromSource(
        fakeSource({
          mode: 'attach',
          configDir: '/rns',
          token: 'secret',
          remoteAllowed: ['aabb1122', 123 as unknown as string, '', '   '],
        }),
      );
      expect(cfg?.remoteAllowed).toEqual(['aabb1122']);
    });

    it('is NOT mode-specific — own mode also carries it through', () => {
      const cfg = reticulumConfigFromSource(
        fakeSource({ mode: 'own', device: '/dev/ttyUSB0', token: 'secret', remoteAllowed: ['aabb1122'] }),
      );
      expect(cfg?.remoteAllowed).toEqual(['aabb1122']);
    });

    it('is NOT mode-specific — tcp_peer mode also carries it through', () => {
      const cfg = reticulumConfigFromSource(
        fakeSource({
          mode: 'tcp_peer',
          token: 'secret',
          peers: [{ host: '10.0.0.5', port: 4242 }],
          remoteAllowed: ['aabb1122'],
        }),
      );
      expect(cfg?.remoteAllowed).toEqual(['aabb1122']);
    });
  });

  describe('tcp_peer mode', () => {
    it('maps a valid tcp_peer config with one peer', () => {
      const cfg = reticulumConfigFromSource(
        fakeSource({ mode: 'tcp_peer', token: 'secret', peers: [{ host: '10.0.0.5', port: 4242 }] }),
      );
      expect(cfg).toEqual({
        mode: 'tcp_peer',
        bridgeUrl: 'ws://127.0.0.1:8765',
        token: 'secret',
        protocolVersion: PROTOCOL_VERSION,
        peers: [{ host: '10.0.0.5', port: 4242 }],
      });
    });

    it('maps multiple peers and drops malformed entries', () => {
      const cfg = reticulumConfigFromSource(
        fakeSource({
          mode: 'tcp_peer',
          token: 'secret',
          peers: [
            { host: '10.0.0.5', port: 4242 },
            { host: '', port: 4243 },
            { host: '10.0.0.6', port: 0 },
            { host: '10.0.0.7', port: 4244 },
          ],
        }),
      );
      expect(cfg?.peers).toEqual([
        { host: '10.0.0.5', port: 4242 },
        { host: '10.0.0.7', port: 4244 },
      ]);
    });

    it('returns null when peers is missing', () => {
      const cfg = reticulumConfigFromSource(fakeSource({ mode: 'tcp_peer', token: 'secret' }));
      expect(cfg).toBeNull();
    });

    it('returns null when peers is an empty array', () => {
      const cfg = reticulumConfigFromSource(fakeSource({ mode: 'tcp_peer', token: 'secret', peers: [] }));
      expect(cfg).toBeNull();
    });

    it('returns null when every peer entry is malformed', () => {
      const cfg = reticulumConfigFromSource(
        fakeSource({ mode: 'tcp_peer', token: 'secret', peers: [{ host: '', port: 4242 }] }),
      );
      expect(cfg).toBeNull();
    });
  });

  describe('own mode (#3960 Phase 3 WP1/WP4)', () => {
    it('maps a valid own config (device only, no radio params)', () => {
      const cfg = reticulumConfigFromSource(fakeSource({ mode: 'own', device: '/dev/ttyUSB0', token: 'secret' }));
      expect(cfg).toEqual({
        mode: 'own',
        bridgeUrl: 'ws://127.0.0.1:8765',
        token: 'secret',
        protocolVersion: PROTOCOL_VERSION,
        device: '/dev/ttyUSB0',
        frequency: undefined,
        bandwidth: undefined,
        spreadingFactor: undefined,
        codingRate: undefined,
        txPower: undefined,
        stAlock: undefined,
        ltAlock: undefined,
      });
    });

    it('maps a valid own config with initial radio params', () => {
      const cfg = reticulumConfigFromSource(
        fakeSource({
          mode: 'own',
          device: '/dev/ttyUSB0',
          token: 'secret',
          frequency: 914_875_000,
          bandwidth: 125_000,
          spreadingFactor: 8,
          codingRate: 5,
          txPower: 17,
          stAlock: 33.3,
          ltAlock: 66.6,
        }),
      );
      expect(cfg).toMatchObject({
        mode: 'own',
        device: '/dev/ttyUSB0',
        frequency: 914_875_000,
        bandwidth: 125_000,
        spreadingFactor: 8,
        codingRate: 5,
        txPower: 17,
        stAlock: 33.3,
        ltAlock: 66.6,
      });
    });

    it('trims device', () => {
      const cfg = reticulumConfigFromSource(fakeSource({ mode: 'own', device: '  /dev/ttyUSB0  ', token: 'secret' }));
      expect((cfg as { device?: string })?.device).toBe('/dev/ttyUSB0');
    });

    it('returns null when device is missing', () => {
      const cfg = reticulumConfigFromSource(fakeSource({ mode: 'own', token: 'secret' }));
      expect(cfg).toBeNull();
    });

    it('returns null when device is blank', () => {
      const cfg = reticulumConfigFromSource(fakeSource({ mode: 'own', device: '   ', token: 'secret' }));
      expect(cfg).toBeNull();
    });

    it('drops a non-numeric/non-finite radio param rather than passing it through (defensive parse of the stored config JSON)', () => {
      const cfg = reticulumConfigFromSource(
        fakeSource({
          mode: 'own',
          device: '/dev/ttyUSB0',
          token: 'secret',
          frequency: 'not-a-number' as unknown as number,
          txPower: Infinity,
        }),
      );
      expect((cfg as { frequency?: number })?.frequency).toBeUndefined();
      expect((cfg as { txPower?: number })?.txPower).toBeUndefined();
    });

    it('honors an explicit bridgeUrl override, same as attach/tcp_peer', () => {
      const cfg = reticulumConfigFromSource(
        fakeSource({ mode: 'own', device: '/dev/ttyUSB0', token: 'secret', bridgeUrl: 'ws://127.0.0.1:9000' }),
      );
      expect(cfg?.bridgeUrl).toBe('ws://127.0.0.1:9000');
    });

    it('returns null (fail-fast) when bridgeUrl is a non-loopback host not on the allowlist, same as attach/tcp_peer', () => {
      const cfg = reticulumConfigFromSource(
        fakeSource({ mode: 'own', device: '/dev/ttyUSB0', token: 'secret', bridgeUrl: 'ws://evil.example.com:1/' }),
      );
      expect(cfg).toBeNull();
    });
  });

  it('defaults to attach mode when mode is missing', () => {
    const cfg = reticulumConfigFromSource(
      fakeSource({ mode: undefined as unknown as 'attach', configDir: '/rns', token: 'secret' }),
    );
    expect(cfg?.mode).toBe('attach');
  });

  it('returns null for an empty config object regardless of mode default (attach needs configDir)', () => {
    const cfg = reticulumConfigFromSource(fakeSource({} as ReticulumSourceConfig));
    expect(cfg).toBeNull();
  });

  // PR review finding 7: an unrecognized stored `mode` was silently coerced
  // to 'attach' with no diagnostic — a bad DB/API value was invisible.
  describe('unrecognized mode diagnostic', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('logs a warning and still defaults to attach when mode is an unrecognized string', () => {
      const cfg = reticulumConfigFromSource(
        fakeSource({ mode: 'bogus' as unknown as 'attach', configDir: '/rns', token: 'secret' }),
      );
      expect(cfg?.mode).toBe('attach');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('bogus');
    });

    it('does NOT warn when mode is genuinely missing (undefined is a legitimate default, not a bad value)', () => {
      const cfg = reticulumConfigFromSource(
        fakeSource({ mode: undefined as unknown as 'attach', configDir: '/rns', token: 'secret' }),
      );
      expect(cfg?.mode).toBe('attach');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does NOT warn for a recognized mode (attach)', () => {
      reticulumConfigFromSource(fakeSource({ mode: 'attach', configDir: '/rns', token: 'secret' }));
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does NOT warn for a recognized mode (tcp_peer)', () => {
      reticulumConfigFromSource(
        fakeSource({ mode: 'tcp_peer', token: 'secret', peers: [{ host: '10.0.0.5', port: 4242 }] }),
      );
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does NOT warn for a recognized mode (own)', () => {
      reticulumConfigFromSource(fakeSource({ mode: 'own', device: '/dev/ttyUSB0', token: 'secret' }));
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});

describe('ensureReticulumManagerStarted', () => {
  // WP4 stub — this only asserts the seam is callable and doesn't throw.
  // WP4 replaces the implementation with the real create-or-reconnect
  // recipe and should replace this test with manager-registry assertions.
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves without throwing (stub pending WP4 ReticulumManager wiring)', async () => {
    const source = fakeSource({ mode: 'attach', configDir: '/rns', token: 'secret' });
    const cfg = reticulumConfigFromSource(source);
    expect(cfg).not.toBeNull();
    await expect(ensureReticulumManagerStarted(source, cfg!)).resolves.toBeUndefined();
  });
});
