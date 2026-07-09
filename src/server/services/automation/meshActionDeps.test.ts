import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the unified registry so we can inject fake Meshtastic / MeshCore
// managers. Since #3962 Ph2 ALL managers (Meshtastic, MQTT, MeshCore) live in
// sourceManagerRegistry — the deps resolve every source from it.
const getManager = vi.fn();
vi.mock('../../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: (id: string) => getManager(id) },
}));
// The deps module also imports these at load time; stub to harmless objects.
vi.mock('../../../services/database.js', () => ({ default: {} }));
vi.mock('../appriseNotificationService.js', () => ({ appriseNotificationService: {} }));
vi.mock('../../utils/scriptRunner.js', () => ({ runScript: vi.fn() }));

import { createMeshActionDeps } from './meshActionDeps.js';

describe('createMeshActionDeps sendMessage — MeshCore scope (#3833)', () => {
  beforeEach(() => { getManager.mockReset(); });

  it('forwards scopeOverride to a MeshCore manager (sendMessage signature)', async () => {
    const sendMessage = vi.fn().mockResolvedValue(true);
    getManager.mockReturnValue({ sendMessage }); // MeshCore-shaped manager
    const deps = createMeshActionDeps();

    await deps.sendMessage({ sourceId: 'mc', text: 'hi', channel: 2, scopeOverride: 'paris' });

    // raw.sendMessage(text, toPublicKey=undefined, channelIdx, scopeOverride, autoRetryOnMiss)
    // The Automation Engine is an automated sender, so it opts into the
    // channel-send auto-retry (#3979) with the trailing `true`.
    expect(sendMessage).toHaveBeenCalledWith('hi', undefined, 2, 'paris', true);
  });

  it('passes an empty-string (unscoped) override through unchanged', async () => {
    const sendMessage = vi.fn().mockResolvedValue(true);
    getManager.mockReturnValue({ sendMessage });
    const deps = createMeshActionDeps();

    await deps.sendMessage({ sourceId: 'mc', text: 'hi', channel: 0, scopeOverride: '' });

    expect(sendMessage).toHaveBeenCalledWith('hi', undefined, 0, '', true);
  });

  it('drops scopeOverride for a Meshtastic manager (no scope concept)', async () => {
    const sendTextMessage = vi.fn().mockResolvedValue(1);
    getManager.mockReturnValue({ sendTextMessage }); // Meshtastic-shaped manager
    const deps = createMeshActionDeps();

    await deps.sendMessage({ sourceId: 'mt', text: 'hi', channel: 3, scopeOverride: 'paris' });

    // sendTextMessage(text, channel, destination, replyId, emoji) — no scope arg.
    expect(sendTextMessage).toHaveBeenCalledWith('hi', 3, undefined, undefined, 0);
  });
});

// Regression tests for #4018: a MeshCore DM destination is a pubkey string, and
// must reach the manager as `toPublicKey`, not be silently dropped.
describe('createMeshActionDeps sendMessage — MeshCore DM destination (#4018)', () => {
  beforeEach(() => { getManager.mockReset(); });

  it('forwards a string destination as the MeshCore toPublicKey', async () => {
    const sendMessage = vi.fn().mockResolvedValue(true);
    getManager.mockReturnValue({ sendMessage }); // MeshCore-shaped manager
    const deps = createMeshActionDeps();

    await deps.sendMessage({ sourceId: 'mc', text: 'pong', channel: 0, destination: '3745442c10a1' });

    // raw.sendMessage(text, toPublicKey, channelIdx, scopeOverride, autoRetryOnMiss)
    expect(sendMessage).toHaveBeenCalledWith('pong', '3745442c10a1', 0, undefined, true);
  });

  it('a numeric destination reaching a MeshCore manager is dropped, not miscoerced', async () => {
    const sendMessage = vi.fn().mockResolvedValue(true);
    getManager.mockReturnValue({ sendMessage });
    const deps = createMeshActionDeps();

    await deps.sendMessage({ sourceId: 'mc', text: 'hi', channel: 0, destination: 777 });

    expect(sendMessage).toHaveBeenCalledWith('hi', undefined, 0, undefined, true);
  });

  it('a string destination reaching a Meshtastic manager is dropped, not sent as NaN', async () => {
    const sendTextMessage = vi.fn().mockResolvedValue(1);
    getManager.mockReturnValue({ sendTextMessage });
    const deps = createMeshActionDeps();

    await deps.sendMessage({ sourceId: 'mt', text: 'hi', channel: 0, destination: 'not-a-node' as unknown as number });

    expect(sendTextMessage).toHaveBeenCalledWith('hi', 0, undefined, undefined, 0);
  });
});

