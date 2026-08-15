/**
 * RF coverage route (#4727).
 *
 * Uses the real harness (real express-session, real auth middleware, real SQL)
 * so the permission assertion exercises the actual gate. `computeCoverage` is
 * mocked — the sweep's own behaviour is covered in `coverageSweep.test.ts`, and
 * what needs checking here is validation, gating, and that the model's caveats
 * are not lost between the service and the wire.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const computeCoverage = vi.fn();

// Only `computeCoverage` is stubbed; `clampCoverageParams` stays REAL via
// importActual. The route now sanitizes request values itself, so mocking the
// clamp would hide exactly the behaviour these tests need to cover.
vi.mock('../services/rf/coverageSweep.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/rf/coverageSweep.js')>()),
  computeCoverage: (...a: unknown[]) => computeCoverage(...a),
}));

import rfCoverageRoutes from './rfCoverageRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';

let harness: RouteTestHarness;

const RESULT = {
  origin: { lat: 30, lng: -97 },
  radiusKm: 15,
  generatedAt: 1,
  model: 'fresnel-path-loss',
  radials: [{ bearingDeg: 0, reachKm: 5, limitedByRadius: false, reachablePocketsBeyond: false, hasDataGaps: false }],
  assumptions: ['Predicted from terrain elevation only — this is a model, not measured coverage.'],
};

const body = (o: Record<string, unknown> = {}) => ({ origin: { lat: 30, lng: -97 }, ...o });

beforeEach(async () => {
  computeCoverage.mockReset().mockResolvedValue(RESULT);
  await databaseService.settings.setSetting('elevationEnabled', 'true');
  harness = await createRouteTestApp({ mount: (app) => app.use('/api/rf', rfCoverageRoutes) });
});

afterEach(async () => {
  await databaseService.settings.setSetting('elevationEnabled', 'true');
  await harness.cleanup();
});

const post = async (b: unknown, user?: 'admin' | 'limited') => {
  const agent = await harness.loginAs(user === 'limited' ? harness.limited : harness.admin);
  return agent.post('/api/rf/coverage').send(b as object);
};

describe('POST /api/rf/coverage', () => {
  it('returns the sweep, assumptions included', async () => {
    const res = await post(body());

    expect(res.status).toBe(200);
    expect(res.body.data.model).toBe('fresnel-path-loss');
    // The caveats must survive the trip to the client — they are the feature's
    // honesty, not decoration.
    expect(res.body.data.assumptions.join(' ')).toMatch(/not measured/i);
  });

  it('refuses when elevation lookups are disabled', async () => {
    // Without terrain this degrades to a free-space circle that looks like a
    // prediction while modelling nothing.
    await databaseService.settings.setSetting('elevationEnabled', 'false');
    const res = await post(body());

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ELEVATION_DISABLED');
    expect(computeCoverage).not.toHaveBeenCalled();
  });

  it('rejects a malformed origin', async () => {
    for (const bad of [undefined, {}, { lat: 91, lng: 0 }, { lat: 0, lng: 181 }, { lat: 'x', lng: 0 }]) {
      const res = await post({ origin: bad });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_ORIGIN');
    }
    expect(computeCoverage).not.toHaveBeenCalled();
  });

  it('rejects an out-of-band frequency', async () => {
    const res = await post(body({ frequencyHz: 1 }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FREQUENCY');
  });

  it('clamps slider-shaped inputs rather than rejecting them', async () => {
    await post(body({ txHeightM: 99999, rxHeightM: -5, txPowerDbm: 999, sensitivityDbm: 50 }));

    const params = computeCoverage.mock.calls[0][0];
    expect(params.txHeightM).toBe(1000);
    expect(params.rxHeightM).toBe(0);
    expect(params.budget.txPowerDbm).toBe(60);
    expect(params.budget.sensitivityDbm).toBe(0);
  });

  it('sanitizes sweep bounds at the route, not only downstream', async () => {
    // CodeQL flagged the raw-values-across-a-boundary shape as loop-bound
    // injection. The values reaching computeCoverage must already be bounded.
    await post(body({ azimuthCount: 100000, samplesPerRadial: 99999 }));

    const params = computeCoverage.mock.calls[0][0];
    expect(params.azimuthCount).toBeLessThanOrEqual(180);
    expect(params.azimuthCount * params.samplesPerRadial).toBeLessThanOrEqual(24_000);
  });

  it('applies defaults for omitted radio parameters', async () => {
    await post(body());

    const params = computeCoverage.mock.calls[0][0];
    expect(params.frequencyHz).toBe(915e6);
    expect(params.txHeightM).toBe(10);
    expect(params.rxHeightM).toBe(2);
    expect(params.budget.sensitivityDbm).toBe(-130);
    expect(params.radiusKm).toBe(15);
  });

  it('passes the configured elevation source through', async () => {
    await databaseService.settings.setSetting('elevationSourceUrl', 'https://dem.example/{z}/{x}/{y}.png');
    await post(body());
    expect(computeCoverage.mock.calls[0][1]).toBe('https://dem.example/{z}/{x}/{y}.png');
  });

  it('requires nodes:read', async () => {
    const res = await post(body(), 'limited');
    expect(res.status).toBe(403);
    expect(computeCoverage).not.toHaveBeenCalled();
  });

  it('allows a user holding nodes:read on any source', async () => {
    // Deliberately a PER-SOURCE grant. `nodes` is a sourcey resource, so
    // `checkPermissionAsync` with no scope matches only per-source rows — a
    // global nodes grant never satisfies this gate, by design.
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    const res = await post(body(), 'limited');
    expect(res.status).toBe(200);
  });

  it('is not satisfied by a global nodes grant', async () => {
    // Pins the semantic above so it cannot be "fixed" into something laxer
    // without the change being visible.
    await harness.grant(harness.limited.id, 'nodes', 'read');
    const res = await post(body(), 'limited');
    expect(res.status).toBe(403);
  });
});
