/**
 * Regression tests for MeshCore unexpected socket-drop handling (issue #3705
 * follow-up). Before this, the manager only logged when the native backend's
 * meshcore.js connection reported a socket/serial-level 'disconnected': it left
 * `connected = true`, so isConnected() kept returning true, the Virtual Node
 * server answered AppStart with a stale SelfInfo, and — with auto-reconnect
 * disabled (the default) — nothing recovered.
 *
 * `handleUnexpectedDisconnect()` now reflects reality (or hands off to the
 * reconnect machinery), while ignoring drops that come from our own intentional
 * teardown or that land after a teardown is already in flight.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeshCoreManager } from './meshcoreManager.js';

describe('MeshCoreManager.handleUnexpectedDisconnect()', () => {
  let manager: MeshCoreManager;

  beforeEach(() => {
    manager = new MeshCoreManager('test-source');
    // Simulate a live connection.
    (manager as any).connected = true;
    (manager as any).connectionState = 'connected';
    (manager as any).intentionalTeardown = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops to disconnected and stops the VN server when auto-reconnect is off', async () => {
    const stopVnSpy = vi.spyOn(manager as any, 'stopVirtualNodeServer').mockResolvedValue(undefined);
    const emitSpy = vi.spyOn(manager, 'emit');
    (manager as any).shouldReconnect = false;

    await (manager as any).handleUnexpectedDisconnect();

    expect((manager as any).connected).toBe(false);
    expect((manager as any).connectionState).toBe('disconnected');
    expect(stopVnSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith('disconnected');
  });

  it('releases the dead native backend so later sends get a clean disconnected error', async () => {
    vi.spyOn(manager as any, 'stopVirtualNodeServer').mockResolvedValue(undefined);
    const backendDisconnect = vi.fn().mockResolvedValue(undefined);
    (manager as any).nativeBackend = { disconnect: backendDisconnect };
    (manager as any).shouldReconnect = false;

    await (manager as any).handleUnexpectedDisconnect();

    expect(backendDisconnect).toHaveBeenCalledTimes(1);
    expect((manager as any).nativeBackend).toBeNull();
  });

  it('hands off to the reconnect machinery when auto-reconnect is enabled', async () => {
    const beginReconnectSpy = vi.spyOn(manager as any, 'beginReconnect').mockReturnValue(undefined);
    const stopVnSpy = vi.spyOn(manager as any, 'stopVirtualNodeServer').mockResolvedValue(undefined);
    (manager as any).shouldReconnect = true;

    await (manager as any).handleUnexpectedDisconnect();

    expect(beginReconnectSpy).toHaveBeenCalledTimes(1);
    // The reconnect path owns the teardown; the no-reconnect branch must not run.
    expect(stopVnSpy).not.toHaveBeenCalled();
  });

  it('ignores the drop when an intentional teardown is in progress', async () => {
    const stopVnSpy = vi.spyOn(manager as any, 'stopVirtualNodeServer').mockResolvedValue(undefined);
    const beginReconnectSpy = vi.spyOn(manager as any, 'beginReconnect').mockReturnValue(undefined);
    (manager as any).intentionalTeardown = true;
    (manager as any).shouldReconnect = false;

    await (manager as any).handleUnexpectedDisconnect();

    expect(stopVnSpy).not.toHaveBeenCalled();
    expect(beginReconnectSpy).not.toHaveBeenCalled();
    // State untouched — disconnect()/teardownTransportOnly() own it.
    expect((manager as any).connected).toBe(true);
  });

  it('is a no-op when not in the connected state (teardown already in flight)', async () => {
    const stopVnSpy = vi.spyOn(manager as any, 'stopVirtualNodeServer').mockResolvedValue(undefined);
    const beginReconnectSpy = vi.spyOn(manager as any, 'beginReconnect').mockReturnValue(undefined);
    (manager as any).connectionState = 'reconnecting';

    await (manager as any).handleUnexpectedDisconnect();

    expect(stopVnSpy).not.toHaveBeenCalled();
    expect(beginReconnectSpy).not.toHaveBeenCalled();
  });

  it('disconnect() sets the intentionalTeardown guard so the backend close event is ignored', async () => {
    expect((manager as any).intentionalTeardown).toBe(false);
    await manager.disconnect();
    expect((manager as any).intentionalTeardown).toBe(true);
  });
});
