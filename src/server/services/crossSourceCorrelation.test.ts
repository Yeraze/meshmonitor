import { describe, it, expect } from 'vitest';
import {
  CrossSourceIndex,
  classifyMeshtasticReception,
  classifyMeshCoreReception,
  meshtasticTransportClass,
  meshcoreTransportClass,
  isRfEdgeTransport,
  prepareMeshCoreReception,
} from './crossSourceCorrelation.js';
import { TransportMechanism } from '../constants/meshtastic.js';

const A = 'src-a';
const B = 'src-b';
const C = 'src-c';
const NUM_A = 0x11223344;
const NUM_B = 0x55667788;
const NUM_C = 0x99aabb44; // same low byte (0x44) as A: relay-hash collision
const KEY_A = 'aa' + '01'.repeat(31);
const KEY_B = 'bb' + '02'.repeat(31);
const KEY_C = 'aa' + '03'.repeat(31); // shares the 1-byte hash 'aa' with A

function mtIndex(extra: Array<[string, number]> = []) {
  return new CrossSourceIndex(new Map<string, number>([[A, NUM_A], [B, NUM_B], ...extra]), new Map());
}
function mcIndex(extra: Array<[string, string]> = []) {
  return new CrossSourceIndex(new Map(), new Map<string, string>([[A, KEY_A], [B, KEY_B], ...extra]));
}

describe('transport classes', () => {
  it('maps Meshtastic mechanisms', () => {
    expect(meshtasticTransportClass(TransportMechanism.LORA)).toBe('rf');
    expect(meshtasticTransportClass(TransportMechanism.LORA_ALT3)).toBe('rf');
    expect(meshtasticTransportClass(null)).toBe('rf');
    expect(meshtasticTransportClass(TransportMechanism.MQTT)).toBe('mqtt');
    expect(meshtasticTransportClass(TransportMechanism.MULTICAST_UDP)).toBe('udp');
    expect(meshtasticTransportClass(TransportMechanism.API)).toBeNull();
    expect(meshtasticTransportClass(TransportMechanism.INTERNAL)).toBeNull();
    expect(meshtasticTransportClass(TransportMechanism.MQTT, 'mqtt_gateway')).toBe('mqtt_gateway');
  });

  it('maps MeshCore observer vs own radio', () => {
    expect(meshcoreTransportClass(null)).toBe('rf');
    expect(meshcoreTransportClass(KEY_C)).toBe('mqtt_gateway');
  });

  it('only rf and mqtt_gateway prove an RF path', () => {
    expect(isRfEdgeTransport('rf')).toBe(true);
    expect(isRfEdgeTransport('mqtt_gateway')).toBe(true);
    expect(isRfEdgeTransport('mqtt')).toBe(false);
    expect(isRfEdgeTransport('udp')).toBe(false);
    expect(isRfEdgeTransport(null)).toBe(false);
  });
});

