/**
 * Route tests (P8a #6257) — /config/ble-pin, /config/multi-acks,
 * /config/factory-reset. Real-middleware harness; the manager is a stub.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { MeshCoreDeviceCommandError } from '../errors/meshcoreDeviceCommandError.js';

const h = vi.hoisted(() => ({
  stubs: new Map<string, Record<string, any>>(),
  order: [] as string[],
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (id: string) => h.stubs.get(id),
    getAllManagers: () => Array.from(h.stubs.values()),
  },
}));

function stub(sourceId: string) {
  return {
    sourceId,
    sourceType: 'meshcore' as const,
    isReceiveOnly: () => false,
    canTransmit: () => true,
    getBlePin: vi.fn().mockResolvedValue(123456),
    setBlePin: vi.fn().mockResolvedValue(undefined),
    setMultiAcks: vi.fn().mockImplementation(async (v: number) => v),
    factoryReset: vi.fn().mockImplementation(async () => { h.order.push('send'); }),
  };
}

describe('MeshCore companion command routes (P8a #6257)', () => {
  let harness: RouteTestHarness;
  let audit: ReturnType<typeof vi.spyOn>;
  const u = (sid: string, p: string) => `/sources/${sid}/meshcore/config/${p}`;
  const a = () => h.stubs.get(harness.sourceA)!;
  const b = () => h.stubs.get(harness.sourceB)!;

  beforeEach(async () => {
    h.stubs.clear();
    h.order.length = 0;
    h.stubs.set('rt-source-a', stub('rt-source-a'));
    h.stubs.set('rt-source-b', stub('rt-source-b'));
    harness = await createRouteTestApp({ mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes) });
    audit = vi.spyOn(databaseService, 'auditLogAsync').mockImplementation((async (_u: unknown, action: string) => {
      h.order.push(`audit:${action}`);
    }) as any);
  });
  afterEach(async () => {
    audit.mockRestore();
    await harness.cleanup();
  });

  describe('ble-pin', () => {
    it('GET needs configuration:write on this source', async () => {
      await harness.grant(harness.limited.id, 'configuration', 'read', harness.sourceA);
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.get(u(harness.sourceA, 'ble-pin'))).status).toBe(403);
      expect(a().getBlePin).not.toHaveBeenCalled();
    });
    it('GET returns the pin in the envelope', async () => {
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
      const res = await (await harness.loginAs(harness.limited)).get(u(harness.sourceA, 'ble-pin'));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { pin: 123456 } });
    });
    it('POST rejects anonymous callers and the wrong source', async () => {
      expect((await (await harness.loginAs(null)).post(u(harness.sourceA, 'ble-pin')).send({ pin: 123456 })).status).toBe(401);
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceB);
      const res = await (await harness.loginAs(harness.limited)).post(u(harness.sourceA, 'ble-pin')).send({ pin: 123456 });
      expect(res.status).toBe(403);
      expect(a().setBlePin).not.toHaveBeenCalled();
      expect(b().setBlePin).not.toHaveBeenCalled();
    });
    it.each([[123], [1234567], [99999], [1000000], ['123456'], [1.5], [null]])('POST 400 INVALID_PIN for %j', async (pin) => {
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
      const res = await (await harness.loginAs(harness.limited)).post(u(harness.sourceA, 'ble-pin')).send({ pin });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_PIN');
      expect(a().setBlePin).not.toHaveBeenCalled();
    });
    it.each([[0], [100000], [999999]])('POST accepts %j and audits without the pin', async (pin) => {
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
      const res = await (await harness.loginAs(harness.limited)).post(u(harness.sourceA, 'ble-pin')).send({ pin });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(a().setBlePin).toHaveBeenCalledWith(pin);
      expect(audit).toHaveBeenCalledTimes(1);
      expect(String(audit.mock.calls[0][3])).not.toContain(String(pin).padStart(6, 'x'));
    });
    it('POST 409 when disconnected or repeater (typed error)', async () => {
      a().setBlePin.mockRejectedValue(new MeshCoreDeviceCommandError('SOURCE_NOT_CONNECTED', 'down'));
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
      const res = await (await harness.loginAs(harness.limited)).post(u(harness.sourceA, 'ble-pin')).send({ pin: 123456 });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SOURCE_NOT_CONNECTED');
    });
  });

  describe('multi-acks', () => {
    it('needs configuration:write on this source', async () => {
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceB);
      const res = await (await harness.loginAs(harness.limited)).post(u(harness.sourceA, 'multi-acks')).send({ value: 1 });
      expect(res.status).toBe(403);
      expect(a().setMultiAcks).not.toHaveBeenCalled();
    });
    it.each([[2], [-1], [0.5], ['1'], [true]])('400 INVALID_VALUE for %j', async (value) => {
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
      const res = await (await harness.loginAs(harness.limited)).post(u(harness.sourceA, 'multi-acks')).send({ value });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_VALUE');
    });
    it.each([[0], [1]])('accepts %j', async (value) => {
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
      const res = await (await harness.loginAs(harness.limited)).post(u(harness.sourceA, 'multi-acks')).send({ value });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { multiAcks: value } });
    });
    it('409 MULTI_ACKS_UNSUPPORTED on readback mismatch, 409 FIRMWARE_UNSUPPORTED on old firmware', async () => {
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      a().setMultiAcks.mockRejectedValueOnce(new MeshCoreDeviceCommandError('MULTI_ACKS_UNSUPPORTED', 'old'));
      const r1 = await agent.post(u(harness.sourceA, 'multi-acks')).send({ value: 1 });
      expect([r1.status, r1.body.code]).toEqual([409, 'MULTI_ACKS_UNSUPPORTED']);
      a().setMultiAcks.mockRejectedValueOnce(new MeshCoreDeviceCommandError('FIRMWARE_UNSUPPORTED', 'old'));
      const r2 = await agent.post(u(harness.sourceA, 'multi-acks')).send({ value: 1 });
      expect([r2.status, r2.body.code]).toEqual([409, 'FIRMWARE_UNSUPPORTED']);
    });
  });

  describe('factory-reset', () => {
    it('401 anonymous, 403 for a non-admin even with configuration:write', async () => {
      expect((await (await harness.loginAs(null)).post(u(harness.sourceA, 'factory-reset')).send({ confirm: true })).status).toBe(401);
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
      const res = await (await harness.loginAs(harness.limited)).post(u(harness.sourceA, 'factory-reset')).send({ confirm: true });
      expect(res.status).toBe(403);
      expect(a().factoryReset).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });
    it('400 DANGER_CONFIRM_REQUIRED without confirm:true', async () => {
      const agent = await harness.loginAs(harness.admin);
      for (const body of [{}, { confirm: 'true' }, { confirm: false }]) {
        const res = await agent.post(u(harness.sourceA, 'factory-reset')).send(body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('DANGER_CONFIRM_REQUIRED');
      }
      expect(a().factoryReset).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });
    it('admin + confirm: audits BEFORE the send, acts on this source only', async () => {
      const res = await (await harness.loginAs(harness.admin)).post(u(harness.sourceA, 'factory-reset')).send({ confirm: true });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { resetSent: true } });
      expect(h.order).toEqual(['audit:meshcore_factory_reset', 'send']);
      expect(a().factoryReset).toHaveBeenCalledTimes(1);
      expect(b().factoryReset).not.toHaveBeenCalled();
    });
    it('409 when disconnected / repeater / old firmware; audit row still exists (audited before)', async () => {
      a().factoryReset.mockRejectedValue(new MeshCoreDeviceCommandError('SOURCE_NOT_CONNECTED', 'down'));
      const res = await (await harness.loginAs(harness.admin)).post(u(harness.sourceA, 'factory-reset')).send({ confirm: true });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SOURCE_NOT_CONNECTED');
      expect(audit).toHaveBeenCalledTimes(1);
    });
  });
});
