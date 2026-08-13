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

function fakeSource(config: ReticulumSourceConfig, overrides: Partial<Source> = {}): Source {
  return {
    id: 'src-a',
    name: 'A',
    type: 'meshcore',
    config,
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

    it('honors an explicit bridgeUrl override', () => {
      const cfg = reticulumConfigFromSource(
        fakeSource({ mode: 'attach', configDir: '/rns', token: 'secret', bridgeUrl: 'ws://bridge.internal:9000' }),
      );
      expect(cfg?.bridgeUrl).toBe('ws://bridge.internal:9000');
    });

    it('does not require a token — an absent token yields empty string, not null', () => {
      const cfg = reticulumConfigFromSource(fakeSource({ mode: 'attach', configDir: '/rns' }));
      expect(cfg).not.toBeNull();
      expect(cfg?.token).toBe('');
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

  it('defaults to attach mode when mode is missing/invalid', () => {
    const cfg = reticulumConfigFromSource(
      fakeSource({ mode: undefined as unknown as 'attach', configDir: '/rns', token: 'secret' }),
    );
    expect(cfg?.mode).toBe('attach');
  });

  it('returns null for an empty config object regardless of mode default (attach needs configDir)', () => {
    const cfg = reticulumConfigFromSource(fakeSource({} as ReticulumSourceConfig));
    expect(cfg).toBeNull();
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
