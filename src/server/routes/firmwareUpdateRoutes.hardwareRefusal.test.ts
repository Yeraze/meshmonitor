/**
 * firmwareUpdateRoutes — hardware that cannot be updated (#5677).
 *
 * POST /api/firmware/update used to answer a meshtasticd node with a bare
 * 500 "Unknown hardware model 37: cannot determine board name". It now
 * answers 400 with a machine code per reason, and the update never starts.
 *
 * Real `createRouteTestApp` harness and the REAL firmware service and hardware
 * map, so the route, preflight and the shared list are tested as one. Only the
 * source registry is faked: no radio is connected in tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { registry } = vi.hoisted(() => {
  // A plain, non-bridged Meshtastic TCP node: a bridged one is refused earlier.
  const manager = { sourceType: 'meshtastic_tcp', isLocalNodeBridged: () => false };
  const registry = {
    getManager: () => manager,
    getAllManagers: () => [manager],
    getPrimaryMeshtasticSourceId: () => 'rt-source-a',
  };
  return { registry };
});

vi.mock('../sourceManagerRegistry.js', () => ({ sourceManagerRegistry: registry }));

import firmwareUpdateRoutes from './firmwareUpdateRoutes.js';
import { firmwareUpdateService } from '../services/firmwareUpdateService.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const CUSTOM_URL = 'https://builds.example.com/firmware.bin';

function body(hwModel: number) {
  // A custom URL is the most permissive path: no release lookup, and the
  // ambiguous-board refusal (#5423) does not apply. Only the hardware decides.
  return { useCustomUrl: true, gatewayIp: '10.9.8.7', hwModel, currentVersion: '2.7.26.abcdef0' };
}

describe('POST /api/firmware/update — unsupported hardware (#5677)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/api/firmware', firmwareUpdateRoutes) });
    await firmwareUpdateService.setCustomUrl(CUSTOM_URL);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it.each([
    ['PORTDUINO (meshtasticd)', 37, 'OTA_HARDWARE_LINUX_NATIVE', /meshtasticd/],
    ['UNSET', 0, 'OTA_HARDWARE_UNSET', /has not reported its hardware model/],
    ['ANDROID_SIM', 38, 'OTA_HARDWARE_SIMULATOR', /simulator/],
    ['a model number with no name', 200, 'OTA_UNKNOWN_HARDWARE', /Unknown hardware model 200/],
    ['PRIVATE_HW (no build mapped)', 255, 'OTA_BOARD_UNMAPPED', /not OTA capable/],
    ['RAK4631 (nRF52840)', 9, 'OTA_PLATFORM_UNSUPPORTED', /not OTA capable/],
  ])('refuses %s with 400 and its code, and starts nothing', async (_label, hwModel, code, message) => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/api/firmware/update').send(body(hwModel));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code });
    expect(res.body.error).toMatch(message);
    expect(firmwareUpdateService.getStatus()).toMatchObject({ state: 'idle', step: null });
  });

  it('refuses a non-admin before looking at the hardware', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/api/firmware/update').send(body(37));
    expect(res.status).toBe(403);
    expect(res.body.code).not.toBe('OTA_HARDWARE_LINUX_NATIVE');
  });
});
