/**
 * Issue #6436 — a text message sent by one virtual-node client must reach the
 * OTHER connected clients (the way a web-UI send already does), but not echo
 * back to the client that sent it. Non-text packets are not mirrored.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    parseToRadio: vi.fn(),
    normalizePortNum: vi.fn((n: unknown) => (typeof n === 'number' ? n : 0)),
    getPortNumName: (n: number) => `PORT_${n}`,
    createFromRadioWithPacket: vi.fn().mockResolvedValue(new Uint8Array([9, 9, 9])),
    stripPKIEncryption: vi.fn(async (p: Uint8Array) => p),
  };
  return { default: svc, meshtasticProtobufService: svc };
});

vi.mock('./protobufService.js', () => {
  const svc = { decodeAdminMessage: vi.fn() };
  return { default: svc, protobufService: svc };
});

import { VirtualNodeServer } from './virtualNodeServer.js';
import meshtasticProtobufService from './meshtasticProtobufService.js';

function makeServer() {
  const manager = {
    sourceId: 'src-1',
    getLocalNodeInfo: () => ({ nodeNum: 0x11223344, nodeId: '!11223344' }),
    processIncomingData: vi.fn().mockResolvedValue(undefined),
  } as any;
  const vn = new VirtualNodeServer({ port: 4510, meshtasticManager: manager });
  // Keep the physical-node queue out of these tests.
  vi.spyOn(vn as any, 'queueMessage').mockImplementation(() => {});
  return { vn, manager };
}

function attachFakeClient(vn: VirtualNodeServer, clientId: string) {
  const writes: Uint8Array[] = [];
  const socket: any = {
    destroyed: false,
    writable: true,
    remoteAddress: '192.168.1.50',
    write: (chunk: Uint8Array, cb?: (err?: Error) => void) => {
      writes.push(chunk);
      cb?.();
      return true;
    },
    end: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn(),
  };
  (vn as any).clients.set(clientId, {
    socket,
    id: clientId,
    buffer: Buffer.alloc(0),
    connectedAt: new Date(),
    lastActivity: new Date(),
  });
  return writes;
}

function sendPacket(vn: VirtualNodeServer, clientId: string, portnum: number) {
  vi.mocked(meshtasticProtobufService.parseToRadio).mockResolvedValueOnce({
    packet: {
      id: 1234,
      from: 0,
      to: 0xffffffff,
      channel: 0,
      decoded: { portnum, payload: new Uint8Array([104, 105]) },
    },
  } as any);
  return (vn as any).handleClientMessage(clientId, new Uint8Array([1]));
}

describe('VirtualNodeServer — mirror client text messages to other clients (#6436)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('relays a text message to every other client but not back to the sender', async () => {
    const { vn, manager } = makeServer();
    const sender = attachFakeClient(vn, 'android');
    const other1 = attachFakeClient(vn, 'contact');
    const other2 = attachFakeClient(vn, 'termtastic');

    await sendPacket(vn, 'android', 1);

    expect(manager.processIncomingData).toHaveBeenCalledTimes(1);
    expect(sender).toHaveLength(0);
    expect(other1).toHaveLength(1);
    expect(other2).toHaveLength(1);
    // The mirrored frame carries the FromRadio built from the client's packet.
    const frame = Buffer.from(other1[0]);
    expect(frame[0]).toBe(0x94);
    expect(frame[1]).toBe(0xc3);
    expect(Array.from(frame.subarray(4))).toEqual([9, 9, 9]);
    // And it is still forwarded to the physical node.
    expect((vn as any).queueMessage).toHaveBeenCalledTimes(1);
  });

  it('does not mirror non-text packets (e.g. position)', async () => {
    const { vn } = makeServer();
    attachFakeClient(vn, 'android');
    const other = attachFakeClient(vn, 'contact');

    await sendPacket(vn, 'android', 3); // POSITION_APP

    expect(other).toHaveLength(0);
  });

  it('broadcastToClients without an exclusion still reaches every client', async () => {
    const { vn } = makeServer();
    const a = attachFakeClient(vn, 'a');
    const b = attachFakeClient(vn, 'b');

    await vn.broadcastToClients(new Uint8Array([1, 2]));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});
