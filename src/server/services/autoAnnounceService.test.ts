/**
 * Unit tests for AutoAnnounceService (#3962 Phase 4.2a PR3 §4b).
 *
 * `AutoAnnounceService` is tested against a minimal fake implementing only
 * the narrow public surface it depends on (mirrors the real
 * MeshtasticManager accessors: `sourceId`/`isDeviceConnected`/
 * `isRebootMergeInProgress`/`isAutomationAirtimeGated`/
 * `replaceAnnouncementTokens`/`messageQueue.enqueue`/
 * `broadcastNodeInfoToChannels`) — same pattern as
 * `nodeDbMaintenanceService.test.ts`.
 *
 * Uses `vi.useFakeTimers()` for the scheduler-arming tests, following
 * `heartbeatScheduler.test.ts`'s style.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetSettingForSource = vi.fn();
const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn();
const mockSetSourceSetting = vi.fn();

vi.mock('../../services/database.js', () => ({
  default: {
    settings: {
      getSettingForSource: (...args: unknown[]) => mockGetSettingForSource(...args),
      getSetting: (...args: unknown[]) => mockGetSetting(...args),
      setSetting: (...args: unknown[]) => mockSetSetting(...args),
      setSourceSetting: (...args: unknown[]) => mockSetSourceSetting(...args),
    },
  },
}));

const mockValidateCron = vi.fn((_expr: string) => true);
const mockScheduleCron = vi.fn((_expr: string, _cb: () => void) => ({ stop: vi.fn() }));
vi.mock('../utils/cronScheduler.js', () => ({
  validateCron: (...args: unknown[]) => mockValidateCron(...(args as [string])),
  scheduleCron: (...args: unknown[]) => mockScheduleCron(...(args as [string, () => void])),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { AutoAnnounceService } from './autoAnnounceService.js';

// ---------------------------------------------------------------------------
// Fake manager
// ---------------------------------------------------------------------------

function makeFakeManager(overrides: Partial<{
  sourceId: string;
  deviceConnected: boolean;
  rebootMergeInProgress: boolean;
  automationAirtimeGated: boolean;
}> = {}) {
  const state = {
    sourceId: overrides.sourceId ?? 'test-source',
    deviceConnected: overrides.deviceConnected ?? true,
    rebootMergeInProgress: overrides.rebootMergeInProgress ?? false,
    automationAirtimeGated: overrides.automationAirtimeGated ?? false,
  };
  return {
    state,
    get sourceId() { return state.sourceId; },
    isDeviceConnected: vi.fn(() => state.deviceConnected),
    isRebootMergeInProgress: vi.fn(() => state.rebootMergeInProgress),
    isAutomationAirtimeGated: vi.fn(async () => state.automationAirtimeGated),
    replaceAnnouncementTokens: vi.fn(async (message: string) => message.replace('{VERSION}', '9.9.9')),
    messageQueue: { enqueue: vi.fn() },
    broadcastNodeInfoToChannels: vi.fn().mockResolvedValue(undefined),
  };
}

/** Default DB-settings stub: auto-announce enabled, interval mode, no announce-on-start. */
function stubSettings(overrides: Record<string, string | null> = {}) {
  const defaults: Record<string, string | null> = {
    autoAnnounceEnabled: 'true',
    autoAnnounceUseSchedule: null,
    autoAnnounceIntervalHours: '6',
    autoAnnounceOnStart: null,
    autoAnnounceMessage: 'MeshMonitor {VERSION} online',
    autoAnnounceChannelIndexes: '[0]',
    autoAnnounceNodeInfoEnabled: null,
    lastAnnouncementTime: null,
  };
  const merged = { ...defaults, ...overrides };
  mockGetSettingForSource.mockImplementation((_sourceId: string, key: string) =>
    Promise.resolve(merged[key] ?? null));
}

