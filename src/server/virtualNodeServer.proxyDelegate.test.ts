/**
 * Tests for issue #4037 follow-up — MQTT client-proxy delegate selection.
 *
 * When a device has mqtt.proxy_to_client_enabled, it emits
 * FromRadio.mqttClientProxyMessage frames asking its client to publish them to
 * the broker. A physical node only ever has one BLE client, so firmware
 * assumes exactly one proxy. `broadcastToProxyDelegate` must therefore send
 * the frame to exactly ONE virtual-node client — the most recently connected
 * client whose socket is still live and writable — instead of all of them,
 * or every connected app publishes the same envelope (duplicate publishes).
 */

import { describe, it, expect, vi } from 'vitest';

// ────────────────────────────────────────────────────────────────────────────
// Module mocks — set up BEFORE the import of virtualNodeServer.js
// ────────────────────────────────────────────────────────────────────────────

vi.mock('../services/database.js', () => {
  const shared = {
    nodes: {
      getActiveNodes: vi.fn().mockResolvedValue([]),
      setNodeFavorite: vi.fn().mockResolvedValue(undefined),
    },
    getSettingAsync: vi.fn().mockResolvedValue(null),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  };
  return { default: shared, databaseService: shared };
});

vi.mock('./meshtasticProtobufService.js', () => {
  const svc = {
    createNodeInfo: vi.fn().mockResolvedValue(new Uint8Array([10, 20, 30])),
    createFakeRoutingAck: vi.fn().mockResolvedValue(new Uint8Array([0xa, 0xc, 0xc])),
    parseToRadio: vi.fn(),
    normalizePortNum: vi.fn((n: unknown) => (typeof n === 'number' ? n : 0)),
    getPortNumName: (n: number) => `PORT_${n}`,
  };
  return { default: svc, meshtasticProtobufService: svc };
});

vi.mock('./protobufService.js', () => {
  const svc = {
    decodeAdminMessage: vi.fn(),
  };
  return { default: svc, protobufService: svc };
});

import { VirtualNodeServer } from './virtualNodeServer.js';

// ────────────────────────────────────────────────────────────────────────────
// Test helpers
// ────────────────────────────────────────────────────────────────────────────

function makeFakeManager(sourceId: string = 'src-1') {
  return {
    sourceId,
    getLocalNodeInfo: () => ({ nodeNum: 0x11223344, nodeId: '!11223344' }),
    processIncomingData: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeServer(): VirtualNodeServer {
  return new VirtualNodeServer({
    port: 4503,
    meshtasticManager: makeFakeManager(),
  });
}

/**
 * Stub a connected client into the VN's private clients Map and capture
 * writes via a Uint8Array recorder.
 */
function attachFakeClient(
  vn: VirtualNodeServer,
  clientId: string,
  connectedAt: Date,
  opts: { destroyed?: boolean; writable?: boolean } = {},
) {
  const writes: Uint8Array[] = [];
  const fakeSocket: any = {
    destroyed: opts.destroyed ?? false,
    writable: opts.writable ?? true,
    remoteAddress: '192.168.1.50',
    write: (chunk: Uint8Array, cb?: (err?: Error) => void) => {
      writes.push(chunk);
      if (cb) cb();
      return true;
    },
    end: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn(),
  };

  const client = {
    socket: fakeSocket,
    id: clientId,
    buffer: Buffer.alloc(0),
    connectedAt,
    lastActivity: new Date(),
  };

  (vn as any).clients.set(clientId, client);
  return { writes, client };
}

const PAYLOAD = new Uint8Array([1, 2, 3, 4]);

// ────────────────────────────────────────────────────────────────────────────
// broadcastToProxyDelegate
// ────────────────────────────────────────────────────────────────────────────

describe('VirtualNodeServer.broadcastToProxyDelegate — #4037 single-delegate proxy', () => {
  it('sends to exactly the newest connected writable client when multiple clients are connected', async () => {
    const vn = makeServer();
    const older = attachFakeClient(vn, 'client-old', new Date('2026-07-29T10:00:00Z'));
    const middle = attachFakeClient(vn, 'client-mid', new Date('2026-07-29T10:05:00Z'));
    const newest = attachFakeClient(vn, 'client-new', new Date('2026-07-29T10:10:00Z'));

    await vn.broadcastToProxyDelegate(PAYLOAD);

    expect(older.writes).toHaveLength(0);
    expect(middle.writes).toHaveLength(0);
    expect(newest.writes).toHaveLength(1);
  });

  it('frames the payload exactly like broadcastToClients (0x94 0xc3 header + length + payload)', async () => {
    const vn = makeServer();
    const { writes } = attachFakeClient(vn, 'client-1', new Date());

    await vn.broadcastToProxyDelegate(PAYLOAD);

    expect(writes).toHaveLength(1);
    const frame = Buffer.from(writes[0]);
    expect(frame[0]).toBe(0x94);
    expect(frame[1]).toBe(0xc3);
    expect((frame[2] << 8) | frame[3]).toBe(PAYLOAD.length);
    expect(frame.subarray(4).equals(Buffer.from(PAYLOAD))).toBe(true);
  });

  it('skips a destroyed newest socket and falls back to the next-newest writable client', async () => {
    const vn = makeServer();
    const older = attachFakeClient(vn, 'client-old', new Date('2026-07-29T10:00:00Z'));
    const destroyedNewest = attachFakeClient(vn, 'client-dead', new Date('2026-07-29T10:10:00Z'), {
      destroyed: true,
    });

    await vn.broadcastToProxyDelegate(PAYLOAD);

    expect(destroyedNewest.writes).toHaveLength(0);
    expect(older.writes).toHaveLength(1);
  });

  it('skips a non-writable newest socket and falls back to the next-newest writable client', async () => {
    const vn = makeServer();
    const older = attachFakeClient(vn, 'client-old', new Date('2026-07-29T10:00:00Z'));
    const unwritableNewest = attachFakeClient(vn, 'client-stuck', new Date('2026-07-29T10:10:00Z'), {
      writable: false,
    });

    await vn.broadcastToProxyDelegate(PAYLOAD);

    expect(unwritableNewest.writes).toHaveLength(0);
    expect(older.writes).toHaveLength(1);
  });

  it('drops the frame without throwing when no writable client exists', async () => {
    const vn = makeServer();
    attachFakeClient(vn, 'client-dead', new Date(), { destroyed: true });

    await expect(vn.broadcastToProxyDelegate(PAYLOAD)).resolves.toBeUndefined();
  });

  it('drops the frame without throwing when no clients are connected at all', async () => {
    const vn = makeServer();

    await expect(vn.broadcastToProxyDelegate(PAYLOAD)).resolves.toBeUndefined();
  });

  it('does not throw when the delegate socket write errors (sendToClient rejection is swallowed)', async () => {
    const vn = makeServer();
    const { client } = attachFakeClient(vn, 'client-err', new Date());
    client.socket.write = (_chunk: Uint8Array, cb?: (err?: Error) => void) => {
      if (cb) cb(new Error('boom'));
      return true;
    };

    await expect(vn.broadcastToProxyDelegate(PAYLOAD)).resolves.toBeUndefined();
  });

  it('regression: broadcastToClients still reaches ALL writable clients', async () => {
    const vn = makeServer();
    const a = attachFakeClient(vn, 'client-a', new Date('2026-07-29T10:00:00Z'));
    const b = attachFakeClient(vn, 'client-b', new Date('2026-07-29T10:10:00Z'));

    await vn.broadcastToClients(PAYLOAD);

    expect(a.writes).toHaveLength(1);
    expect(b.writes).toHaveLength(1);
  });
});
