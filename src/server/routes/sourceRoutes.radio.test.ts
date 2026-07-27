/**
 * Source Routes — public `radio` summary on GET /api/sources
 * (Terrain Link Profile epic #4111, Phase 3 WP-1).
 *
 * `radio` is an additive, non-secret field derived per-source from the live
 * manager (Meshtastic LoRa config / MeshCore local node radio freq). It must
 * be visible to anonymous callers (no permission gate — same posture as the
 * rest of the GET /api/sources list) and must never turn a healthy sources
 * list into a 500 when a manager throws.
 *
 * Uses createRouteTestApp() per CLAUDE.md: real DB-backed sources (seeded by
 * the harness as sourceA/sourceB, both meshtastic_tcp), real optionalAuth.
 * Only sourceManagerRegistry is mocked — its manager lookups are pure
 * in-memory objects the router calls at request time, not DB state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
  },
}));

const mockGetManager = sourceManagerRegistry.getManager as unknown as ReturnType<typeof vi.fn>;

describe('GET /api/sources — radio summary (#4111 P3 WP-1)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', sourceRoutes),
    });
    mockGetManager.mockReset();
    mockGetManager.mockReturnValue(null);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('includes a meshtastic radio summary (frequencyMhz/regionName/modemPreset/txEnabled) — visible anonymously', async () => {
    mockGetManager.mockImplementation((sourceId: string) => {
      if (sourceId !== harness.sourceA) return null;
      return {
        sourceType: 'meshtastic_tcp',
        getCurrentConfig: () => ({
          deviceConfig: {
            lora: {
              region: 1, // US
              channelNum: 21,
              overrideFrequency: 0,
              frequencyOffset: 0,
              bandwidth: 250,
              modemPreset: 0, // LONG_FAST
            },
          },
        }),
      };
    });

    const agent = await harness.loginAs(null); // anonymous
    const res = await agent.get('/');

    expect(res.status).toBe(200);
    const a = res.body.find((s: { id: string }) => s.id === harness.sourceA);
    expect(a).toBeDefined();
    expect(a.radio).toEqual({
      frequencyMhz: expect.closeTo(907.125, 2),
      regionName: 'US',
      modemPreset: 0,
      txEnabled: true,
    });
  });

  it('reflects txEnabled: false on the meshtastic summary when the source is receive-only (#4294 P3)', async () => {
    mockGetManager.mockImplementation((sourceId: string) => {
      if (sourceId !== harness.sourceA) return null;
      return {
        sourceType: 'meshtastic_tcp',
        getCurrentConfig: () => ({
          deviceConfig: {
            lora: {
              region: 1,
              channelNum: 21,
              overrideFrequency: 0,
              frequencyOffset: 0,
              bandwidth: 250,
              modemPreset: 0,
              txEnabled: false,
            },
          },
        }),
      };
    });

    const agent = await harness.loginAs(null);
    const res = await agent.get('/');

    const a = res.body.find((s: { id: string }) => s.id === harness.sourceA);
    expect(a.radio.txEnabled).toBe(false);
  });

  it('fails open to txEnabled: true when the field is absent from lora config (#4294 P3)', async () => {
    mockGetManager.mockImplementation((sourceId: string) => {
      if (sourceId !== harness.sourceA) return null;
      return {
        sourceType: 'meshtastic_tcp',
        getCurrentConfig: () => ({
          deviceConfig: {
            lora: {
              region: 1,
              channelNum: 21,
              overrideFrequency: 0,
              frequencyOffset: 0,
              bandwidth: 250,
              modemPreset: 0,
              // txEnabled intentionally omitted
            },
          },
        }),
      };
    });

    const agent = await harness.loginAs(null);
    const res = await agent.get('/');

    const a = res.body.find((s: { id: string }) => s.id === harness.sourceA);
    expect(a.radio.txEnabled).toBe(true);
  });

  it('honors overrideFrequency on the meshtastic summary', async () => {
    mockGetManager.mockImplementation((sourceId: string) => {
      if (sourceId !== harness.sourceA) return null;
      return {
        sourceType: 'meshtastic_tcp',
        getCurrentConfig: () => ({
          deviceConfig: {
            lora: {
              region: 1,
              channelNum: 21,
              overrideFrequency: 915.5,
              frequencyOffset: 0,
              bandwidth: 250,
              modemPreset: 0,
            },
          },
        }),
      };
    });

    const agent = await harness.loginAs(null);
    const res = await agent.get('/');

    const a = res.body.find((s: { id: string }) => s.id === harness.sourceA);
    expect(a.radio.frequencyMhz).toBeCloseTo(915.5, 3);
  });

  it('includes a meshcore radio summary ({ frequencyMhz }) derived from getLocalNode().radioFreq', async () => {
    mockGetManager.mockImplementation((sourceId: string) => {
      if (sourceId !== harness.sourceB) return null;
      return {
        sourceType: 'meshcore',
        getLocalNode: () => ({ publicKey: 'abc', name: 'MC', advType: 1, radioFreq: 869.525 }),
      };
    });

    const agent = await harness.loginAs(null);
    const res = await agent.get('/');

    const b = res.body.find((s: { id: string }) => s.id === harness.sourceB);
    expect(b.radio).toEqual({ frequencyMhz: 869.525 });
  });

  it('returns radio: null when no manager is registered for the source', async () => {
    mockGetManager.mockReturnValue(null);

    const agent = await harness.loginAs(null);
    const res = await agent.get('/');

    const a = res.body.find((s: { id: string }) => s.id === harness.sourceA);
    expect(a.radio).toBeNull();
  });

  it('returns radio: null (not a 500) for an MQTT-type manager with no local radio', async () => {
    mockGetManager.mockImplementation((sourceId: string) => {
      if (sourceId !== harness.sourceA) return null;
      return { sourceType: 'mqtt_broker' };
    });

    const agent = await harness.loginAs(null);
    const res = await agent.get('/');

    const a = res.body.find((s: { id: string }) => s.id === harness.sourceA);
    expect(res.status).toBe(200);
    expect(a.radio).toBeNull();
  });

  it('never 500s when a manager throws from getCurrentConfig() — the whole list still returns 200', async () => {
    mockGetManager.mockImplementation((sourceId: string) => {
      if (sourceId !== harness.sourceA) return null;
      return {
        sourceType: 'meshtastic_tcp',
        getCurrentConfig: () => {
          throw new Error('boom');
        },
      };
    });

    const agent = await harness.loginAs(null);
    const res = await agent.get('/');

    expect(res.status).toBe(200);
    const a = res.body.find((s: { id: string }) => s.id === harness.sourceA);
    expect(a.radio).toBeNull();
    // sourceB (no manager throw) still resolves normally alongside it.
    const b = res.body.find((s: { id: string }) => s.id === harness.sourceB);
    expect(b).toBeDefined();
  });

  it('admin sees the same radio summary as anonymous (additive, not permission-gated)', async () => {
    mockGetManager.mockImplementation((sourceId: string) => {
      if (sourceId !== harness.sourceA) return null;
      return {
        sourceType: 'meshtastic_tcp',
        getCurrentConfig: () => ({
          deviceConfig: {
            lora: { region: 3, channelNum: 1, overrideFrequency: 0, frequencyOffset: 0, bandwidth: 250, modemPreset: 0 },
          },
        }),
      };
    });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/');

    const a = res.body.find((s: { id: string }) => s.id === harness.sourceA);
    expect(a.radio.regionName).toBe('EU_868');
  });
});
