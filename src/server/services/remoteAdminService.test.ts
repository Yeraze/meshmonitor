/**
 * Tests for remote-admin fetch flows + module-config bookkeeping (#3962
 * Phase 4.2a PR5 §4e, optional split half — see `deviceAdminService.test.ts`
 * for the sibling file and the split rationale).
 *
 * `RemoteAdminService` is tested against a minimal fake manager implementing
 * only the narrow public surface it depends on. The map-bridging accessors
 * (`getRemoteNodeConfig`, `getRemoteNodeChannelsMap`, `getRemoteNodeOwnersMap`,
 * `getRemoteNodeDeviceMetadataMap`) return the SAME live object/Map the fake
 * holds — mirroring the real manager's accessors, which is the hazard this
 * split documents (see the header comment in `remoteAdminService.ts`): tests
 * mutate the fake's backing map directly to simulate `processAdminMessage`
 * (protobuf dispatch, not under test here) delivering a response, exactly
 * like the real inbound dispatch path would.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createAdminPacket = vi.fn((...args: unknown[]) => args[0] as Uint8Array);
const createGetModuleConfigRequest = vi.fn((..._args: unknown[]) => new Uint8Array([1]));

vi.mock('../protobufService.js', () => ({
  default: {
    createAdminPacket: (...args: unknown[]) => createAdminPacket(...args),
    createGetModuleConfigRequest: (...args: unknown[]) => createGetModuleConfigRequest(...args),
  },
}));

const AdminMessageMock = {
  create: vi.fn((data: any) => data),
  encode: vi.fn((msg: any) => ({ finish: () => new Uint8Array([9, msg ? 1 : 0]) })),
};
const rootMock = { lookupType: vi.fn(() => AdminMessageMock) };
const getProtobufRootMock = vi.fn((..._args: unknown[]) => rootMock);

vi.mock('../protobufLoader.js', () => ({
  getProtobufRoot: (...args: unknown[]) => getProtobufRootMock(...args),
}));

const getEnvironmentConfigMock = vi.fn((..._args: unknown[]) => ({ meshtasticModuleConfigDelayMs: 0 }));
vi.mock('../config/environment.js', () => ({
  getEnvironmentConfig: (...args: unknown[]) => getEnvironmentConfigMock(...args),
}));

import { RemoteAdminService } from './remoteAdminService.js';

const LOCAL_NODE_NUM = 111;

/** Minimal fake implementing only what RemoteAdminService touches on the manager. */
function makeFakeManager(overrides: Partial<{
  transportReady: boolean;
  localNodeInfo: { nodeNum: number } | null;
  sessionPasskeys: Map<number, Uint8Array>;
}> = {}) {
  const state = {
    transportReady: overrides.transportReady ?? true,
    localNodeInfo: overrides.localNodeInfo === undefined ? { nodeNum: LOCAL_NODE_NUM } : overrides.localNodeInfo,
    sessionPasskeys: overrides.sessionPasskeys ?? new Map<number, Uint8Array>(),
    remoteNodeConfigs: new Map<number, { deviceConfig: any; moduleConfig: any; lastUpdated: number }>(),
    remoteNodeChannels: new Map<number, Map<number, any>>(),
    remoteNodeOwners: new Map<number, any>(),
    remoteNodeDeviceMetadata: new Map<number, any>(),
    pendingModuleConfigRequests: new Map<number, string>(),
    moduleConfigsEverFetched: false,
  };

  return {
    state,
    isTransportReady: vi.fn(() => state.transportReady),
    getLocalNodeInfo: vi.fn(() => state.localNodeInfo),
    sendLocalAdminPacket: vi.fn().mockResolvedValue(undefined),
    getSessionPasskey: vi.fn((nodeNum: number) => state.sessionPasskeys.get(nodeNum) ?? null),
    requestRemoteSessionPasskeyStub: vi.fn(), // unused directly; RemoteAdminService calls its own method
    getRemoteNodeConfig: vi.fn((nodeNum: number) => state.remoteNodeConfigs.get(nodeNum) ?? null),
    setPendingModuleConfigRequest: vi.fn((nodeNum: number, key: string) => state.pendingModuleConfigRequests.set(nodeNum, key)),
    getRemoteNodeChannelsMap: vi.fn((nodeNum: number) => state.remoteNodeChannels.get(nodeNum)),
    getRemoteNodeOwnersMap: vi.fn(() => state.remoteNodeOwners),
    getRemoteNodeDeviceMetadataMap: vi.fn(() => state.remoteNodeDeviceMetadata),
    resetModuleConfigState: vi.fn(() => { state.moduleConfigsEverFetched = false; }),
    setModuleConfigsEverFetched: vi.fn((v: boolean) => { state.moduleConfigsEverFetched = v; }),
  };
}

