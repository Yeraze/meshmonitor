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

  it('maps a trace: snr stays dB*4 per link, route between ends, sentinel for unresolved', () => {
    const local = 'aa'.repeat(32), mid = 'bb'.repeat(32), end = 'cc'.repeat(32);
    const t = meshcoreTraceToV1([
      hop({ hopIndex: 2, receiverPublicKey: end, receiverHash: 'cc', snrQuarterDb: -8 }),
      hop({ hopIndex: 0, senderPublicKey: null, receiverPublicKey: mid, receiverHash: 'bb', snrQuarterDb: 22 }),
      hop({ hopIndex: 1, receiverPublicKey: null, receiverHash: 'dd', snrQuarterDb: 14 }),
    ], { localPublicKey: local })!;
    expect(t.fromNodeId).toBe(`mc:${local}`);
    expect(t.toNodeId).toBe(`mc:${end}`);
    expect(JSON.parse(t.route)).toEqual([nodeNumFromPubkey(mid), UNRESOLVED_NODE_NUM]);
    expect(JSON.parse(t.snrTowards)).toEqual([22, 14, -8]);
    expect(t.routeBack).toBeNull();
    expect(t.snrBack).toBeNull();
    expect(t.hops).toEqual([
      { index: 0, publicKey: mid, hash: 'bb', snr: 5.5 },
      { index: 1, publicKey: null, hash: 'dd', snr: 3.5 },
      { index: 2, publicKey: end, hash: 'cc', snr: -2 },
    ]);
    expect(t.timestamp).toBe(1000);
  });

  it('returns null for an empty trace and sentinel ends when nothing resolved', () => {
    expect(meshcoreTraceToV1([])).toBeNull();
    const t = meshcoreTraceToV1([hop({})])!;
    expect(t.fromNodeNum).toBe(UNRESOLVED_NODE_NUM);
    expect(t.fromNodeId).toBeNull();
    expect(JSON.parse(t.route)).toEqual([]);
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
