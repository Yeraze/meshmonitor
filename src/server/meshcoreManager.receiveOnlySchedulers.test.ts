/**
 * MeshCore strict receive-only mode (#4547 epic, Phase 1) — WP3: scheduler /
 * timer / auto-* silent skips.
 *
 * Covers every site in spec §2.3.6: DM-ack retry, channel retry,
 * auto-pathfinding (loop entry + per-target), auto-announce (+ its advert
 * burst), timer triggers (interval + cron), auto-responder, auto-acknowledge.
 *
 * For each site:
 *  - receive-only ON: the tick completes with NO call to the guarded send
 *    primitive, no unhandled promise rejection, and (where applicable) the
 *    underlying timer/interval/cron stays armed.
 *  - receive-only OFF: the same tick DOES reach the primitive — proves the
 *    skip is conditional, not a permanent disable.
 *
 * A dedicated test also proves the log-volume contract: across >= 5 ticks
 * with receive-only ON, logger.info is never called (only logger.debug) —
 * the sole logger.info call lives in setReceiveOnly() itself on a state
 * change, which each test explicitly excludes from its assertion window.
 *
 * See docs/internal/dev-notes/MESHCORE_RECEIVE_ONLY_PHASE1_SPEC.md §2.3.6, §3.3.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType, type MeshCoreMessage } from './meshcoreManager.js';
import { logger } from '../utils/logger.js';
import databaseService from '../services/database.js';

interface BridgeCall { cmd: string; params: Record<string, unknown>; }

/** Shared manager factory: companion, connected, records every bridge call. */
function makeManager(): { manager: MeshCoreManager; bridgeCalls: BridgeCall[] } {
  const m = new MeshCoreManager('test-source');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;

  const bridgeCalls: BridgeCall[] = [];
  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    bridgeCalls.push({ cmd, params });
    if (cmd === 'send_message') {
      if (!params.to) return { id: '1', success: true, data: {} };
      return { id: '1', success: true, data: { expectedAckCrc: 111, estTimeout: 8000 } };
    }
    if (cmd === 'reset_path') return { id: '1', success: true };
    if (cmd === 'discover_path') return { id: '1', success: true, data: {} };
    if (cmd === 'get_neighbours') return { id: '1', success: true, data: { total: 0, neighbours: [] } };
    if (cmd === 'send_advert') return { id: '1', success: true, data: {} };
    return { id: '1', success: true, data: {} };
  };

  vi.spyOn(databaseService, 'channels', 'get').mockReturnValue({
    getChannelById: vi.fn(async () => null),
    updateChannelScope: vi.fn(async () => {}),
    upsertChannel: vi.fn(async () => {}),
    getAllChannels: vi.fn(async () => []),
    deleteChannel: vi.fn(async () => {}),
  } as any);

  return { manager: m, bridgeCalls };
}

const sends = (calls: BridgeCall[]) => calls.filter(c => c.cmd === 'send_message');
const resets = (calls: BridgeCall[]) => calls.filter(c => c.cmd === 'reset_path');

const PUBKEY = 'b'.repeat(64);