describe('RemoteAdminService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEnvironmentConfigMock.mockReturnValue({ meshtasticModuleConfigDelayMs: 0 });
  });

  describe('requestRemoteSessionPasskey', () => {
    it('throws when transport is not ready', async () => {
      const mgr = makeFakeManager({ transportReady: false });
      const svc = new RemoteAdminService(mgr as any);
      await expect(svc.requestRemoteSessionPasskey(222)).rejects.toThrow('Not connected to Meshtastic node');
    });

    it('sends a getDeviceMetadataRequest and resolves once the passkey appears', async () => {
      vi.useFakeTimers();
      try {
        const mgr = makeFakeManager();
        const svc = new RemoteAdminService(mgr as any);

        const promise = svc.requestRemoteSessionPasskey(222);
        // First poll tick — seed the passkey right before it, simulating the
        // response arriving via the (out-of-scope) dispatch path.
        await vi.advanceTimersByTimeAsync(1); // let the send/await settle
        mgr.state.sessionPasskeys.set(222, new Uint8Array([7, 7]));
        await vi.advanceTimersByTimeAsync(500);

        const result = await promise;
        expect(result).toEqual(new Uint8Array([7, 7]));
        expect(mgr.sendLocalAdminPacket).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('requestModuleConfig (local)', () => {
    it('tracks the pending key for the local node and sends the request', async () => {
      const mgr = makeFakeManager();
      const svc = new RemoteAdminService(mgr as any);
      await svc.requestModuleConfig(14); // TRAFFICMANAGEMENT_CONFIG
      expect(mgr.setPendingModuleConfigRequest).toHaveBeenCalledWith(LOCAL_NODE_NUM, 'trafficManagement');
      expect(mgr.sendLocalAdminPacket).toHaveBeenCalledTimes(1);
    });
  });

  describe('requestRemoteConfig', () => {
    it('uses a cached session passkey, clears the stale section, and polls until the response lands', async () => {
      vi.useFakeTimers();
      try {
        const mgr = makeFakeManager({ sessionPasskeys: new Map([[222, new Uint8Array([1])]]) });
        // Pre-seed a stale value so the "clear before request" step has something to delete.
        mgr.state.remoteNodeConfigs.set(222, { deviceConfig: { lora: { stale: true } }, moduleConfig: {}, lastUpdated: 0 });
        const svc = new RemoteAdminService(mgr as any);

        const promise = svc.requestRemoteConfig(222, 5 /* LORA_CONFIG */, false);
        await vi.advanceTimersByTimeAsync(1);
        // The stale 'lora' key was deleted by the clear-before-request step.
        expect(mgr.state.remoteNodeConfigs.get(222)?.deviceConfig.lora).toBeUndefined();

        // Simulate the response arriving (out-of-scope dispatch path writing the map).
        mgr.state.remoteNodeConfigs.get(222)!.deviceConfig.lora = { region: 1 };
        await vi.advanceTimersByTimeAsync(250);

        const result = await promise;
        expect(result).toEqual({ region: 1 });
        // Cached passkey used — no extra session-passkey request round trip.
        expect(mgr.sendLocalAdminPacket).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('tracks the pending module-config key for remote module requests', async () => {
      vi.useFakeTimers();
      try {
        const mgr = makeFakeManager({ sessionPasskeys: new Map([[222, new Uint8Array([1])]]) });
        const svc = new RemoteAdminService(mgr as any);
        const promise = svc.requestRemoteConfig(222, 5 /* TELEMETRY_CONFIG module */, true);
        await vi.advanceTimersByTimeAsync(1);
        expect(mgr.setPendingModuleConfigRequest).toHaveBeenCalledWith(222, 'telemetry');
        // Let it time out quickly to finish the test — not the behavior under test.
        await vi.advanceTimersByTimeAsync(20000);
        await promise;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('requestRemoteChannel / requestRemoteOwner / requestRemoteDeviceMetadata', () => {
    it('requestRemoteChannel clears the stale channel entry before requesting', async () => {
      vi.useFakeTimers();
      try {
        const mgr = makeFakeManager({ sessionPasskeys: new Map([[222, new Uint8Array([1])]]) });
        const nodeChannels = new Map<number, any>([[3, { settings: { name: 'stale' } }]]);
        mgr.state.remoteNodeChannels.set(222, nodeChannels);
        const svc = new RemoteAdminService(mgr as any);

        const promise = svc.requestRemoteChannel(222, 3);
        await vi.advanceTimersByTimeAsync(1);
        expect(nodeChannels.has(3)).toBe(false);

        nodeChannels.set(3, { settings: { name: 'fresh' }, role: 1 });
        await vi.advanceTimersByTimeAsync(300);
        const result = await promise;
        expect(result).toEqual({ settings: { name: 'fresh' }, role: 1 });
      } finally {
        vi.useRealTimers();
      }
    });

    it('requestRemoteOwner deletes the stale owner entry then polls the live map', async () => {
      vi.useFakeTimers();
      try {
        const mgr = makeFakeManager({ sessionPasskeys: new Map([[222, new Uint8Array([1])]]) });
        mgr.state.remoteNodeOwners.set(222, { longName: 'stale' });
        const svc = new RemoteAdminService(mgr as any);

        const promise = svc.requestRemoteOwner(222);
        await vi.advanceTimersByTimeAsync(1);
        expect(mgr.state.remoteNodeOwners.has(222)).toBe(false);

        mgr.state.remoteNodeOwners.set(222, { longName: 'fresh' });
        await vi.advanceTimersByTimeAsync(250);
        const result = await promise;
        expect(result).toEqual({ longName: 'fresh' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('requestRemoteDeviceMetadata deletes the stale metadata entry then polls the live map', async () => {
      vi.useFakeTimers();
      try {
        const mgr = makeFakeManager({ sessionPasskeys: new Map([[222, new Uint8Array([1])]]) });
        mgr.state.remoteNodeDeviceMetadata.set(222, { firmwareVersion: 'stale' });
        const svc = new RemoteAdminService(mgr as any);

        const promise = svc.requestRemoteDeviceMetadata(222);
        await vi.advanceTimersByTimeAsync(1);
        expect(mgr.state.remoteNodeDeviceMetadata.has(222)).toBe(false);

        mgr.state.remoteNodeDeviceMetadata.set(222, { firmwareVersion: '2.7.24' });
        await vi.advanceTimersByTimeAsync(250);
        const result = await promise;
        expect(result).toEqual({ firmwareVersion: '2.7.24' });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('sendRebootCommand / sendSetTimeCommand — local vs remote passkey handling', () => {
    it('sendRebootCommand to the local node does not request a session passkey', async () => {
      const mgr = makeFakeManager();
      const svc = new RemoteAdminService(mgr as any);
      await svc.sendRebootCommand(LOCAL_NODE_NUM, 5);
      expect(mgr.sendLocalAdminPacket).toHaveBeenCalledTimes(1);
      expect(mgr.getSessionPasskey).not.toHaveBeenCalled();
    });

    it('sendRebootCommand to a remote node without a cached passkey requests one first', async () => {
      vi.useFakeTimers();
      try {
        const mgr = makeFakeManager();
        const svc = new RemoteAdminService(mgr as any);
        const promise = svc.sendRebootCommand(222, 5);
        await vi.advanceTimersByTimeAsync(1);
        mgr.state.sessionPasskeys.set(222, new Uint8Array([7]));
        await vi.advanceTimersByTimeAsync(500);
        await promise;
        // One send for the passkey request, one for the reboot command itself.
        expect(mgr.sendLocalAdminPacket).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('sendSetTimeCommand to the local node does not request a session passkey', async () => {
      const mgr = makeFakeManager();
      const svc = new RemoteAdminService(mgr as any);
      await svc.sendSetTimeCommand(0); // destinationNodeNum 0 == local
      expect(mgr.sendLocalAdminPacket).toHaveBeenCalledTimes(1);
      expect(mgr.getSessionPasskey).not.toHaveBeenCalled();
    });
  });

  describe('requestAllModuleConfigs / resetModuleConfigCache / refreshModuleConfigs', () => {
    it('requests every module config type in sequence', async () => {
      const mgr = makeFakeManager();
      const svc = new RemoteAdminService(mgr as any);
      await svc.requestAllModuleConfigs();
      expect(mgr.sendLocalAdminPacket).toHaveBeenCalledTimes(15); // one per ModuleConfigType
    });

    it('aborts and propagates when the connection drops mid-fetch', async () => {
      const mgr = makeFakeManager();
      const svc = new RemoteAdminService(mgr as any);
      // Flip transport-ready off after the first send.
      let calls = 0;
      mgr.isTransportReady.mockImplementation(() => (calls++ === 0));
      await expect(svc.requestAllModuleConfigs()).rejects.toThrow('Not connected to Meshtastic node');
    });

    it('resetModuleConfigCache resets state via the manager accessor', () => {
      const mgr = makeFakeManager();
      const svc = new RemoteAdminService(mgr as any);
      svc.resetModuleConfigCache();
      expect(mgr.resetModuleConfigState).toHaveBeenCalledTimes(1);
    });

    it('refreshModuleConfigs resets, re-fetches, then marks fetched-complete — in that order', async () => {
      const mgr = makeFakeManager();
      const svc = new RemoteAdminService(mgr as any);
      await svc.refreshModuleConfigs();

      expect(mgr.resetModuleConfigState).toHaveBeenCalledTimes(1);
      expect(mgr.setModuleConfigsEverFetched).toHaveBeenCalledWith(true);
      const resetOrder = (mgr.resetModuleConfigState as any).mock.invocationCallOrder[0];
      const fetchedOrder = (mgr.setModuleConfigsEverFetched as any).mock.invocationCallOrder[0];
      const firstSendOrder = (mgr.sendLocalAdminPacket as any).mock.invocationCallOrder[0];
      expect(resetOrder).toBeLessThan(firstSendOrder);
      expect(firstSendOrder).toBeLessThan(fetchedOrder);
    });
  });
});