describe('AutoAnnounceService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockValidateCron.mockReturnValue(true);
    stubSettings();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // ── Arming ─────────────────────────────────────────────────────────────

  describe('startAnnounceScheduler', () => {
    it('does not arm when auto-announce is disabled', async () => {
      stubSettings({ autoAnnounceEnabled: 'false' });
      const mgr = makeFakeManager();
      const svc = new AutoAnnounceService(mgr as any);

      await svc.startAnnounceScheduler();

      expect(svc.running).toBe(false);
    });

    it('arms an interval-mode scheduler from autoAnnounceIntervalHours', async () => {
      stubSettings({ autoAnnounceIntervalHours: '4' });
      const mgr = makeFakeManager();
      const svc = new AutoAnnounceService(mgr as any);

      await svc.startAnnounceScheduler();

      expect(svc.running).toBe(true);
    });

    it('arms a cron-mode scheduler when autoAnnounceUseSchedule is true', async () => {
      stubSettings({ autoAnnounceUseSchedule: 'true', autoAnnounceSchedule: '0 */6 * * *' });
      const mgr = makeFakeManager();
      const svc = new AutoAnnounceService(mgr as any);

      await svc.startAnnounceScheduler();

      expect(svc.running).toBe(true);
      expect(mockValidateCron).toHaveBeenCalledWith('0 */6 * * *');
      expect(mockScheduleCron).toHaveBeenCalled();
    });

    it('does not arm when the cron expression is invalid', async () => {
      stubSettings({ autoAnnounceUseSchedule: 'true', autoAnnounceSchedule: 'not a cron' });
      mockValidateCron.mockReturnValue(false);
      const mgr = makeFakeManager();
      const svc = new AutoAnnounceService(mgr as any);

      await svc.startAnnounceScheduler();

      expect(svc.running).toBe(false);
    });

    it('is stop-then-rearm: a second call replaces the first scheduler rather than stacking', async () => {
      const mgr = makeFakeManager();
      const svc = new AutoAnnounceService(mgr as any);

      await svc.startAnnounceScheduler();
      expect(svc.running).toBe(true);

      await svc.startAnnounceScheduler();
      expect(svc.running).toBe(true);

      // Only one interval tick's worth of sends should ever be in flight —
      // verified indirectly via the onTick test below (calls sendAutoAnnouncement
      // exactly once per elapsed interval, not twice).
      const sendSpy = vi.spyOn(svc, 'sendAutoAnnouncement').mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
      expect(sendSpy).toHaveBeenCalledTimes(1);
    });

    it('onTick calls sendAutoAnnouncement(true) once the interval elapses while connected', async () => {
      const mgr = makeFakeManager({ deviceConnected: true });
      const svc = new AutoAnnounceService(mgr as any);
      const sendSpy = vi.spyOn(svc, 'sendAutoAnnouncement').mockResolvedValue(undefined);

      await svc.startAnnounceScheduler();
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);

      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy).toHaveBeenCalledWith(true);
    });

    it('onTick skips sendAutoAnnouncement when not connected (connected-gate)', async () => {
      const mgr = makeFakeManager({ deviceConnected: false });
      const svc = new AutoAnnounceService(mgr as any);
      const sendSpy = vi.spyOn(svc, 'sendAutoAnnouncement').mockResolvedValue(undefined);

      await svc.startAnnounceScheduler();
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);

      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('announce-on-start: sends after a 30s delay when enabled and no prior announcement exists', async () => {
      stubSettings({ autoAnnounceOnStart: 'true', lastAnnouncementTime: null });
      const mgr = makeFakeManager({ deviceConnected: true });
      const svc = new AutoAnnounceService(mgr as any);
      const sendSpy = vi.spyOn(svc, 'sendAutoAnnouncement').mockResolvedValue(undefined);

      await svc.startAnnounceScheduler();
      expect(sendSpy).not.toHaveBeenCalled(); // not yet — delayed

      await vi.advanceTimersByTimeAsync(30_000);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy).toHaveBeenCalledWith(true);
    });

    it('announce-on-start: spam protection skips the startup send within 1h of the last announcement', async () => {
      stubSettings({ autoAnnounceOnStart: 'true', lastAnnouncementTime: String(Date.now() - 5 * 60 * 1000) });
      const mgr = makeFakeManager({ deviceConnected: true });
      const svc = new AutoAnnounceService(mgr as any);
      const sendSpy = vi.spyOn(svc, 'sendAutoAnnouncement').mockResolvedValue(undefined);

      await svc.startAnnounceScheduler();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(sendSpy).not.toHaveBeenCalled();
    });
  });

  // ── setAnnounceInterval / restartAnnounceScheduler ───────────────────────

  describe('setAnnounceInterval', () => {
    it('throws for an out-of-range interval', () => {
      const mgr = makeFakeManager();
      const svc = new AutoAnnounceService(mgr as any);

      expect(() => svc.setAnnounceInterval(2)).toThrow('Announce interval must be between 3 and 24 hours');
      expect(() => svc.setAnnounceInterval(25)).toThrow('Announce interval must be between 3 and 24 hours');
    });

    it('re-arms the scheduler when connected', async () => {
      const mgr = makeFakeManager({ deviceConnected: true });
      const svc = new AutoAnnounceService(mgr as any);

      svc.setAnnounceInterval(6);
      // startAnnounceScheduler() is fired-and-forgotten (not awaited internally);
      // flush its microtasks.
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();

      expect(svc.running).toBe(true);
    });

    it('does not arm when not connected', async () => {
      const mgr = makeFakeManager({ deviceConnected: false });
      const svc = new AutoAnnounceService(mgr as any);

      svc.setAnnounceInterval(6);
      await Promise.resolve();

      expect(svc.running).toBe(false);
    });
  });

  describe('restartAnnounceScheduler', () => {
    it('re-arms the scheduler when connected', async () => {
      const mgr = makeFakeManager({ deviceConnected: true });
      const svc = new AutoAnnounceService(mgr as any);

      svc.restartAnnounceScheduler();
      // restartAnnounceScheduler() fires startAnnounceScheduler() without
      // awaiting it; flush its microtask chain (several sequential awaited
      // DB reads) before asserting.
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();

      expect(svc.running).toBe(true);
    });

    it('does not arm when not connected', async () => {
      const mgr = makeFakeManager({ deviceConnected: false });
      const svc = new AutoAnnounceService(mgr as any);

      svc.restartAnnounceScheduler();
      await Promise.resolve();

      expect(svc.running).toBe(false);
    });
  });

  // ── stop() ────────────────────────────────────────────────────────────

  describe('stop', () => {
    it('is a no-op when never started', () => {
      const mgr = makeFakeManager();
      const svc = new AutoAnnounceService(mgr as any);

      expect(() => svc.stop()).not.toThrow();
      expect(svc.running).toBe(false);
    });

    it('disarms an active scheduler and is idempotent', async () => {
      const mgr = makeFakeManager();
      const svc = new AutoAnnounceService(mgr as any);

      await svc.startAnnounceScheduler();
      expect(svc.running).toBe(true);

      svc.stop();
      expect(svc.running).toBe(false);

      // Second stop() must not throw.
      expect(() => svc.stop()).not.toThrow();

      // No orphaned timer: advancing well past the interval fires nothing.
      const sendSpy = vi.spyOn(svc, 'sendAutoAnnouncement').mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(sendSpy).not.toHaveBeenCalled();
    });
  });

  // ── sendAutoAnnouncement ──────────────────────────────────────────────

  describe('sendAutoAnnouncement', () => {
    it('skips entirely while a reboot merge is in progress', async () => {
      const mgr = makeFakeManager({ rebootMergeInProgress: true });
      const svc = new AutoAnnounceService(mgr as any);

      await svc.sendAutoAnnouncement(true);

      expect(mgr.replaceAnnouncementTokens).not.toHaveBeenCalled();
      expect(mgr.messageQueue.enqueue).not.toHaveBeenCalled();
    });

    it('skips automation-triggered sends when airtime-gated', async () => {
      const mgr = makeFakeManager({ automationAirtimeGated: true });
      const svc = new AutoAnnounceService(mgr as any);

      await svc.sendAutoAnnouncement(true);

      expect(mgr.messageQueue.enqueue).not.toHaveBeenCalled();
    });

    it('manual sends (triggeredByAutomation=false) bypass the airtime gate', async () => {
      const mgr = makeFakeManager({ automationAirtimeGated: true });
      const svc = new AutoAnnounceService(mgr as any);

      await svc.sendAutoAnnouncement(false);

      expect(mgr.messageQueue.enqueue).toHaveBeenCalledTimes(1);
    });

    it('expands tokens via mgr.replaceAnnouncementTokens and enqueues once per configured channel', async () => {
      stubSettings({ autoAnnounceChannelIndexes: '[0,2]' });
      const mgr = makeFakeManager();
      const svc = new AutoAnnounceService(mgr as any);

      await svc.sendAutoAnnouncement(true);

      expect(mgr.replaceAnnouncementTokens).toHaveBeenCalledWith('MeshMonitor {VERSION} online');
      expect(mgr.messageQueue.enqueue).toHaveBeenCalledTimes(2);
      const [msg0, dest0, , , , chan0] = (mgr.messageQueue.enqueue as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(msg0).toBe('MeshMonitor 9.9.9 online');
      expect(dest0).toBe(0);
      expect(chan0).toBe(0);
      const chan1 = (mgr.messageQueue.enqueue as ReturnType<typeof vi.fn>).mock.calls[1][5];
      expect(chan1).toBe(2);
    });

    it('falls back to the legacy single channel index when autoAnnounceChannelIndexes is unset', async () => {
      stubSettings({ autoAnnounceChannelIndexes: null });
      mockGetSetting.mockResolvedValue('3'); // legacy global autoAnnounceChannelIndex
      const mgr = makeFakeManager();
      const svc = new AutoAnnounceService(mgr as any);

      await svc.sendAutoAnnouncement(true);

      expect(mgr.messageQueue.enqueue).toHaveBeenCalledTimes(1);
      const chan = (mgr.messageQueue.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][5];
      expect(chan).toBe(3);
    });

    it('updates lastAnnouncementTime via setSourceSetting for a per-source manager', async () => {
      const mgr = makeFakeManager({ sourceId: 'src-1' });
      const svc = new AutoAnnounceService(mgr as any);

      await svc.sendAutoAnnouncement(true);

      expect(mockSetSourceSetting).toHaveBeenCalledWith('src-1', 'lastAnnouncementTime', expect.any(String));
    });

    it('broadcasts NodeInfo to configured channels when enabled', async () => {
      stubSettings({
        autoAnnounceNodeInfoEnabled: 'true',
        autoAnnounceNodeInfoChannels: '[1,2]',
        autoAnnounceNodeInfoDelaySeconds: '15',
      });
      const mgr = makeFakeManager();
      const svc = new AutoAnnounceService(mgr as any);

      await svc.sendAutoAnnouncement(true);

      expect(mgr.broadcastNodeInfoToChannels).toHaveBeenCalledWith([1, 2], 15);
    });

    it('does not broadcast NodeInfo when disabled', async () => {
      const mgr = makeFakeManager();
      const svc = new AutoAnnounceService(mgr as any);

      await svc.sendAutoAnnouncement(true);

      expect(mgr.broadcastNodeInfoToChannels).not.toHaveBeenCalled();
    });
  });

  // ── previewAnnouncementMessage ────────────────────────────────────────

  describe('previewAnnouncementMessage', () => {
    it('delegates to mgr.replaceAnnouncementTokens and returns its result', async () => {
      const mgr = makeFakeManager();
      const svc = new AutoAnnounceService(mgr as any);

      const result = await svc.previewAnnouncementMessage('Version: {VERSION}');

      expect(mgr.replaceAnnouncementTokens).toHaveBeenCalledWith('Version: {VERSION}');
      expect(result).toBe('Version: 9.9.9');
    });
  });
});
