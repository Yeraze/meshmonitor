import { describe, it, expect } from 'vitest';
import { deriveMeshCorePacketFields } from './meshcorePacketDerived.js';

const KEY = 'ab'.repeat(32);

/** header(1) path_len(1) payload */
function frame(payloadType: number, routeType: number, payloadHex: string, pathLen = 0): string {
  const header = (payloadType << 2) | routeType;
  return header.toString(16).padStart(2, '0') + pathLen.toString(16).padStart(2, '0') + payloadHex;
}

function advert(name: string): string {
  const flags = 0x81; // chat + name
  const nameHex = Buffer.from(name).toString('hex');
  return KEY + '00000000' + '00'.repeat(64) + flags.toString(16) + nameHex;
}

describe('deriveMeshCorePacketFields', () => {
  it('ADVERT yields key, first-byte hash and name', () => {
    const r = deriveMeshCorePacketFields(frame(4, 1, advert('Hilltop')));
    expect(r).toEqual({ srcHash: 'ab', senderPubKey: KEY, advertName: 'Hilltop' });
  });

  it('TXT_MSG yields the plaintext src byte only', () => {
    const r = deriveMeshCorePacketFields(frame(2, 1, 'a1b2' + 'cc'.repeat(8)));
    expect(r).toEqual({ srcHash: 'b2', senderPubKey: null, advertName: null });
  });

  it('ANON_REQ yields the sender key', () => {
    const r = deriveMeshCorePacketFields(frame(7, 1, 'ff' + KEY + 'dd'.repeat(6)));
    expect(r.senderPubKey).toBe(KEY);
    expect(r.srcHash).toBe('ab');
  });

  it('GRP_TXT, ACK and garbage yield nulls and never throw', () => {
    const nulls = { srcHash: null, senderPubKey: null, advertName: null };
    expect(deriveMeshCorePacketFields(frame(5, 1, '11223344aabb'))).toEqual(nulls);
    expect(deriveMeshCorePacketFields(frame(3, 1, '01020304'))).toEqual(nulls);
    expect(deriveMeshCorePacketFields('zz')).toEqual(nulls);
    expect(deriveMeshCorePacketFields(null)).toEqual(nulls);
    expect(deriveMeshCorePacketFields('')).toEqual(nulls);
  });
});