describe('classifyMeshtasticReception', () => {
  it('origin: B hears a packet from A over RF', () => {
    const tags = classifyMeshtasticReception(mtIndex(), {
      sourceId: B, fromNode: NUM_A, hopStart: 3, hopLimit: 3, relayNode: NUM_A & 0xff,
      transportMechanism: TransportMechanism.LORA,
    });
    expect(tags).toEqual({ originSourceId: A, likelyRelaySourceId: null, likelyRelayCandidates: [], transport: 'rf' });
  });

  it('origin over a broker-delivered MQTT copy keeps transport mqtt', () => {
    const tags = classifyMeshtasticReception(mtIndex(), {
      sourceId: B, fromNode: NUM_A, transportMechanism: TransportMechanism.MQTT,
    });
    expect(tags?.originSourceId).toBe(A);
    expect(tags?.transport).toBe('mqtt');
  });

  it('origin over UDP', () => {
    expect(classifyMeshtasticReception(mtIndex(), {
      sourceId: B, fromNode: NUM_A, transportMechanism: TransportMechanism.MULTICAST_UDP,
    })?.transport).toBe('udp');
  });

  it('a source hearing its own node is not cross-source', () => {
    expect(classifyMeshtasticReception(mtIndex(), { sourceId: A, fromNode: NUM_A })).toBeNull();
  });

  it('two connections to the same radio never correlate', () => {
    const idx = new CrossSourceIndex(new Map([[A, NUM_A], [B, NUM_A]]), new Map());
    expect(classifyMeshtasticReception(idx, { sourceId: B, fromNode: NUM_A })).toBeNull();
  });

  it('API / INTERNAL copies are not hearings', () => {
    expect(classifyMeshtasticReception(mtIndex(), {
      sourceId: B, fromNode: NUM_A, transportMechanism: TransportMechanism.API,
    })).toBeNull();
  });

  it('likely relay: relay byte matches A, packet from a third node, hops > 0', () => {
    const tags = classifyMeshtasticReception(mtIndex(), {
      sourceId: B, fromNode: 0x0badbeef, relayNode: NUM_A & 0xff, hopStart: 3, hopLimit: 2,
    });
    expect(tags).toEqual({ originSourceId: null, likelyRelaySourceId: A, likelyRelayCandidates: [A], transport: 'rf' });
  });

  it('no relay inference at hop 0 (relay byte is the sender itself)', () => {
    expect(classifyMeshtasticReception(mtIndex(), {
      sourceId: B, fromNode: 0x0badbeef, relayNode: NUM_A & 0xff, hopStart: 3, hopLimit: 3,
    })).toBeNull();
  });

  it('no relay inference without hop fields or a zero relay byte', () => {
    expect(classifyMeshtasticReception(mtIndex(), {
      sourceId: B, fromNode: 0x0badbeef, relayNode: NUM_A & 0xff,
    })).toBeNull();
    expect(classifyMeshtasticReception(mtIndex(), {
      sourceId: B, fromNode: 0x0badbeef, relayNode: 0, hopStart: 3, hopLimit: 1,
    })).toBeNull();
  });

  it('ambiguous relay byte returns every candidate, first is deterministic', () => {
    const tags = classifyMeshtasticReception(mtIndex([[C, NUM_C]]), {
      sourceId: B, fromNode: 0x0badbeef, relayNode: 0x44, hopStart: 3, hopLimit: 1,
    });
    expect(tags?.likelyRelayCandidates).toEqual([A, C]);
    expect(tags?.likelyRelaySourceId).toBe(A);
  });

  it('origin A relayed by C: both tags', () => {
    const idx = new CrossSourceIndex(new Map([[A, NUM_A], [B, NUM_B], [C, 0x12345699]]), new Map());
    const tags = classifyMeshtasticReception(idx, {
      sourceId: B, fromNode: NUM_A, relayNode: 0x99, hopStart: 3, hopLimit: 2,
    });
    expect(tags?.originSourceId).toBe(A);
    expect(tags?.likelyRelaySourceId).toBe(C);
  });

  it('the origin is never also its own relay candidate', () => {
    const tags = classifyMeshtasticReception(mtIndex(), {
      sourceId: B, fromNode: NUM_A, relayNode: NUM_A & 0xff, hopStart: 3, hopLimit: 1,
    });
    expect(tags?.likelyRelayCandidates).toEqual([]);
  });

  it('originOnly skips relay inference', () => {
    expect(classifyMeshtasticReception(mtIndex(), {
      sourceId: B, fromNode: 0x0badbeef, relayNode: NUM_A & 0xff, hopStart: 3, hopLimit: 2, originOnly: true,
    })).toBeNull();
  });

  it('mqtt_gateway row: gateway G heard A over RF', () => {
    const tags = classifyMeshtasticReception(mtIndex(), {
      sourceId: B, fromNode: NUM_A, receiverKind: 'mqtt_gateway', receiverNodeNum: 0x0000beef,
    });
    expect(tags?.originSourceId).toBe(A);
    expect(tags?.transport).toBe('mqtt_gateway');
  });

  it('mqtt_gateway row where the gateway IS A is not a hearing', () => {
    expect(classifyMeshtasticReception(mtIndex(), {
      sourceId: B, fromNode: NUM_A, receiverKind: 'mqtt_gateway', receiverNodeNum: NUM_A,
    })).toBeNull();
  });

  it('an MQTT source with no identity of its own can still hear A', () => {
    const idx = new CrossSourceIndex(new Map([[A, NUM_A]]), new Map());
    expect(classifyMeshtasticReception(idx, { sourceId: 'mqtt-src', fromNode: NUM_A, transportMechanism: 5 }))
      .toMatchObject({ originSourceId: A, transport: 'mqtt' });
  });

  it('an empty index never tags anything', () => {
    const idx = new CrossSourceIndex(new Map(), new Map());
    expect(classifyMeshtasticReception(idx, { sourceId: B, fromNode: NUM_A })).toBeNull();
  });

  it('a source outside the index (not readable) is never named', () => {
    // C is not in the index: a packet from C's node gets no tag.
    expect(classifyMeshtasticReception(mtIndex(), { sourceId: B, fromNode: NUM_C })).toBeNull();
  });
});