// Regression tests for #3915 (updated for #3962 Ph2): MeshCore managers now
// live in the unified sourceManagerRegistry — automation actions targeting a
// MeshCore source must resolve and use them (no separate registry fallback).
describe('createMeshActionDeps — MeshCore source resolved from sourceManagerRegistry (#3915/#3962)', () => {
  beforeEach(() => { getManager.mockReset(); });

  it('sendMessage reaches a MeshCore manager in the unified registry', async () => {
    const sendMessage = vi.fn().mockResolvedValue(true);
    getManager.mockReturnValue({ sendMessage }); // MeshCore-shaped manager
    const deps = createMeshActionDeps();

    await deps.sendMessage({ sourceId: 'mc', text: 'PINGTEST received!', channel: 1, scopeOverride: '' });

    expect(sendMessage).toHaveBeenCalledWith('PINGTEST received!', undefined, 1, '', true);
  });

  it('requestData reaches a MeshCore manager in the unified registry', async () => {
    const requestRemoteTelemetry = vi.fn().mockResolvedValue({});
    getManager.mockReturnValue({ sendMessage: vi.fn(), requestRemoteTelemetry });
    const deps = createMeshActionDeps();

    await deps.requestData({ sourceId: 'mc', op: 'telemetry', target: 'aabbcc', channel: 0 });

    expect(requestRemoteTelemetry).toHaveBeenCalledWith('aabbcc');
  });

  it('throws when the registry has no manager for the source', async () => {
    getManager.mockReturnValue(undefined);
    const deps = createMeshActionDeps();

    await expect(deps.sendMessage({ sourceId: 'ghost', text: 'hi', channel: 0 }))
      .rejects.toThrow(/cannot send messages/);
  });

  it('surfaces a MeshCore send failure (sendMessage resolves false) as a thrown error', async () => {
    const sendMessage = vi.fn().mockResolvedValue(false); // node disconnected / send rejected
    getManager.mockReturnValue({ sendMessage });
    const deps = createMeshActionDeps();

    await expect(deps.sendMessage({ sourceId: 'mc', text: 'hi', channel: 0 }))
      .rejects.toThrow(/failed to send the MeshCore message/);
  });
});

