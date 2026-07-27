/**
 * Regression tests for issue #4368 — `add_contact` re-sent before every PKI DM.
 *
 * MeshMonitor pushed a contact to the radio ahead of EVERY PKI-encrypted DM.
 * That is not a free no-op: the firmware's `NodeDB::addFromContact()` sets
 * `is_favorite = true` to shield the entry from NodeDB eviction, so every DM —
 * including every automated Auto-Ack reply — re-favorited its recipient. The
 * favorite then came back down through the NodeInfo sync, making it look like
 * foreign state was leaking in when MeshMonitor had caused it.
 *
 * The fix pushes only when we lack evidence the radio already holds the node's
 * public key. These tests drive the REAL `sendTextMessage` and the REAL
 * NodeInfo-processing methods rather than re-implementing the predicate.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetNode = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    settings: { getSettingForSource: vi.fn().mockResolvedValue(null), getSetting: vi.fn().mockResolvedValue(null) },
    nodes: {
      getNode: (...args: unknown[]) => mockGetNode(...args),
      upsertNode: vi.fn().mockResolvedValue(undefined),
      getAllNodes: vi.fn().mockResolvedValue([]),
    },
    messages: { insertMessage: vi.fn().mockResolvedValue(undefined) },
    telemetry: { insertTelemetry: vi.fn(), insertTelemetryBatch: vi.fn() },
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

const LOCAL = 0x0a0a0a0a;
const PEER = 0x22222222;
const PEER_KEY = 'HsTA8jkJVxYBxqfm0V8KZ8wOlqL+R5vP3yEXRtY3p9c=';

const PEER_ROW = {
  nodeNum: PEER,
  nodeId: '!22222222',
  longName: 'Peer Node',
  shortName: 'PEER',
  publicKey: PEER_KEY,
  hwModel: 43,
  keyMismatchDetected: false,
};

describe('MeshtasticManager — add_contact push guard (#4368)', () => {
  let manager: any;
  let pushSpy: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await import('./meshtasticManager.js');
    manager = module.fallbackManager;
    manager.localNodeInfo = { nodeNum: LOCAL };
    manager.isConnected = true;
    manager.transport = { send: vi.fn().mockResolvedValue(undefined) };
    (manager as any).deviceNodeNums.clear();
    (manager as any).deviceContactKeyNums.clear();
    mockGetNode.mockResolvedValue(PEER_ROW);
    // Stub the actual admin-frame emission; we assert on the call, not the bytes.
    pushSpy = vi.spyOn(manager as any, 'pushContactToRadio').mockImplementation(async (n: any) => {
      (manager as any).deviceNodeNums.add(n.nodeNum);
      (manager as any).deviceContactKeyNums.add(n.nodeNum);
    });
  });

  afterEach(() => {
    (manager as any).deviceContactKeyNums.clear();
    (manager as any).deviceNodeNums.clear();
    vi.restoreAllMocks();
  });

  async function dm(text: string): Promise<void> {
    // sendTextMessage(text, channel, destination). Downstream persistence isn't
    // under test — swallow anything that fails after the guard has run.
    try {
      await manager.sendTextMessage(text, 0, PEER);
    } catch {
      /* ignore */
    }
  }

  it('pushes the contact on the FIRST DM when the radio has never shown us the key', async () => {
    await dm('first');
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy.mock.calls[0][0].nodeNum).toBe(PEER);
  });

  // The actual bug: Auto-Ack fires a DM per received message, and every one of
  // them re-pushed the contact, re-favoriting the peer each time.
  it('does NOT re-push on subsequent DMs to the same node', async () => {
    await dm('first');
    await dm('second');
    await dm('third');
    await dm('fourth');
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it('never pushes when the radio already reported the key from its own NodeDB', async () => {
    await manager.processNodeInfoProtobuf({
      num: PEER,
      user: {
        id: '!22222222',
        longName: 'Peer Node',
        shortName: 'PEER',
        publicKey: Buffer.from(PEER_KEY, 'base64'),
      },
    });
    expect(manager.hasDeviceContactKey(PEER)).toBe(true);

    await dm('hello');
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('never pushes when a mesh NodeInfo carrying the key reached us through the radio', async () => {
    await manager.processNodeInfoMessageProtobuf(
      { from: PEER, id: 1 },
      {
        id: '!22222222',
        longName: 'Peer Node',
        shortName: 'PEER',
        publicKey: new Uint8Array(Buffer.from(PEER_KEY, 'base64')),
      },
    );
    expect(manager.hasDeviceContactKey(PEER)).toBe(true);

    await dm('hello');
    expect(pushSpy).not.toHaveBeenCalled();
  });

  // A key-repair purge (sendRemoveNode) takes the key with the node, so the
  // next DM must push again or the firmware has nothing to encrypt with.
  it('pushes again after a key-repair purge drops the node from the radio', async () => {
    await dm('first');
    expect(pushSpy).toHaveBeenCalledTimes(1);

    manager.removeDeviceNodeNum(PEER);
    expect(manager.hasDeviceContactKey(PEER)).toBe(false);

    await dm('after purge');
    expect(pushSpy).toHaveBeenCalledTimes(2);
  });

  it('treats key evidence as per-connection state', async () => {
    await dm('first');
    expect(manager.hasDeviceContactKey(PEER)).toBe(true);

    // A different radio (or one whose NodeDB was wiped) may not hold the key.
    (manager as any).deviceContactKeyNums.clear();
    expect(manager.hasDeviceContactKey(PEER)).toBe(false);

    await dm('after reconnect');
    expect(pushSpy).toHaveBeenCalledTimes(2);
  });

  it('does not push for a node with a detected key mismatch (PKI is skipped entirely)', async () => {
    mockGetNode.mockResolvedValue({ ...PEER_ROW, keyMismatchDetected: true });
    await dm('mismatched');
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('does not push for a node with no public key at all', async () => {
    mockGetNode.mockResolvedValue({ ...PEER_ROW, publicKey: null });
    await dm('no key');
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('tracks evidence per node — one peer being known says nothing about another', async () => {
    const OTHER = 0x33333333;
    await dm('first');
    expect(manager.hasDeviceContactKey(PEER)).toBe(true);
    expect(manager.hasDeviceContactKey(OTHER)).toBe(false);
  });
});
