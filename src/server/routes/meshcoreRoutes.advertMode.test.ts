/**
 * Route tests — MeshCore advert reach (zero-hop / flood).
 *
 * - POST /advert takes `{ mode }`: missing → zero_hop, invalid → 400, and the
 *   old-repeater-firmware error maps to 409 ZERO_HOP_ADVERT_UNSUPPORTED.
 * - POST /automation/announce validates and persists `advertMode`; GET reports
 *   flood for an enabled burst saved before the field existed.
 * - POST /automation/timers rejects an invalid per-trigger `advertMode`.
 * - Saving auto-announce settings leaves the automated flood floor
 *   (`meshcoreLastFloodAdvertAt`) untouched.
 *
 * Real-middleware harness (createRouteTestApp) per CLAUDE.md; only the
 * source-manager registry is mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { MeshCoreZeroHopAdvertUnsupportedError } from '../utils/meshcoreAdvert.js';

const { sendAdvertMock } = vi.hoisted(() => ({ sendAdvertMock: vi.fn() }));

vi.mock('../sourceManagerRegistry.js', () => {
  const stubFor = (sourceId: string) => ({
    sourceId,
    sourceType: 'meshcore' as const,
    sendAdvert: sendAdvertMock,
    startAutoAnnounce: async () => {},
    startTimerTriggers: async () => {},
    isReceiveOnly: () => false,
    canTransmit: () => true,
  });
  const managers = new Map([
    ['rt-source-a', stubFor('rt-source-a')],
    ['rt-source-b', stubFor('rt-source-b')],
  ]);
  return {
    sourceManagerRegistry: {
      getManager: (sourceId: string) => managers.get(sourceId),
      getAllManagers: () => Array.from(managers.values()),
    },
  };
});

describe('meshcoreRoutes — advert mode', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    sendAdvertMock.mockReset();
    sendAdvertMock.mockResolvedValue(true);
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const base = (sourceId: string) => `/sources/${sourceId}/meshcore`;

  describe('POST /advert', () => {
    async function writer() {
      await harness.grant(harness.limited.id, 'connection', 'write', harness.sourceA);
      return harness.loginAs(harness.limited);
    }

    it('returns 403 without connection:write', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post(`${base(harness.sourceA)}/advert`).send({ mode: 'flood' });
      expect(res.status).toBe(403);
      expect(sendAdvertMock).not.toHaveBeenCalled();
    });

    it('defaults a missing mode to zero_hop', async () => {
      const agent = await writer();
      const res = await agent.post(`${base(harness.sourceA)}/advert`).send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { mode: 'zero_hop' } });
      expect(sendAdvertMock).toHaveBeenCalledWith('zero_hop');
    });

    it('defaults a bodyless request to zero_hop', async () => {
      const agent = await writer();
      const res = await agent.post(`${base(harness.sourceA)}/advert`);
      expect(res.status).toBe(200);
      expect(sendAdvertMock).toHaveBeenCalledWith('zero_hop');
    });

    it('passes an explicit flood through', async () => {
      const agent = await writer();
      const res = await agent.post(`${base(harness.sourceA)}/advert`).send({ mode: 'flood' });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ mode: 'flood' });
      expect(sendAdvertMock).toHaveBeenCalledWith('flood');
    });

    it('rejects an unknown mode with 400 INVALID_ADVERT_MODE and sends nothing', async () => {
      const agent = await writer();
      const res = await agent.post(`${base(harness.sourceA)}/advert`).send({ mode: 'everywhere' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'INVALID_ADVERT_MODE' });
      expect(sendAdvertMock).not.toHaveBeenCalled();
    });

    it('maps a device failure to 400 ADVERT_FAILED', async () => {
      sendAdvertMock.mockResolvedValue(false);
      const agent = await writer();
      const res = await agent.post(`${base(harness.sourceA)}/advert`).send({ mode: 'zero_hop' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'ADVERT_FAILED', error: 'Failed to send advert' });
    });

    it('maps old repeater firmware to 409 ZERO_HOP_ADVERT_UNSUPPORTED', async () => {
      sendAdvertMock.mockRejectedValue(new MeshCoreZeroHopAdvertUnsupportedError(true));
      const agent = await writer();
      const res = await agent.post(`${base(harness.sourceA)}/advert`).send({ mode: 'zero_hop' });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ success: false, code: 'ZERO_HOP_ADVERT_UNSUPPORTED', floodSent: true });
      expect(res.body.error).toMatch(/FLOOD advert instead/);
    });
  });

  describe('auto-announce advertMode', () => {
    // GET needs automation:read and POST automation:write; the harness stores
    // one action per permission row, so use the admin for these round trips.
    const automationWriter = () => harness.loginAs(harness.admin);
    const url = () => `${base(harness.sourceA)}/automation/announce`;

    it('GET reports zero_hop for a new (never enabled) config', async () => {
      const agent = await automationWriter();
      await harness.db.settings.setSourceSetting(harness.sourceA, 'meshcoreAutoAnnounceAdvertEnabled', 'false');
      const res = await agent.get(url());
      expect(res.body.data.advertMode).toBe('zero_hop');
    });

    it('GET reports flood for an enabled burst saved before the mode existed', async () => {
      const agent = await automationWriter();
      await harness.db.settings.setSourceSetting(harness.sourceA, 'meshcoreAutoAnnounceAdvertEnabled', 'true');
      const res = await agent.get(url());
      expect(res.body.data.advertMode).toBe('flood');
    });

    it('POST persists a valid advertMode', async () => {
      const agent = await automationWriter();
      const res = await agent.post(url()).send({ advertEnabled: true, advertMode: 'zero_hop' });
      expect(res.status).toBe(200);
      expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'meshcoreAutoAnnounceAdvertMode')).toBe('zero_hop');
      expect((await agent.get(url())).body.data.advertMode).toBe('zero_hop');
    });

    it('POST rejects an invalid advertMode without a partial save', async () => {
      const agent = await automationWriter();
      await harness.db.settings.setSourceSetting(harness.sourceA, 'meshcoreAutoAnnounceMessage', 'before');
      const res = await agent.post(url()).send({ message: 'after', advertMode: 'loud' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'INVALID_ADVERT_MODE' });
      expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'meshcoreAutoAnnounceMessage')).toBe('before');
    });

    it('saving auto-announce settings does not reset the flood floor', async () => {
      const agent = await automationWriter();
      await harness.db.settings.setSourceSetting(harness.sourceA, 'meshcoreLastFloodAdvertAt', '1767225600000');
      const res = await agent.post(url()).send({
        enabled: true, advertEnabled: true, advertMode: 'flood', advertDelaySeconds: 10,
      });
      expect(res.status).toBe(200);
      expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'meshcoreLastFloodAdvertAt')).toBe('1767225600000');
    });
  });

  describe('timer trigger advertMode', () => {
    async function automationWriter() {
      await harness.grant(harness.limited.id, 'automation', 'write', harness.sourceA);
      return harness.loginAs(harness.limited);
    }
    const url = () => `${base(harness.sourceA)}/automation/timers`;
    const trigger = { id: 't1', name: 'adv', enabled: true, scheduleType: 'interval', intervalMinutes: 60, responseType: 'advert' };

    it('accepts triggers with a valid or absent advertMode', async () => {
      const agent = await automationWriter();
      const res = await agent.post(url()).send({ triggers: [{ ...trigger, advertMode: 'zero_hop' }, { ...trigger, id: 't2' }] });
      expect(res.status).toBe(200);
    });

    it('rejects a trigger with an invalid advertMode', async () => {
      const agent = await automationWriter();
      const res = await agent.post(url()).send({ triggers: [{ ...trigger, advertMode: 'huge' }] });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'INVALID_ADVERT_MODE' });
    });
  });
});
