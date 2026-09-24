/**
 * MeshCore self-advert reach + automated flood floor.
 *
 * - sendAdvert(mode) routes zero-hop / flood to the right companion command
 *   (CMD_SEND_SELF_ADVERT type byte via the `send_advert` bridge command) and
 *   repeater CLI verb (`advert.zerohop` / `advert`), and detects repeater
 *   firmware that floods on `advert.zerohop`.
 * - The automated flood floor (one flood per 60 min per source) is read from
 *   and written to the REAL per-source setting in the test's :memory: SQLite
 *   DB, so a new manager instance (a restart) sees the last flood.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import databaseService from '../services/database.js';
import { logger } from '../utils/logger.js';
import { MeshCoreZeroHopAdvertUnsupportedError, classifyRepeaterAdvertReply } from './utils/meshcoreAdvert.js';

interface BridgeCall { cmd: string; params: Record<string, unknown>; }

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();
const MIN = 60_000;
let seq = 0;

function companion(sourceId: string): { manager: MeshCoreManager; calls: BridgeCall[] } {
  const m = new MeshCoreManager(sourceId);
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  const calls: BridgeCall[] = [];
  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    calls.push({ cmd, params });
    return { id: '1', success: true, data: {} };
  };
  return { manager: m, calls };
}

function repeater(sourceId: string, reply: (cmd: string) => string): { manager: MeshCoreManager; cmds: string[] } {
  const m = new MeshCoreManager(sourceId);
  (m as any).deviceType = MeshCoreDeviceType.REPEATER;
  (m as any).connected = true;
  const cmds: string[] = [];
  (m as any).sendRepeaterCommand = async (cmd: string) => {
    cmds.push(cmd);
    return reply(cmd);
  };
  return { manager: m, cmds };
}

const adverts = (calls: BridgeCall[]) => calls.filter(c => c.cmd === 'send_advert').map(c => c.params.mode);
const lastFlood = (sourceId: string) => databaseService.settings.getSettingForSource(sourceId, 'meshcoreLastFloodAdvertAt');

describe('MeshCore advert reach + automated flood floor', () => {
  let sourceId: string;

  beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
    vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    // Fresh source per test: the :memory: DB lives for the whole file.
    sourceId = `advert-src-${++seq}`;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('sendAdvert mode routing', () => {
    it('companion zero-hop sends mode zero_hop and records no flood', async () => {
      const { manager, calls } = companion(sourceId);
      expect(await manager.sendAdvert('zero_hop')).toBe(true);
      expect(adverts(calls)).toEqual(['zero_hop']);
      expect(calls.some(c => c.cmd === 'set_flood_scope')).toBe(false);
      expect(await lastFlood(sourceId)).toBeNull();
    });

    it('companion flood sends mode flood and records the flood time', async () => {
      const { manager, calls } = companion(sourceId);
      expect(await manager.sendAdvert('flood')).toBe(true);
      expect(adverts(calls)).toEqual(['flood']);
      expect(await lastFlood(sourceId)).toBe(String(T0));
    });

    it('rejects an unknown mode without sending', async () => {
      const { manager, calls } = companion(sourceId);
      await expect(manager.sendAdvert('multi' as any)).rejects.toThrow(/Invalid advert mode/);
      expect(calls).toHaveLength(0);
    });

    it('repeater zero-hop uses the advert.zerohop CLI verb', async () => {
      const { manager, cmds } = repeater(sourceId, () => '  -> OK - zerohop advert sent');
      expect(await manager.sendAdvert('zero_hop')).toBe(true);
      expect(cmds).toEqual(['advert.zerohop']);
      expect(await lastFlood(sourceId)).toBeNull();
    });

    it('repeater flood uses the advert CLI verb and records the flood time', async () => {
      const { manager, cmds } = repeater(sourceId, () => '  -> OK - Advert sent');
      expect(await manager.sendAdvert('flood')).toBe(true);
      expect(cmds).toEqual(['advert']);
      expect(await lastFlood(sourceId)).toBe(String(T0));
    });

    it('repeater without advert.zerohop: reports the flood it sent, records it, then refuses further zero-hop', async () => {
      // Old firmware prefix-matches `advert.zerohop` as `advert` and floods.
      const { manager, cmds } = repeater(sourceId, () => '  -> OK - Advert sent');
      const first = manager.sendAdvert('zero_hop');
      await expect(first).rejects.toBeInstanceOf(MeshCoreZeroHopAdvertUnsupportedError);
      await expect(manager.sendAdvert('zero_hop').catch(e => e)).resolves.toMatchObject({ floodSent: false });
      // Only the first request reached the device; the second was refused.
      expect(cmds).toEqual(['advert.zerohop']);
      expect(await lastFlood(sourceId)).toBe(String(T0));
    });

    it('repeater error reply reports failure', async () => {
      const { manager } = repeater(sourceId, () => 'Unknown command');
      expect(await manager.sendAdvert('flood')).toBe(false);
      expect(await lastFlood(sourceId)).toBeNull();
    });
  });

  describe('classifyRepeaterAdvertReply', () => {
    it('classifies the CommonCLI replies', () => {
      expect(classifyRepeaterAdvertReply('  -> OK - zerohop advert sent')).toBe('zero_hop');
      expect(classifyRepeaterAdvertReply('  -> OK - Advert sent')).toBe('flood');
      expect(classifyRepeaterAdvertReply('Error: busy')).toBe('error');
      expect(classifyRepeaterAdvertReply('')).toBe('unknown');
    });
  });

  describe('automated flood floor', () => {
    it('allows the first automated flood and records it in the DB', async () => {
      const { manager, calls } = companion(sourceId);
      expect(await manager.sendAutomatedAdvert('flood', 'test')).toEqual({ sent: true });
      expect(adverts(calls)).toEqual(['flood']);
      expect(await lastFlood(sourceId)).toBe(String(T0));
    });

    it('skips an automated flood inside the window without downgrading it', async () => {
      const { manager, calls } = companion(sourceId);
      await manager.sendAutomatedAdvert('flood', 'test');
      vi.setSystemTime(T0 + 59 * MIN);
      const r = await manager.sendAutomatedAdvert('flood', 'test');
      expect(r.sent).toBe(false);
      expect(r.reason).toMatch(/flood advert skipped: last flood was 59 min ago/);
      // No second advert of ANY kind — the flood is skipped, not turned into zero-hop.
      expect(adverts(calls)).toEqual(['flood']);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('flood advert skipped'));
    });

    it('allows an automated flood once the window has passed', async () => {
      const { manager, calls } = companion(sourceId);
      await manager.sendAutomatedAdvert('flood', 'test');
      vi.setSystemTime(T0 + 60 * MIN);
      expect((await manager.sendAutomatedAdvert('flood', 'test')).sent).toBe(true);
      expect(adverts(calls)).toEqual(['flood', 'flood']);
      expect(await lastFlood(sourceId)).toBe(String(T0 + 60 * MIN));
    });

    it('survives a restart: a NEW manager instance still sees the last flood', async () => {
      await companion(sourceId).manager.sendAutomatedAdvert('flood', 'test');
      vi.setSystemTime(T0 + 10 * MIN);
      const { manager: restarted, calls } = companion(sourceId);
      const r = await restarted.sendAutomatedAdvert('flood', 'test');
      expect(r.sent).toBe(false);
      expect(adverts(calls)).toEqual([]);
    });

    it('is per source: a flood on one source does not block another', async () => {
      await companion(sourceId).manager.sendAutomatedAdvert('flood', 'test');
      const other = companion(`${sourceId}-other`);
      expect((await other.manager.sendAutomatedAdvert('flood', 'test')).sent).toBe(true);
    });

    it('does not floor automated zero-hop adverts', async () => {
      const { manager, calls } = companion(sourceId);
      await manager.sendAutomatedAdvert('flood', 'test');
      expect((await manager.sendAutomatedAdvert('zero_hop', 'test')).sent).toBe(true);
      expect((await manager.sendAutomatedAdvert('zero_hop', 'test')).sent).toBe(true);
      expect(adverts(calls)).toEqual(['flood', 'zero_hop', 'zero_hop']);
    });

    it('does not block a manual flood, which restarts the window', async () => {
      const { manager, calls } = companion(sourceId);
      await manager.sendAutomatedAdvert('flood', 'test');
      vi.setSystemTime(T0 + 30 * MIN);
      expect(await manager.sendAdvert('flood')).toBe(true);
      expect(await lastFlood(sourceId)).toBe(String(T0 + 30 * MIN));
      // 40 min after the ORIGINAL automated flood, but only 10 after the manual one.
      vi.setSystemTime(T0 + 70 * MIN);
      expect((await manager.sendAutomatedAdvert('flood', 'test')).sent).toBe(false);
      expect(adverts(calls)).toEqual(['flood', 'flood']);
    });

    it('lets only one of two concurrent automated floods through', async () => {
      const { manager, calls } = companion(sourceId);
      const [a, b] = await Promise.all([
        manager.sendAutomatedAdvert('flood', 'a'),
        manager.sendAutomatedAdvert('flood', 'b'),
      ]);
      expect([a.sent, b.sent].sort()).toEqual([false, true]);
      expect(adverts(calls)).toEqual(['flood']);
    });

    it('a settings write to other keys (e.g. an auto-announce save) leaves the floor intact', async () => {
      const { manager } = companion(sourceId);
      await manager.sendAutomatedAdvert('flood', 'test');
      await databaseService.settings.setSourceSetting(sourceId, 'meshcoreAutoAnnounceAdvertMode', 'flood');
      await databaseService.settings.setSourceSetting(sourceId, 'meshcoreAutoAnnounceAdvertEnabled', 'true');
      vi.setSystemTime(T0 + 5 * MIN);
      expect((await manager.sendAutomatedAdvert('flood', 'test')).sent).toBe(false);
    });
  });

  describe('timer triggers', () => {
    const saveTriggers = (triggers: unknown[]) =>
      databaseService.settings.setSourceSetting(sourceId, 'meshcoreTimerTriggers', JSON.stringify(triggers));
    const base = { name: 'adv', enabled: true, scheduleType: 'interval', intervalMinutes: 1, responseType: 'advert' };

    it('a legacy advert trigger with no advertMode floods', async () => {
      const { manager, calls } = companion(sourceId);
      await saveTriggers([{ id: 't1', ...base }]);
      expect(await manager.runTimerTrigger('t1')).toEqual({ ok: true, reason: undefined });
      expect(adverts(calls)).toEqual(['flood']);
    });

    it('a legacy flood trigger inside the window is skipped and reports why', async () => {
      const { manager, calls } = companion(sourceId);
      await saveTriggers([{ id: 't1', ...base }]);
      await manager.runTimerTrigger('t1');
      vi.setSystemTime(T0 + 1 * MIN);
      const r = await manager.runTimerTrigger('t1');
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/flood advert skipped/);
      expect(adverts(calls)).toEqual(['flood']);
      const stored = JSON.parse((await databaseService.settings.getSettingForSource(sourceId, 'meshcoreTimerTriggers'))!);
      expect(stored[0]).toMatchObject({ lastResult: 'error', lastError: expect.stringMatching(/flood advert skipped/) });
    });

    it('a zero-hop trigger sends zero-hop every time', async () => {
      const { manager, calls } = companion(sourceId);
      await saveTriggers([{ id: 't1', ...base, advertMode: 'zero_hop' }]);
      await manager.runTimerTrigger('t1');
      vi.setSystemTime(T0 + 1 * MIN);
      await manager.runTimerTrigger('t1');
      expect(adverts(calls)).toEqual(['zero_hop', 'zero_hop']);
    });
  });

  describe('auto-announce advert burst', () => {
    async function configure(extra: Record<string, string>) {
      const s = databaseService.settings;
      await s.setSourceSetting(sourceId, 'meshcoreAutoAnnounceMessage', 'hello');
      await s.setSourceSetting(sourceId, 'meshcoreAutoAnnounceChannelIndexes', '0');
      await s.setSourceSetting(sourceId, 'meshcoreAutoAnnounceAdvertEnabled', 'true');
      await s.setSourceSetting(sourceId, 'meshcoreAutoAnnounceAdvertDelaySeconds', '5');
      for (const [k, v] of Object.entries(extra)) await s.setSourceSetting(sourceId, k, v);
    }

    async function cycle(manager: MeshCoreManager) {
      (manager as any).sendMessage = vi.fn().mockResolvedValue(true);
      await manager.runAutoAnnounceCycle('manual');
      await vi.advanceTimersByTimeAsync(5_000);
    }

    it('a legacy burst with no mode floods, and a second burst inside the hour is skipped', async () => {
      await configure({});
      const { manager, calls } = companion(sourceId);
      await cycle(manager);
      expect(adverts(calls)).toEqual(['flood']);
      await cycle(manager);
      expect(adverts(calls)).toEqual(['flood']);
    });

    it('a zero-hop burst sends zero-hop', async () => {
      await configure({ meshcoreAutoAnnounceAdvertMode: 'zero_hop' });
      const { manager, calls } = companion(sourceId);
      await cycle(manager);
      await cycle(manager);
      expect(adverts(calls)).toEqual(['zero_hop', 'zero_hop']);
    });
  });
});
