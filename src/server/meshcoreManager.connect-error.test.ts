/**
 * Regression test for the MeshCoreManager.connect() catch handler.
 *
 * The underlying meshcore.js library rejects some promises with `undefined`
 * (no Error object). Before this fix, the catch logged
 * `Connection failed: undefined`, which masked every real cause from user
 * reports (discussion #2604). The handler now surfaces a meaningful detail
 * string for the empty-rejection case so the next log carries actionable
 * info, while preserving stack/message for genuine Error rejections.
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

function makeConfiguredManager(rejectWith: unknown): MeshCoreManager {
  const m = new MeshCoreManager('test-source');
  // Stub startNativeBackend so the catch handler is the only path under
  // test — we don't need to spin up meshcore.js or touch any hardware.
  (m as any).startNativeBackend = vi.fn().mockRejectedValue(rejectWith);
  // disconnect() is awaited in the catch; stub it so we don't touch real state.
  (m as any).disconnect = vi.fn().mockResolvedValue(undefined);
  // The catch handler now schedules a retry (#3918); stub it out here so
  // these log-message tests don't leak a real setTimeout that would keep
  // retrying (and rejecting) after the test finishes.
  (m as any).scheduleNextReconnect = vi.fn();
  return m;
}

describe('MeshCoreManager.connect() catch handler', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    // connect() pre-seeds messages from DB; stub so the test doesn't need a real DB.
    vi.spyOn(databaseService.meshcore, 'getRecentMessages').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function getConnectionFailedLog(): string {
    const call = errSpy.mock.calls.find(
      args => typeof args[0] === 'string' && args[0].includes('[MeshCore] Connection failed:'),
    );
    expect(call, 'expected a "[MeshCore] Connection failed:" log line').toBeDefined();
    return String(call![0]);
  }

  it('logs a sentinel message when the library rejects with undefined', async () => {
    const m = makeConfiguredManager(undefined);
    const ok = await m.connect(TEST_CONFIG);
    expect(ok).toBe(false);
    const msg = getConnectionFailedLog();
    expect(msg).not.toMatch(/undefined$/);
    expect(msg).toContain('rejected without an Error');
  });

  it('logs a sentinel message when the library rejects with null', async () => {
    const m = makeConfiguredManager(null);
    const ok = await m.connect(TEST_CONFIG);
    expect(ok).toBe(false);
    const msg = getConnectionFailedLog();
    expect(msg).toContain('rejected without an Error');
  });

  it('uses stack/message when the rejection is an Error', async () => {
    const m = makeConfiguredManager(new Error('port busy'));
    const ok = await m.connect(TEST_CONFIG);
    expect(ok).toBe(false);
    const msg = getConnectionFailedLog();
    expect(msg).toContain('port busy');
  });

  it('stringifies plain non-Error non-empty rejections', async () => {
    const m = makeConfiguredManager('ETIMEDOUT');
    const ok = await m.connect(TEST_CONFIG);
    expect(ok).toBe(false);
    const msg = getConnectionFailedLog();
    expect(msg).toContain('ETIMEDOUT');
    expect(msg).not.toContain('rejected without an Error');
  });
});
