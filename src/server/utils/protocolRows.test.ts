import { describe, it, expect } from 'vitest';
import {
  meshcoreNodeToV1, meshcoreMessageToV1, meshcoreTraceToV1, meshcorePacketToV1,
  withMeshtasticProtocol, parseMeshcoreNodeId, meshcoreNodeKey,
  UNRESOLVED_NODE_NUM, BROADCAST_NODE_ID, BROADCAST_NODE_NUM,
} from './protocolRows.js';
import { nodeNumFromPubkey } from '../../utils/meshcoreNodeNum.js';
import type { MeshCoreHopSnrRow } from '../../db/repositories/meshcoreHopSnr.js';

const K = 'AB'.repeat(32);
const k = K.toLowerCase();

describe('protocolRows', () => {
  it('tags Meshtastic rows additively', () => {
    expect(withMeshtasticProtocol({ a: 1 })).toEqual({ a: 1, protocol: 'meshtastic' });
  });

  it('parses and builds mc: identity', () => {
    expect(meshcoreNodeKey(K)).toBe(`mc:${k}`);
    expect(meshcoreNodeKey('')).toBeNull();
    expect(parseMeshcoreNodeId(`mc:${K}`)).toBe(k);
    expect(parseMeshcoreNodeId(k)).toBe(k);
    expect(parseMeshcoreNodeId('mc:abcd')).toBeNull();
    expect(parseMeshcoreNodeId('!aabbccdd')).toBeNull();
    // Tampered query params (arrays / objects) never parse as a key.
    expect(parseMeshcoreNodeId([`mc:${K}`])).toBeNull();
    expect(parseMeshcoreNodeId({ id: k })).toBeNull();
  });

  it('maps a node: ms to seconds, mV to V, pathLen to hopsAway, synthetic nodeNum', () => {
    const n = meshcoreNodeToV1({
      publicKey: k, name: 'Hilltop', lastHeard: 1_790_000_123_456, batteryMv: 4100, uptimeSecs: 99, pathLen: 3,
      snr: 5.5, isLocalNode: true, latitude: 1, longitude: 2, sourceId: 's',
    });
    expect(n).toMatchObject({
      protocol: 'meshcore', nodeId: `mc:${k}`, nodeKey: `mc:${k}`, publicKey: k, nodeNum: nodeNumFromPubkey(k),
      longName: 'Hilltop', shortName: 'Hill', lastHeard: 1_790_000_123, voltage: 4.1, uptimeSeconds: 99,
      hopsAway: 3, snr: 5.5, isLocalNode: true, sourceId: 's',
    });
    const bare = meshcoreNodeToV1({ publicKey: k });
    expect(bare.lastHeard).toBeNull();
    expect(bare.voltage).toBeNull();
    expect(bare.latitude).toBeNull();
  });

  it('maps a channel message: slot, broadcast recipient, no sender key', () => {
    const m = meshcoreMessageToV1({ id: 'i', fromPublicKey: 'channel-3', fromName: 'Bob', text: 'hi', timestamp: 5, createdAt: 6, sourceId: 's', snr: 2 });
    expect(m).toMatchObject({
      protocol: 'meshcore', channel: 3, messageType: 'channel', fromNodeId: null, fromNodeNum: null,
      toNodeId: BROADCAST_NODE_ID, toNodeNum: BROADCAST_NODE_NUM, fromName: 'Bob', timestamp: 5, rxSnr: 2,
    });
  });

  it('maps a DM and a room post to channel -1; prefixes get no number', () => {
    const dm = meshcoreMessageToV1({ id: 'd', fromPublicKey: k.slice(0, 12), toPublicKey: K, text: 'x', timestamp: 1, createdAt: 1 });
    expect(dm).toMatchObject({ channel: -1, messageType: 'dm', fromNodeId: `mc:${k.slice(0, 12)}`, fromNodeNum: null, fromPublicKey: null, toNodeId: `mc:${k}`, toPublicKey: k });
    const room = meshcoreMessageToV1({ id: 'r', fromPublicKey: k, toPublicKey: 'cd'.repeat(32), text: 'x', timestamp: 1, createdAt: 1, messageType: 'room_post' });
    expect(room).toMatchObject({ channel: -1, messageType: 'room_post' });
  });

  const hop = (o: Partial<MeshCoreHopSnrRow>): MeshCoreHopSnrRow => ({
    sourceId: 's', traceTag: 7, authCode: 1, hopIndex: 0, hopCount: 3, hashBytes: 1,
    senderPublicKey: null, senderHash: null, senderCandidates: 0,
    receiverPublicKey: null, receiverHash: null, receiverCandidates: 0,
    snrQuarterDb: 0, initiated: true, timestamp: 1000, ...o,
  });

  const local = 'aa'.repeat(32), bb = 'bb'.repeat(32), dd = 'dd'.repeat(32), comp = 'cc'.repeat(32);
  const loop = [
    hop({ hopIndex: 0, hopCount: 4, senderPublicKey: local, receiverPublicKey: bb, receiverHash: 'bb', snrQuarterDb: 22 }),
    hop({ hopIndex: 1, hopCount: 4, receiverPublicKey: dd, receiverHash: 'dd', snrQuarterDb: 14 }),
    hop({ hopIndex: 2, hopCount: 4, receiverPublicKey: bb, receiverHash: 'bb', snrQuarterDb: 10 }),
    hop({ hopIndex: 3, hopCount: 4, senderPublicKey: bb, senderHash: 'bb', receiverPublicKey: local, receiverHash: null, snrQuarterDb: -8 }),
  ];

  it('maps a trace as a loop local -> hops -> local; to is the turnaround, not the local radio', () => {
    const t = meshcoreTraceToV1([...loop].reverse(), { localPublicKey: local })!;
    expect(t.fromNodeId).toBe(`mc:${local}`);
    expect(t.toNodeId).toBe(`mc:${dd}`);
    expect(t.toNodeId).not.toBe(t.fromNodeId);
    expect(JSON.parse(t.route)).toEqual([nodeNumFromPubkey(bb)]);
    expect(JSON.parse(t.snrTowards)).toEqual([22, 14]);
    expect(JSON.parse(t.routeBack!)).toEqual([nodeNumFromPubkey(bb)]);
    expect(JSON.parse(t.snrBack!)).toEqual([10, -8]);
    expect(t.hops.map((h) => h.index)).toEqual([0, 1, 2, 3]);
    expect(t.timestamp).toBe(1000);
  });

  it('a known companion target is the destination even though it is not on the wire', () => {
    const t = meshcoreTraceToV1(loop, { localPublicKey: local, targetPublicKey: comp })!;
    expect(t.toNodeId).toBe(`mc:${comp}`);
    expect(t.toNodeId).not.toBe(t.fromNodeId);
    expect(JSON.parse(t.route)).toEqual([nodeNumFromPubkey(bb), nodeNumFromPubkey(dd)]);
    expect(JSON.parse(t.snrTowards)).toEqual([22, 14, -128]);
  });

  it('returns null for an empty trace and sentinel ends when nothing resolved', () => {
    expect(meshcoreTraceToV1([])).toBeNull();
    const t = meshcoreTraceToV1([hop({})])!;
    expect(t.fromNodeNum).toBe(UNRESOLVED_NODE_NUM);
    expect(t.fromNodeId).toBeNull();
    expect(JSON.parse(t.route)).toEqual([UNRESOLVED_NODE_NUM]);
  });

  it('maps a packet; plaintext only when supplied', () => {
    const base = { id: 4, sourceId: 's', timestamp: 9, payloadType: 4, payloadTypeName: 'ADVERT', routeType: 1, hopCount: 2, pathHops: 'a3,7f', senderPubKey: K, snr: 1, createdAt: 9 };
    const p = meshcorePacketToV1(base);
    expect(p).toMatchObject({ protocol: 'meshcore', payload_type: 4, path_hops: ['a3', '7f'], node_key: `mc:${k}`, sender_public_key: k, from_node: nodeNumFromPubkey(k) });
    expect('plaintext' in p).toBe(false);
    expect(meshcorePacketToV1({ ...base, pathHops: null, senderPubKey: null }).path_hops).toEqual([]);
    expect(meshcorePacketToV1(base, { plaintext: 'hello' })).toMatchObject({ plaintext: 'hello' });
    expect(meshcorePacketToV1(base, { plaintext: null })).toMatchObject({ plaintext: null });
  });
});
