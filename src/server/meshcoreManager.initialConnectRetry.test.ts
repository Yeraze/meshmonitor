/**
 * Regression tests for retrying a failed *initial* MeshCore connect() attempt
 * (#3918). Before this fix, a failed auto-connect-on-startup attempt (or any
 * other connect() call — manual "Connect" click, source create/enable) was
 * terminal: the manager logged a warning and left the source disconnected
 * until a manual Connect click, even though "Automatically connect on
 * startup" was enabled. Unlike Meshtastic TCP sources — whose transport
 * retries forever with backoff regardless of heartbeat config — MeshCore's
 * only retry machinery (scheduleNextReconnect/attemptReconnect) previously
 * fired solely for a drop *after* a successful connect, and only when the
 * opt-in heartbeat feature was configured.
 *
 * connect() now arms `shouldReconnect` and calls scheduleNextReconnect() on
 * a failed first attempt too, and resets `shouldReconnect` back to false on
 * a successful connect so the heartbeat feature's own gating for post-connect
 * drops is unaffected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeshCoreManager, ConnectionType, type MeshCoreConfig } from './meshcoreManager.js';
import { logger } from '../utils/logger.js';
import databaseService from '../services/database.js';

const TEST_CONFIG: MeshCoreConfig = {
  connectionType: ConnectionType.SERIAL,
  firmwareType: 'companion',
  serialPort: '/dev/ttyTEST',
};

describe('MeshCoreManager.connect() initial-failure retry', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(databaseService.meshcore, 'getRecentMessages').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('arms shouldReconnect and schedules a retry when the first attempt fails', async () => {
    const m = new MeshCoreManager('test-source');
    (m as any).startNativeBackend = vi.fn().mockRejectedValue(new Error('port busy'));
    (m as any).disconnect = vi.fn().mockResolvedValue(undefined);
    const scheduleSpy = vi.spyOn(m as any, 'scheduleNextReconnect').mockReturnValue(undefined);

    const ok = await m.connect(TEST_CONFIG);

    expect(ok).toBe(false);
    expect((m as any).shouldReconnect).toBe(true);
    expect((m as any).connectionState).toBe('reconnecting');
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
  });

  it('resets shouldReconnect to false once a connect attempt succeeds without heartbeat configured', async () => {
    const m = new MeshCoreManager('test-source');
    // Pretend a prior failed attempt already armed the retry flag.
    (m as any).shouldReconnect = true;
    (m as any).startNativeBackend = vi.fn().mockResolvedValue(undefined);
    (m as any).refreshLocalNode = vi.fn().mockResolvedValue(undefined);
    (m as any).seedContactsFromDb = vi.fn().mockResolvedValue(undefined);
    (m as any).refreshContacts = vi.fn().mockResolvedValue(undefined);
    (m as any).refreshKnownScopes = vi.fn().mockResolvedValue(undefined);
    (m as any).startVirtualNodeServer = vi.fn().mockResolvedValue(undefined);
    (m as any).startAutoPathfinding = vi.fn().mockResolvedValue(undefined);
    (m as any).startAutoAnnounce = vi.fn().mockResolvedValue(undefined);
    (m as any).startTimerTriggers = vi.fn().mockResolvedValue(undefined);

    const ok = await m.connect(TEST_CONFIG);

    expect(ok).toBe(true);
    expect((m as any).shouldReconnect).toBe(false);
  });

  it('retries the eventual reconnect attempt via attemptReconnect once scheduled', async () => {
    const m = new MeshCoreManager('test-source');
    let attempts = 0;
    (m as any).startNativeBackend = vi.fn().mockImplementation(() => {
      attempts += 1;
      return attempts < 2 ? Promise.reject(new Error('not ready yet')) : Promise.resolve(undefined);
    });
    (m as any).refreshLocalNode = vi.fn().mockResolvedValue(undefined);
    (m as any).seedContactsFromDb = vi.fn().mockResolvedValue(undefined);
    (m as any).refreshContacts = vi.fn().mockResolvedValue(undefined);
    (m as any).refreshKnownScopes = vi.fn().mockResolvedValue(undefined);
    (m as any).startVirtualNodeServer = vi.fn().mockResolvedValue(undefined);
    (m as any).startAutoPathfinding = vi.fn().mockResolvedValue(undefined);
    (m as any).startAutoAnnounce = vi.fn().mockResolvedValue(undefined);
    (m as any).startTimerTriggers = vi.fn().mockResolvedValue(undefined);
    // Skip the real backoff delay — assert the scheduling call happened and
    // drive the retry manually via attemptReconnect().
    const scheduleSpy = vi.spyOn(m as any, 'scheduleNextReconnect').mockReturnValue(undefined);

    const firstAttempt = await m.connect(TEST_CONFIG);
    expect(firstAttempt).toBe(false);
    expect(scheduleSpy).toHaveBeenCalledTimes(1);

    const secondAttempt = await (m as any).attemptReconnect();
    void secondAttempt;

    expect((m as any).connected).toBe(true);
    expect((m as any).shouldReconnect).toBe(false);
  });
});