describe('createMeshActionDeps requestData — node operations (#3835)', () => {
  beforeEach(() => { getManager.mockReset(); });

  function meshtasticManager() {
    return {
      sendTextMessage: vi.fn(),
      sendTelemetryRequest: vi.fn().mockResolvedValue({ packetId: 1, requestId: 2 }),
      sendPositionRequest: vi.fn().mockResolvedValue({}),
      sendTraceroute: vi.fn().mockResolvedValue(undefined),
      sendNodeInfoRequest: vi.fn().mockResolvedValue({}),
      sendNeighborInfoRequest: vi.fn().mockResolvedValue({}),
      broadcastNodeInfoToChannel: vi.fn().mockResolvedValue({}),
    };
  }

  it('dispatches each op to the right Meshtastic method (node # target)', async () => {
    const m = meshtasticManager();
    getManager.mockReturnValue(m);
    const deps = createMeshActionDeps();

    await deps.requestData({ sourceId: 'mt', op: 'telemetry', target: '123', channel: 2, telemetryType: 'environment' });
    expect(m.sendTelemetryRequest).toHaveBeenCalledWith(123, 2, 'environment');

    await deps.requestData({ sourceId: 'mt', op: 'position', target: '123', channel: 0 });
    expect(m.sendPositionRequest).toHaveBeenCalledWith(123, 0);

    await deps.requestData({ sourceId: 'mt', op: 'traceroute', target: '123', channel: 1 });
    expect(m.sendTraceroute).toHaveBeenCalledWith(123, 1);

    await deps.requestData({ sourceId: 'mt', op: 'nodeinfo', target: '123', channel: 0 });
    expect(m.sendNodeInfoRequest).toHaveBeenCalledWith(123, 0);

    await deps.requestData({ sourceId: 'mt', op: 'neighbors', target: '123', channel: 0 });
    expect(m.sendNeighborInfoRequest).toHaveBeenCalledWith(123, 0);

    await deps.requestData({ sourceId: 'mt', op: 'advert', target: '', channel: 5 });
    expect(m.broadcastNodeInfoToChannel).toHaveBeenCalledWith(5);
  });

  function meshcoreManager() {
    return {
      sendMessage: vi.fn(),
      requestRemoteTelemetry: vi.fn().mockResolvedValue({}),
      traceContactPath: vi.fn().mockResolvedValue({}),
      requestNeighbors: vi.fn().mockResolvedValue({}),
      sendAdvert: vi.fn().mockResolvedValue(true),
    };
  }

  it('dispatches each supported op to the right MeshCore method (pubkey target)', async () => {
    const m = meshcoreManager();
    getManager.mockReturnValue(m);
    const deps = createMeshActionDeps();

    await deps.requestData({ sourceId: 'mc', op: 'telemetry', target: 'aabbcc', channel: 0 });
    expect(m.requestRemoteTelemetry).toHaveBeenCalledWith('aabbcc');

    await deps.requestData({ sourceId: 'mc', op: 'traceroute', target: 'aabbcc', channel: 0 });
    expect(m.traceContactPath).toHaveBeenCalledWith('aabbcc');

    await deps.requestData({ sourceId: 'mc', op: 'neighbors', target: 'aabbcc', channel: 0 });
    expect(m.requestNeighbors).toHaveBeenCalledWith('aabbcc');

    await deps.requestData({ sourceId: 'mc', op: 'advert', target: '', channel: 0 });
    expect(m.sendAdvert).toHaveBeenCalled();
  });

  it('throws for a MeshCore-unsupported op reaching the deps directly', async () => {
    getManager.mockReturnValue(meshcoreManager());
    const deps = createMeshActionDeps();
    await expect(deps.requestData({ sourceId: 'mc', op: 'position', target: 'aabbcc', channel: 0 }))
      .rejects.toThrow(/not supported on MeshCore/);
  });

  it('rejects a non-numeric Meshtastic target instead of sending NaN', async () => {
    const m = meshtasticManager();
    getManager.mockReturnValue(m);
    const deps = createMeshActionDeps();
    await expect(deps.requestData({ sourceId: 'mt', op: 'telemetry', target: 'not-a-node', channel: 0 }))
      .rejects.toThrow(/invalid Meshtastic target/);
    expect(m.sendTelemetryRequest).not.toHaveBeenCalled();
  });
});

describe('createMeshActionDeps rebootDevice — device reboot action (#3995)', () => {
  beforeEach(() => { getManager.mockReset(); });

  it('calls a Meshtastic manager rebootDevice with the seconds delay', async () => {
    const rebootDevice = vi.fn().mockResolvedValue(undefined); // void
    getManager.mockReturnValue({ sendTextMessage: vi.fn(), rebootDevice });
    const deps = createMeshActionDeps();

    const result = await deps.rebootDevice({ sourceId: 'mt', seconds: 30 });

    expect(rebootDevice).toHaveBeenCalledWith(30);
    // void return → normalized to a success marker so the run-log records success.
    expect(result).toEqual({ rebooted: true });
  });

  it('reaches a MeshCore manager via the unified registry', async () => {
    const rebootDevice = vi.fn().mockResolvedValue(true);
    getManager.mockReturnValue({ sendMessage: vi.fn(), rebootDevice });
    const deps = createMeshActionDeps();

    const result = await deps.rebootDevice({ sourceId: 'mc' });

    expect(rebootDevice).toHaveBeenCalledWith(undefined); // MeshCore ignores seconds
    expect(result).toBe(true);
  });

  it('surfaces a MeshCore reboot failure (resolves false) as a thrown error', async () => {
    const rebootDevice = vi.fn().mockResolvedValue(false); // repeater fw / disconnected
    getManager.mockReturnValue({ sendMessage: vi.fn(), rebootDevice });
    const deps = createMeshActionDeps();

    await expect(deps.rebootDevice({ sourceId: 'mc' })).rejects.toThrow(/failed to reboot/);
  });

  it('throws when the source has no manager / no rebootDevice method', async () => {
    getManager.mockReturnValue(undefined);
    const deps = createMeshActionDeps();
    await expect(deps.rebootDevice({ sourceId: 'ghost' })).rejects.toThrow(/cannot reboot/);
  });

  it('throws when no source is provided', async () => {
    const deps = createMeshActionDeps();
    await expect(deps.rebootDevice({ sourceId: null })).rejects.toThrow(/requires a target source/);
  });
});
