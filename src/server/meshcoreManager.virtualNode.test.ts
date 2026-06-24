/**
 * Regression test for the MeshCore reconnect teardown path (PR #3706, issue #3705).
 *
 * When the real node connection drops, `beginReconnect()` calls
 * `teardownTransportOnly()` to tear down the live transport while preserving
 * reconnect intent. Previously this left the Virtual Node server running, so the
 * VN server kept accepting MeshCore mobile-app connections while
 * `isConnected()` was false — every AppStart got BadState and the app looped in
 * "Connecting". The fix stops the Virtual Node server at the top of
 * `teardownTransportOnly()`, mirroring `disconnect()`. The server restarts in
 * `connect()` once the real node is back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeshCoreManager } from './meshcoreManager.js';

describe('MeshCoreManager.teardownTransportOnly() — Virtual Node teardown', () => {
  let manager: MeshCoreManager;

  beforeEach(() => {
    manager = new MeshCoreManager('test-source');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stops the Virtual Node server when tearing down the transport for reconnect', async () => {
    const stopVnSpy = vi
      .spyOn(manager as any, 'stopVirtualNodeServer')
      .mockResolvedValue(undefined);

    await (manager as any).teardownTransportOnly();

    expect(stopVnSpy).toHaveBeenCalledTimes(1);
  });

  it('tears down the native backend after stopping the Virtual Node server', async () => {
    const stopVnSpy = vi
      .spyOn(manager as any, 'stopVirtualNodeServer')
      .mockResolvedValue(undefined);

    const backendDisconnect = vi.fn().mockResolvedValue(undefined);
    (manager as any).nativeBackend = { disconnect: backendDisconnect };

    await (manager as any).teardownTransportOnly();

    expect(stopVnSpy).toHaveBeenCalledTimes(1);
    expect(backendDisconnect).toHaveBeenCalledTimes(1);
    // VN server must be stopped before the transport goes away — the VN server
    // reads connection state to answer AppStart.
    expect(stopVnSpy.mock.invocationCallOrder[0]).toBeLessThan(
      backendDisconnect.mock.invocationCallOrder[0],
    );
    // Transport is torn down but reconnect intent (localNode/contacts cache) is
    // preserved for the next connect().
    expect((manager as any).connected).toBe(false);
    expect((manager as any).nativeBackend).toBeNull();
  });

  it('delegates to the Virtual Node server stop() through stopVirtualNodeServer()', async () => {
    const vnStop = vi.fn().mockResolvedValue(undefined);
    (manager as any).virtualNodeServer = { stop: vnStop, isRunning: () => true };

    await (manager as any).teardownTransportOnly();

    expect(vnStop).toHaveBeenCalledTimes(1);
    expect((manager as any).virtualNodeServer).toBeNull();
  });
});