describe('classifyMeshCoreReception', () => {
  it('origin: B hears A\'s (verified) advert', () => {
    const tags = classifyMeshCoreReception(mcIndex(), { sourceId: B, advertPublicKey: KEY_A.toUpperCase(), routeType: 1, pathHops: [] });
    expect(tags).toEqual({ originSourceId: A, likelyRelaySourceId: null, likelyRelayCandidates: [], transport: 'rf' });
  });

  it('origin via an Observer is mqtt_gateway', () => {
    const tags = classifyMeshCoreReception(mcIndex(), { sourceId: B, advertPublicKey: KEY_A, observerId: 'cc'.repeat(32) });
    expect(tags?.transport).toBe('mqtt_gateway');
    expect(tags?.originSourceId).toBe(A);
  });

  it('an Observer that IS the origin is not a hearing', () => {
    expect(classifyMeshCoreReception(mcIndex(), { sourceId: B, advertPublicKey: KEY_A, observerId: KEY_A })).toBeNull();
  });

  it('own advert heard by its own source is not cross-source', () => {
    expect(classifyMeshCoreReception(mcIndex(), { sourceId: A, advertPublicKey: KEY_A })).toBeNull();
  });

  it('likely relay from a 1-byte path hash on a flood packet', () => {
    const tags = classifyMeshCoreReception(mcIndex(), { sourceId: B, routeType: 1, pathHops: ['7f', 'aa'] });
    expect(tags?.likelyRelaySourceId).toBe(A);
    expect(tags?.originSourceId).toBeNull();
  });

  it('2-byte hashes narrow the match', () => {
    const idx = mcIndex([[C, KEY_C]]);
    expect(classifyMeshCoreReception(idx, { sourceId: B, routeType: 0, pathHops: ['aa'] })?.likelyRelayCandidates)
      .toEqual([A, C]);
    expect(classifyMeshCoreReception(idx, { sourceId: B, routeType: 0, pathHops: ['aa03'] })?.likelyRelayCandidates)
      .toEqual([C]);
  });

  it('direct routes carry no relay evidence', () => {
    expect(classifyMeshCoreReception(mcIndex(), { sourceId: B, routeType: 2, pathHops: ['aa'] })).toBeNull();
  });

  it('the advert sender is never its own relay candidate', () => {
    const tags = classifyMeshCoreReception(mcIndex(), { sourceId: B, advertPublicKey: KEY_A, routeType: 1, pathHops: ['aa'] });
    expect(tags?.originSourceId).toBe(A);
    expect(tags?.likelyRelayCandidates).toEqual([]);
  });

  it('malformed hops are ignored', () => {
    expect(classifyMeshCoreReception(mcIndex(), { sourceId: B, routeType: 1, pathHops: ['zz', ''] })).toBeNull();
  });

  it('mixed index: Meshtastic and MeshCore identities coexist', () => {
    const idx = new CrossSourceIndex(new Map([[A, NUM_A]]), new Map([[C, KEY_C]]));
    expect(classifyMeshtasticReception(idx, { sourceId: B, fromNode: NUM_A })?.originSourceId).toBe(A);
    expect(classifyMeshCoreReception(idx, { sourceId: B, advertPublicKey: KEY_C })?.originSourceId).toBe(C);
  });
});