describe('MeshCoreManager scheduler silent skips (#4547 WP3)', () => {
  let unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => { unhandled.push(err); };

  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
    vi.useFakeTimers();
    vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(databaseService.settings, 'getSettingForSource').mockResolvedValue(null);
    vi.spyOn(databaseService.settings, 'setSourceSetting').mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------- DM ack retry

  describe('DM ack retry (handleDmAckTimeout)', () => {
    it('receive-only ON: the ack-timeout tick skips the resend, no unhandled rejection', async () => {
      const { manager, bridgeCalls } = makeManager();
      await manager.sendMessageWithResult('hello', PUBKEY);
      expect(sends(bridgeCalls)).toHaveLength(1);

      manager.setReceiveOnly(true);
      const infoSpy = vi.spyOn(logger, 'info');
      infoSpy.mockClear();

      await vi.advanceTimersByTimeAsync(10_000); // ack-timeout fires
      await Promise.resolve();

      expect(sends(bridgeCalls)).toHaveLength(1); // no retry sent
      expect(resets(bridgeCalls)).toHaveLength(0);
      expect(unhandled).toHaveLength(0);
      expect(infoSpy).not.toHaveBeenCalled();
    });

    it('receive-only OFF: the same ack-timeout tick resends normally', async () => {
      const { manager, bridgeCalls } = makeManager();
      await manager.sendMessageWithResult('hello', PUBKEY);

      await vi.advanceTimersByTimeAsync(10_000);

      expect(sends(bridgeCalls)).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------- Channel retry

  describe('Channel retry (handleChannelRetryTimeout)', () => {
    function withChannelRetry(_manager: MeshCoreManager) {
      vi.spyOn(databaseService.settings, 'getSettingAsBoolean').mockResolvedValue(true);
      vi.spyOn(databaseService.meshcore, 'getHeardRepeatersForMessage').mockResolvedValue([]);
    }

    it('receive-only ON: the 30s retry window skips the resend, no unhandled rejection', async () => {
      const { manager, bridgeCalls } = makeManager();
      withChannelRetry(manager);

      await manager.sendMessage('hi', undefined, 0, undefined, true);
      expect(sends(bridgeCalls)).toHaveLength(1);
      expect((manager as any).pendingChannelRetries.size).toBe(1);

      manager.setReceiveOnly(true);
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();

      expect(sends(bridgeCalls)).toHaveLength(1); // no resend
      expect(unhandled).toHaveLength(0);
    });

    it('receive-only OFF: zero repeaters heard within 30s still triggers exactly one resend', async () => {
      const { manager, bridgeCalls } = makeManager();
      withChannelRetry(manager);

      await manager.sendMessage('hi', undefined, 0, undefined, true);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(sends(bridgeCalls)).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------- Auto-pathfinding

  describe('Auto-pathfinding (executeRun)', () => {
    function mockPathfindingSettings() {
      vi.spyOn(databaseService.settings, 'getSettingForSource').mockImplementation(
        async (_sourceId: string | null | undefined, key: string) => {
          switch (key) {
            case 'meshcoreAutoPathfindingEnabled': return 'true';
            case 'meshcoreAutoPathfindingPathDiscoveryEnabled': return 'true';
            case 'meshcoreAutoPathfindingNeighborsEnabled': return 'true';
            case 'meshcoreAutoPathfindingIntervalMinutes': return '3';
            case 'meshcoreAutoPathfindingRepeatHours': return '1';
            default: return null;
          }
        },
      );
      vi.spyOn(databaseService, 'getMeshcorePathfindingFilterSettingsAsync').mockResolvedValue({
        enabled: false, targetKeys: [], contactsEnabled: false, regexEnabled: false, nameRegex: '.*',
        lastHeardEnabled: false, lastHeardHours: 168, hopsEnabled: false, hopsMin: 0, hopsMax: 10,
        signalEnabled: false, rssiMin: -200, snrMin: -100,
      });
    }

    beforeEach(() => {
      vi.spyOn(Math, 'random').mockReturnValue(0); // deterministic zero jitter
    });

    it('receive-only ON at loop entry: no target is ever contacted, interval stays armed', async () => {
      const { manager, bridgeCalls } = makeManager();
      mockPathfindingSettings();
      (manager as any).contacts = new Map([
        [PUBKEY, { publicKey: PUBKEY, advType: MeshCoreDeviceType.COMPANION }],
      ]);
      manager.setReceiveOnly(true);

      await manager.startAutoPathfinding();
      await vi.advanceTimersByTimeAsync(0); // zero jitter -> executeRun fires immediately

      expect(bridgeCalls.filter(c => c.cmd === 'discover_path' || c.cmd === 'get_neighbours')).toHaveLength(0);
      expect((manager as any).autoPathfindingTimer).not.toBeNull(); // still armed
      expect(unhandled).toHaveLength(0);
    });

    it('receive-only OFF: loop entry reaches discover_path for an eligible target', async () => {
      const { manager, bridgeCalls } = makeManager();
      mockPathfindingSettings();
      (manager as any).contacts = new Map([
        [PUBKEY, { publicKey: PUBKEY, advType: MeshCoreDeviceType.COMPANION }],
      ]);

      await manager.startAutoPathfinding();
      await vi.advanceTimersByTimeAsync(0);

      expect(bridgeCalls.filter(c => c.cmd === 'discover_path')).toHaveLength(1);
    });

    it('receive-only flips mid-run: the per-target re-check stops before the next target', async () => {
      const { manager, bridgeCalls } = makeManager();
      mockPathfindingSettings();
      const companionKey = 'c'.repeat(64);
      const repeaterKey = 'd'.repeat(64);
      (manager as any).contacts = new Map([
        [companionKey, { publicKey: companionKey, advType: MeshCoreDeviceType.COMPANION }],
        [repeaterKey, { publicKey: repeaterKey, advType: MeshCoreDeviceType.REPEATER }],
      ]);

      // Flip the flag ON right after the first target's bridge call succeeds,
      // simulating a concurrent settings write landing mid-loop.
      const originalSendBridgeCommand = (manager as any).sendBridgeCommand.bind(manager);
      (manager as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
        const result = await originalSendBridgeCommand(cmd, params);
        if (cmd === 'discover_path') manager.setReceiveOnly(true);
        return result;
      };

      await manager.startAutoPathfinding();
      await vi.advanceTimersByTimeAsync(0); // fire executeRun (zero jitter)
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000); // the inter-target sleep

      expect(bridgeCalls.filter(c => c.cmd === 'discover_path')).toHaveLength(1);
      // The second (repeater) target's get_neighbours — and the ensureSavedLogin
      // it would otherwise throw from — is never reached.
      expect(bridgeCalls.filter(c => c.cmd === 'get_neighbours')).toHaveLength(0);
      expect(unhandled).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------- Auto-announce

  describe('Auto-announce (runAutoAnnounceCycle) + advert burst', () => {
    it('receive-only ON: skips before any settings read or send', async () => {
      const { manager } = makeManager();
      const getSettingSpy = vi.spyOn(databaseService.settings, 'getSettingForSource');
      const sendMessage = vi.fn().mockResolvedValue(true);
      (manager as any).sendMessage = sendMessage;
      manager.setReceiveOnly(true);

      const result = await manager.runAutoAnnounceCycle('cron');

      expect(result).toEqual({ sent: 0, total: 0 });
      expect(sendMessage).not.toHaveBeenCalled();
      expect(getSettingSpy).not.toHaveBeenCalled();
    });

    it('receive-only OFF: reaches sendMessage for each configured channel', async () => {
      const { manager } = makeManager();
      const announceSettings: Record<string, string | null> = {
        meshcoreAutoAnnounceMessage: 'hello mesh',
        meshcoreAutoAnnounceChannelIndexes: '0',
        meshcoreAutoAnnounceAdvertEnabled: 'false',
      };
      vi.spyOn(databaseService.settings, 'getSettingForSource').mockImplementation(
        async (_sourceId: string | null | undefined, key: string) => (key in announceSettings ? announceSettings[key] : null),
      );
      const sendMessage = vi.fn().mockResolvedValue(true);
      (manager as any).sendMessage = sendMessage;

      const result = await manager.runAutoAnnounceCycle('cron');

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(result.sent).toBe(1);
    });

    it('advert burst: receive-only ON when the burst timer fires skips sendAdvert', async () => {
      const { manager } = makeManager();
      const announceSettings: Record<string, string | null> = {
        meshcoreAutoAnnounceMessage: 'hello mesh',
        meshcoreAutoAnnounceChannelIndexes: '0',
        meshcoreAutoAnnounceAdvertEnabled: 'true',
        meshcoreAutoAnnounceAdvertDelaySeconds: '30',
      };
      vi.spyOn(databaseService.settings, 'getSettingForSource').mockImplementation(
        async (_sourceId: string | null | undefined, key: string) => (key in announceSettings ? announceSettings[key] : null),
      );
      (manager as any).sendMessage = vi.fn().mockResolvedValue(true);
      const sendAdvert = vi.fn().mockResolvedValue(true);
      (manager as any).sendAdvert = sendAdvert;

      await manager.runAutoAnnounceCycle('cron');
      expect((manager as any).autoAnnounceAdvertTimer).not.toBeNull();

      // Flag flips ON during the burst delay.
      manager.setReceiveOnly(true);
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();

      expect(sendAdvert).not.toHaveBeenCalled();
      expect(unhandled).toHaveLength(0);
    });

    it('advert burst: receive-only OFF fires sendAdvert after the delay', async () => {
      const { manager } = makeManager();
      const announceSettings: Record<string, string | null> = {
        meshcoreAutoAnnounceMessage: 'hello mesh',
        meshcoreAutoAnnounceChannelIndexes: '0',
        meshcoreAutoAnnounceAdvertEnabled: 'true',
        meshcoreAutoAnnounceAdvertDelaySeconds: '30',
      };
      vi.spyOn(databaseService.settings, 'getSettingForSource').mockImplementation(
        async (_sourceId: string | null | undefined, key: string) => (key in announceSettings ? announceSettings[key] : null),
      );
      (manager as any).sendMessage = vi.fn().mockResolvedValue(true);
      const sendAdvert = vi.fn().mockResolvedValue(true);
      (manager as any).sendAdvert = sendAdvert;

      await manager.runAutoAnnounceCycle('cron');
      await vi.advanceTimersByTimeAsync(30_000);

      expect(sendAdvert).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------- Timer triggers

  describe('Timer triggers (armTimerTrigger)', () => {
    const intervalTrigger = {
      id: 'timer-1',
      name: 'Every 5m',
      enabled: true,
      scheduleType: 'interval' as const,
      intervalMinutes: 5,
      responseType: 'text' as const,
      response: 'hi',
      destination: 'channel' as const,
      channelIndex: 0,
    };

    it('interval: receive-only ON skips runTimerTrigger, interval stays armed across 5 ticks, no logger.info', async () => {
      const { manager } = makeManager();
      const runTimerTrigger = vi.fn().mockResolvedValue({ ok: true });
      (manager as any).runTimerTrigger = runTimerTrigger;
      manager.setReceiveOnly(true);

      const infoSpy = vi.spyOn(logger, 'info');

      (manager as any).armTimerTrigger(intervalTrigger);
      expect((manager as any).timerTriggerIntervals.size).toBe(1);
      infoSpy.mockClear(); // exclude the one-shot "armed" log from the window we assert on

      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      }

      expect(runTimerTrigger).not.toHaveBeenCalled();
      expect((manager as any).timerTriggerIntervals.size).toBe(1); // still armed
      expect(infoSpy).not.toHaveBeenCalled();
      expect(unhandled).toHaveLength(0);
    });

    it('interval: receive-only OFF calls runTimerTrigger on each tick', async () => {
      const { manager } = makeManager();
      const runTimerTrigger = vi.fn().mockResolvedValue({ ok: true });
      (manager as any).runTimerTrigger = runTimerTrigger;

      (manager as any).armTimerTrigger(intervalTrigger);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      expect(runTimerTrigger).toHaveBeenCalledTimes(2);
    });

    it('cron: receive-only ON skips runTimerTrigger, cron stays armed', async () => {
      const { manager } = makeManager();
      const runTimerTrigger = vi.fn().mockResolvedValue({ ok: true });
      (manager as any).runTimerTrigger = runTimerTrigger;
      manager.setReceiveOnly(true);

      const cronTrigger = { ...intervalTrigger, id: 'timer-2', scheduleType: 'cron' as const, cronExpression: '* * * * *' };
      (manager as any).armTimerTrigger(cronTrigger);
      expect((manager as any).timerTriggerCrons.size).toBe(1);

      await vi.advanceTimersByTimeAsync(61_000); // cross a minute boundary

      expect(runTimerTrigger).not.toHaveBeenCalled();
      expect((manager as any).timerTriggerCrons.size).toBe(1); // still armed
      expect(unhandled).toHaveLength(0);
    });

    it('cron: receive-only OFF calls runTimerTrigger once the minute boundary passes', async () => {
      const { manager } = makeManager();
      const runTimerTrigger = vi.fn().mockResolvedValue({ ok: true });
      (manager as any).runTimerTrigger = runTimerTrigger;

      const cronTrigger = { ...intervalTrigger, id: 'timer-3', scheduleType: 'cron' as const, cronExpression: '* * * * *' };
      (manager as any).armTimerTrigger(cronTrigger);

      await vi.advanceTimersByTimeAsync(61_000);

      expect(runTimerTrigger).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------- Auto-responder

  describe('Auto-responder (checkAutoResponder)', () => {
    const trigger = {
      id: 't1', name: 'ping', enabled: true, pattern: '^ping',
      responseType: 'text' as const, response: 'pong',
      channels: [] as number[], listenDMs: true, replyAsDM: true, cooldownSeconds: 0,
    };
    const message: MeshCoreMessage = {
      id: 'm1', fromPublicKey: PUBKEY, text: 'ping', timestamp: Date.now(),
    };

    it('receive-only ON: skips before any settings read or send', async () => {
      const { manager } = makeManager();
      const getSettingSpy = vi.spyOn(databaseService.settings, 'getSettingForSource');
      const sendMessage = vi.fn().mockResolvedValue(true);
      (manager as any).sendMessage = sendMessage;
      manager.setReceiveOnly(true);

      await (manager as any).checkAutoResponder(message, true, undefined);

      expect(sendMessage).not.toHaveBeenCalled();
      expect(getSettingSpy).not.toHaveBeenCalled();
    });

    it('receive-only OFF: a matching trigger reaches sendMessage', async () => {
      const { manager } = makeManager();
      vi.spyOn(databaseService.settings, 'getSettingForSource').mockImplementation(
        async (_sourceId: string | null | undefined, key: string) => {
          if (key === 'meshcoreAutoResponderEnabled') return 'true';
          if (key === 'meshcoreAutoResponderTriggers') return JSON.stringify([trigger]);
          return null;
        },
      );
      const sendMessage = vi.fn().mockResolvedValue(true);
      (manager as any).sendMessage = sendMessage;

      await (manager as any).checkAutoResponder(message, true, undefined);

      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------- Auto-acknowledge

  describe('Auto-acknowledge (checkAutoAcknowledge)', () => {
    const message: MeshCoreMessage = {
      id: 'm1', fromPublicKey: PUBKEY, text: 'ping', timestamp: Date.now(),
    };

    it('receive-only ON: skips before any settings read or send', async () => {
      const { manager } = makeManager();
      const getSettingSpy = vi.spyOn(databaseService.settings, 'getSettingForSource');
      const sendMessage = vi.fn().mockResolvedValue(true);
      (manager as any).sendMessage = sendMessage;
      manager.setReceiveOnly(true);

      await (manager as any).checkAutoAcknowledge(message, true, undefined, null, null);

      expect(sendMessage).not.toHaveBeenCalled();
      expect(getSettingSpy).not.toHaveBeenCalled();
    });

    it('receive-only OFF: a matching regex reaches sendMessage', async () => {
      const { manager } = makeManager();
      const autoAckSettings: Record<string, string | null> = {
        meshcoreAutoAckEnabled: 'true',
        meshcoreAutoAckRegex: '^ping',
        meshcoreAutoAckDirectMessages: 'true',
        meshcoreAutoAckCooldownSeconds: '0',
        meshcoreAutoAckUseDM: 'true',
        meshcoreAutoAckMessage: 'ack',
        meshcoreAutoAckPreSendDelaySeconds: '0',
      };
      vi.spyOn(databaseService.settings, 'getSettingForSource').mockImplementation(
        async (_sourceId: string | null | undefined, key: string) => (key in autoAckSettings ? autoAckSettings[key] : null),
      );
      const sendMessage = vi.fn().mockResolvedValue(true);
      (manager as any).sendMessage = sendMessage;
      (manager as any).contacts = new Map([[PUBKEY, { publicKey: PUBKEY, advName: 'Bob' }]]);

      await (manager as any).checkAutoAcknowledge(message, true, undefined, null, null);

      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------- Aggregate log-volume check

  it('across >= 5 skipped ticks on distinct schedulers, logger.info fires zero times', async () => {
    const { manager } = makeManager();
    const runTimerTrigger = vi.fn().mockResolvedValue({ ok: true });
    (manager as any).runTimerTrigger = runTimerTrigger;
    (manager as any).sendMessage = vi.fn().mockResolvedValue(true);

    manager.setReceiveOnly(true);
    const infoSpy = vi.spyOn(logger, 'info');

    (manager as any).armTimerTrigger(intervalTriggerFixture());
    infoSpy.mockClear(); // exclude the one-shot "armed" log from the window we assert on
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    }
    await (manager as any).checkAutoResponder(
      { id: 'm1', fromPublicKey: PUBKEY, text: 'ping', timestamp: Date.now() },
      true,
      undefined,
    );
    await (manager as any).checkAutoAcknowledge(
      { id: 'm2', fromPublicKey: PUBKEY, text: 'ping', timestamp: Date.now() },
      true,
      undefined,
      null,
      null,
    );

    expect(runTimerTrigger).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(unhandled).toHaveLength(0);
  });
});

function intervalTriggerFixture() {
  return {
    id: 'timer-agg',
    name: 'Every 5m',
    enabled: true,
    scheduleType: 'interval' as const,
    intervalMinutes: 5,
    responseType: 'text' as const,
    response: 'hi',
    destination: 'channel' as const,
    channelIndex: 0,
  };
}
