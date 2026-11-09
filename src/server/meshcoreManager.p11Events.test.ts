/**
 * P11 S6/S7: MeshCore server connection events and trace notifications.
 * No radio: the bridge and the notification services are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connected: vi.fn().mockResolvedValue(undefined),
  disconnected: vi.fn().mockResolvedValue(undefined),
  trace: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./services/serverEventNotificationService.js', () => ({
  serverEventNotificationService: {
    notifyNodeConnected: mocks.connected,
    notifyNodeDisconnected: mocks.disconnected,
    notifyOwnKeyChanged: vi.fn(),
  },
}));
vi.mock('./services/notificationService.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, notificationService: { ...(actual.notificationService as object), notifyTraceroute: mocks.trace } };
});

import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';

const PK = 'a3' + 'f'.repeat(62);

function make(opts: { response?: any } = {}) {
  const m = new MeshCoreManager('src1', 'Hill');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).connectionState = 'connected';
  (m as any).localNode = { name: 'Local' };
  (m as any).contacts = new Map([[PK, { publicKey: PK, name: 'Repeater One', outPath: '11,22', pathLen: 2 }]]);
  (m as any).sendBridgeCommand = async () => ({ id: '1', ...(opts.response ?? { success: true, data: { pathSnrs: [40, 24], lastSnr: 7 } }) });
  (m as any).requireTransmit = () => undefined;
  return m;
}

beforeEach(() => Object.values(mocks).forEach((f) => f.mockClear()));
afterEach(() => vi.restoreAllMocks());

describe('server events', () => {
  it('a native drop with auto-reconnect off notifies once', async () => {
    const m = make();
    (m as any).stopObserver = async () => undefined;
    (m as any).stopVirtualNodeServer = async () => undefined;
    await (m as any).handleUnexpectedDisconnect();
    expect(mocks.disconnected).toHaveBeenCalledTimes(1);
    expect(mocks.disconnected).toHaveBeenCalledWith('src1', 'Hill');
  });

  it('heartbeat threshold plus the native drop gives one disconnect', async () => {
    const m = make();
    (m as any).shouldReconnect = true;
    (m as any).teardownTransportOnly = async () => undefined;
    (m as any).scheduleNextReconnect = () => undefined;
    (m as any).recordHeartbeatFailure(new Error('x'));
    (m as any).recordHeartbeatFailure(new Error('x'));
    (m as any).recordHeartbeatFailure(new Error('x'));
    await (m as any).handleUnexpectedDisconnect(); // already reconnecting: guarded
    expect(mocks.disconnected).toHaveBeenCalledTimes(1);
  });

  it('a drop with auto-reconnect on notifies through beginReconnect', async () => {
    const m = make();
    (m as any).shouldReconnect = true;
    (m as any).teardownTransportOnly = async () => undefined;
    (m as any).scheduleNextReconnect = () => undefined;
    await (m as any).handleUnexpectedDisconnect();
    expect(mocks.disconnected).toHaveBeenCalledTimes(1);
  });

  it('disconnect() without the flag is silent; the route flag notifies', async () => {
    const quiet = make();
    await quiet.disconnect();
    expect(mocks.disconnected).not.toHaveBeenCalled();
    const loud = make();
    await loud.disconnect({ userInitiated: true });
    expect(mocks.disconnected).toHaveBeenCalledTimes(1);
  });

  it('a notification failure never throws', async () => {
    mocks.disconnected.mockRejectedValueOnce(new Error('boom'));
    const m = make();
    await expect(m.disconnect({ userInitiated: true })).resolves.toBeUndefined();
  });
});

describe('trace notifications', () => {
  it('trace success notifies once with names and hop SNR', async () => {
    const m = make();
    const out = await m.traceContactPathDetailed(PK);
    expect(out.ok).toBe(true);
    expect(mocks.trace).toHaveBeenCalledTimes(1);
    const [from, to, text, sid, sname] = mocks.trace.mock.calls[0];
    expect([from, to, sid, sname]).toEqual(['Local', 'Repeater One', 'src1', 'Hill']);
    expect(text).toContain('last hop 7 dB');
  });

  it('a throwing notifier does not break the trace', async () => {
    mocks.trace.mockImplementationOnce(() => { throw new Error('x'); });
    const out = await make().traceContactPathDetailed(PK);
    expect(out.ok).toBe(true);
  });

  it('timeout and failure do not notify', async () => {
    await make({ response: { success: false, data: { timed_out: true, wait_ms: 1, suggested_timeout_ms: 1 } } }).traceContactPathDetailed(PK);
    await make({ response: { success: false, error: 'no' } }).traceContactPathDetailed(PK);
    expect(mocks.trace).not.toHaveBeenCalled();
  });

  it('zero-hop ping does not notify', async () => {
    const m = make({ response: { success: false, data: { timed_out: true } } });
    await m.pingContactZeroHop(PK);
    expect(mocks.trace).not.toHaveBeenCalled();
  });

  it('a path-discovery response notifies once', () => {
    const m = make();
    (m as any).persistContact = async () => undefined;
    (m as any).handleBridgeEvent({ event_type: 'path_discovery_response', data: {
      pubkey_prefix: PK.slice(0, 12), out_path_len: 2, out_path_hex: 'a37f', out_hash_size: 1, in_path_len: 1, in_path_hex: 'a3',
    } });
    expect(mocks.trace).toHaveBeenCalledTimes(1);
    expect(mocks.trace.mock.calls[0][2]).toBe('Path discovered: out 2 hops [a3,7f], in 1 hop');
  });
});
