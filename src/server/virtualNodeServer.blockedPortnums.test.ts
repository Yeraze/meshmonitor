/**
 * Only ADMIN_APP is blocked from remote Virtual Node clients (admin commands
 * off, the default). Waypoints and NodeInfo are user traffic and pass through.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PortNum } from './constants/meshtastic.js';

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
    createFakeRoutingAck: vi.fn().mockResolvedValue(null),
    stripPKIEncryption: vi.fn(async (p: Uint8Array) => p),
  };
  return { default: svc, meshtasticProtobufService: svc };
});

vi.mock('./protobufService.js', () => {
  // A decodable admin message that is not addContact/favorite/removeByNodenum.
  const svc = { decodeAdminMessage: vi.fn(() => ({ getConfigRequest: 1 })) };
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
  const vn = new VirtualNodeServer({ port: 4511, meshtasticManager: manager });
  vi.spyOn(vn as any, 'queueMessage').mockImplementation(() => {});
  (vn as any).clients.set('remote', {
    socket: {
      destroyed: false,
      writable: true,
      remoteAddress: '192.168.1.50',
      write: (_c: Uint8Array, cb?: (err?: Error) => void) => { cb?.(); return true; },
      end: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
    },
    id: 'remote',
    buffer: Buffer.alloc(0),
    connectedAt: new Date(),
    lastActivity: new Date(),
  });
  return vn;
}

function send(vn: VirtualNodeServer, portnum: number) {
  vi.mocked(meshtasticProtobufService.parseToRadio).mockResolvedValueOnce({
    packet: {
      id: 1234,
      from: 0,
      to: 0xffffffff,
      channel: 0,
      decoded: { portnum, payload: new Uint8Array([1, 2]) },
    },
  } as any);
  return (vn as any).handleClientMessage('remote', new Uint8Array([1]));
}

describe('VirtualNodeServer — blocked portnums (admin commands off)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards WAYPOINT_APP from a remote client', async () => {
    const vn = makeServer();
    expect(vn.isAdminCommandsAllowed()).toBe(false);
    await send(vn, PortNum.WAYPOINT_APP);
    expect((vn as any).queueMessage).toHaveBeenCalledTimes(1);
  });

  it('forwards NODEINFO_APP from a remote client', async () => {
    const vn = makeServer();
    await send(vn, PortNum.NODEINFO_APP);
    expect((vn as any).queueMessage).toHaveBeenCalledTimes(1);
  });

  it('still blocks ADMIN_APP from a remote client', async () => {
    const vn = makeServer();
    await send(vn, PortNum.ADMIN_APP);
    expect((vn as any).queueMessage).not.toHaveBeenCalled();
  });
});