// Genuinely Ed25519-signed advert fixtures, copied from coverageMeshCore.test.ts.
const GOLDEN_PUBLIC_KEY = 'f3d220dfe9d16abbbe18c13906206cfa4d39e3f37c0b5241d08db75a375050f0';
const GOLDEN_FLOOD_RAW_HEX =
  '1142aabbccddf3d220dfe9d16abbbe18c13906206cfa4d39e3f37c0b5241d08db75a375050f0e0a1d36846b1826a94a718e0fd961682e4642dffce38f8593e7c9d949a461bd100871ad0bd6e86240be715d5035463db80472a35c2d02a2cf465c988a4942f1f884ed50790346640023807b4f8476f6c64656e4e6f6465';
const GOLDEN_TAMPERED_RAW_HEX =
  '12fff3d220dfe9d16abbbe18c13906206cfa4d39e3f37c0b5241d08db75a375050f0e0a1d36846b1826a94a718e0fd961682e4642dffce38f8593e7c9d949a461bd100871ad0bd6e86240be715d5035463db80472a35c2d02a2cf465c988a4942f1f884ed50790cb6640023807b4f8476f6c64656e4e6f6465';

describe('prepareMeshCoreReception', () => {
  const idx = () => new CrossSourceIndex(new Map(), new Map([[A, GOLDEN_PUBLIC_KEY], [C, 'ccdd' + '00'.repeat(30)]]));

  it('a verified advert from A yields an origin tag, path hops give relay candidates', async () => {
    const input = await prepareMeshCoreReception(idx(), { sourceId: B, rawHex: GOLDEN_FLOOD_RAW_HEX });
    expect(input.advertPublicKey).toBe(GOLDEN_PUBLIC_KEY);
    expect(input.routeType).toBe(1);
    expect(input.pathHops).toEqual(['aabb', 'ccdd']);
    const tags = classifyMeshCoreReception(idx(), input);
    expect(tags?.originSourceId).toBe(A);
    expect(tags?.likelyRelayCandidates).toEqual([C]);
  });

  it('a forged (bad signature) advert claiming A is not an origin', async () => {
    const input = await prepareMeshCoreReception(idx(), { sourceId: B, rawHex: GOLDEN_TAMPERED_RAW_HEX });
    expect(input.advertPublicKey).toBeUndefined();
    expect(classifyMeshCoreReception(idx(), input)).toBeNull();
  });

  it('undecodable frames are a no-op', async () => {
    const input = await prepareMeshCoreReception(idx(), { sourceId: B, rawHex: 'zz' });
    expect(classifyMeshCoreReception(idx(), input)).toBeNull();
  });
});

describe('CrossSourceIndex sender-id helpers', () => {
  it('lists and resolves coverage-style sender ids', () => {
    const idx = new CrossSourceIndex(new Map([[A, NUM_A]]), new Map([[C, KEY_C]]));
    expect(idx.ownSenderIds()).toEqual(['!11223344', KEY_C].sort());
    expect(idx.ownerOfSenderId('!11223344')).toBe(A);
    expect(idx.ownerOfSenderId(KEY_C.toUpperCase())).toBe(C);
    expect(idx.ownerOfSenderId('!deadbeef')).toBeNull();
    expect(idx.ownerOfSenderId('junk')).toBeNull();
  });
});
