import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock both registries so we can inject fake Meshtastic / MeshCore managers.
// Meshtastic managers live in sourceManagerRegistry; MeshCore managers live in
// the separate meshcoreManagerRegistry (#3915) — the deps must consult both.
const getManager = vi.fn();
const meshcoreGet = vi.fn();
vi.mock('../../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: (id: string) => getManager(id) },
}));
vi.mock('../../meshcoreRegistry.js', () => ({
  meshcoreManagerRegistry: { get: (id: string) => meshcoreGet(id) },
}));
// The deps module also imports these at load time; stub to harmless objects.
vi.mock('../../../services/database.js', () => ({ default: {} }));
vi.mock('../appriseNotificationService.js', () => ({ appriseNotificationService: {} }));
vi.mock('../../utils/scriptRunner.js', () => ({ runScript: vi.fn() }));

import { createMeshActionDeps } from './meshActionDeps.js';

describe('createMeshActionDeps sendMessage — MeshCore scope (#3833)', () => {
  beforeEach(() => { getManager.mockReset(); meshcoreGet.mockReset(); });

  it('forwards scopeOverride to a MeshCore manager (sendMessage signature)', async () => {
    const sendMessage = vi.fn().mockResolvedValue(true);
    getManager.mockReturnValue({ sendMessage }); // MeshCore-shaped manager
    const deps = createMeshActionDeps();

    await deps.sendMessage({ sourceId: 'mc', text: 'hi', channel: 2, scopeOverride: 'paris' });

    // raw.sendMessage(text, toPublicKey=undefined, channelIdx, scopeOverride)
    expect(sendMessage).toHaveBeenCalledWith('hi', undefined, 2, 'paris');
  });

  it('passes an empty-string (unscoped) override through unchanged', async () => {
    const sendMessage = vi.fn().mockResolvedValue(true);
    getManager.mockReturnValue({ sendMessage });
    const deps = createMeshActionDeps();

    await deps.sendMessage({ sourceId: 'mc', text: 'hi', channel: 0, scopeOverride: '' });

    expect(sendMessage).toHaveBeenCalledWith('hi', undefined, 0, '');
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

// Regression tests for #3915: MeshCore managers are NOT in sourceManagerRegistry
// (getManager returns undefined for them) — the deps must fall back to
// meshcoreManagerRegistry, or every MeshCore action fails with "cannot send
// messages" even for a healthy, connected source.
describe('createMeshActionDeps — MeshCore source resolved from meshcoreManagerRegistry (#3915)', () => {
  beforeEach(() => { getManager.mockReset(); meshcoreGet.mockReset(); });

  it('sendMessage reaches a MeshCore manager that is only in meshcoreManagerRegistry', async () => {
    const sendMessage = vi.fn().mockResolvedValue(true);
    getManager.mockReturnValue(undefined);         // not a Meshtastic source
    meshcoreGet.mockReturnValue({ sendMessage });  // lives in the MeshCore registry
    const deps = createMeshActionDeps();

    await deps.sendMessage({ sourceId: 'mc', text: 'PINGTEST received!', channel: 1, scopeOverride: '' });

    expect(sendMessage).toHaveBeenCalledWith('PINGTEST received!', undefined, 1, '');
  });

  it('requestData reaches a MeshCore manager that is only in meshcoreManagerRegistry', async () => {
    const requestRemoteTelemetry = vi.fn().mockResolvedValue({});
    getManager.mockReturnValue(undefined);
    meshcoreGet.mockReturnValue({ sendMessage: vi.fn(), requestRemoteTelemetry });
    const deps = createMeshActionDeps();

    await deps.requestData({ sourceId: 'mc', op: 'telemetry', target: 'aabbcc', channel: 0 });

    expect(requestRemoteTelemetry).toHaveBeenCalledWith('aabbcc');
  });

  it('throws when neither registry has the source', async () => {
    getManager.mockReturnValue(undefined);
    meshcoreGet.mockReturnValue(undefined);
    const deps = createMeshActionDeps();

    await expect(deps.sendMessage({ sourceId: 'ghost', text: 'hi', channel: 0 }))
      .rejects.toThrow(/cannot send messages/);
  });

  it('surfaces a MeshCore send failure (sendMessage resolves false) as a thrown error', async () => {
    const sendMessage = vi.fn().mockResolvedValue(false); // node disconnected / send rejected
    getManager.mockReturnValue(undefined);
    meshcoreGet.mockReturnValue({ sendMessage });
    const deps = createMeshActionDeps();

    await expect(deps.sendMessage({ sourceId: 'mc', text: 'hi', channel: 0 }))
      .rejects.toThrow(/failed to send the MeshCore message/);
  });
});

describe('createMeshActionDeps requestData — node operations (#3835)', () => {
  beforeEach(() => { getManager.mockReset(); meshcoreGet.mockReset(); });

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
