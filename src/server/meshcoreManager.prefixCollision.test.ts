/**
 * #5349 — contacts that share a short public-key prefix.
 *
 * On a busy mesh many contacts share the first byte (or two) of their key.
 * `resolveContactByPrefix` used to return the first `startsWith` match, which
 * silently attributed names/replies to whichever colliding contact was
 * inserted first. It now refuses an ambiguous prefix; `resolveContactsByPrefix`
 * returns every candidate; `nameForRelayHash` names a 1-3 byte route hop only
 * when exactly one repeater/room server owns it.
 */
import { describe, it, expect } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';

const A = '5708aa' + '1'.repeat(58); // repeater
const B = '5708bb' + '2'.repeat(58); // repeater
const C = '5710cc' + '3'.repeat(58); // companion (chat)
const D = '5710dd' + '4'.repeat(58); // repeater

function makeManager(
  contacts: Array<{ publicKey: string; advType: number; advName: string }>,
): MeshCoreManager {
  const m = new MeshCoreManager('test-source');
  for (const c of contacts) {
    (m as any).contacts.set(c.publicKey, { ...c });
  }
  return m;
}

describe('MeshCoreManager prefix collisions (#5349)', () => {
  const contacts = [
    { publicKey: A, advType: MeshCoreDeviceType.REPEATER, advName: 'Rpt A' },
    { publicKey: B, advType: MeshCoreDeviceType.REPEATER, advName: 'Rpt B' },
    { publicKey: C, advType: MeshCoreDeviceType.COMPANION, advName: 'Chat C' },
    { publicKey: D, advType: MeshCoreDeviceType.REPEATER, advName: 'Rpt D' },
  ];

  describe('resolveContactByPrefix', () => {
    it('resolves a 6-byte prefix to its single contact', () => {
      const m = makeManager(contacts);
      expect(m.resolveContactByPrefix(A.substring(0, 12))?.advName).toBe('Rpt A');
      expect(m.resolveContactByPrefix(B.substring(0, 12))?.advName).toBe('Rpt B');
    });

    it('returns undefined for an ambiguous 1-byte prefix instead of the first match', () => {
      const m = makeManager(contacts);
      expect(m.resolveContactByPrefix('57')).toBeUndefined();
    });

    it('returns undefined for an ambiguous 2-byte prefix', () => {
      const m = makeManager(contacts);
      expect(m.resolveContactByPrefix('5708')).toBeUndefined();
    });

    it('resolves a prefix that is unique at 3 bytes', () => {
      const m = makeManager(contacts);
      expect(m.resolveContactByPrefix('5710cc')?.advName).toBe('Chat C');
    });

    it('still returns an exact full-key hit', () => {
      const m = makeManager(contacts);
      expect(m.resolveContactByPrefix(D)?.advName).toBe('Rpt D');
    });

    it('is case-insensitive on the prefix', () => {
      const m = makeManager(contacts);
      expect(m.resolveContactByPrefix('5708AA')?.advName).toBe('Rpt A');
    });

    it('returns undefined for an empty prefix', () => {
      const m = makeManager(contacts);
      expect(m.resolveContactByPrefix('')).toBeUndefined();
    });
  });

  describe('resolveContactsByPrefix', () => {
    it('returns every contact sharing the prefix', () => {
      const m = makeManager(contacts);
      expect(m.resolveContactsByPrefix('57').map((c) => c.advName).sort())
        .toEqual(['Chat C', 'Rpt A', 'Rpt B', 'Rpt D']);
      expect(m.resolveContactsByPrefix('5708').map((c) => c.advName).sort())
        .toEqual(['Rpt A', 'Rpt B']);
    });

    it('returns [] for an empty prefix', () => {
      const m = makeManager(contacts);
      expect(m.resolveContactsByPrefix('')).toEqual([]);
    });
  });

  describe('nameForRelayHash (route hop naming)', () => {
    it('does not name a 1-byte hop shared by two repeaters', () => {
      const m = makeManager(contacts);
      expect(m.nameForRelayHash('57')).toBeNull();
    });

    it('names a hop when only one REPEATER owns it (a chat node sharing it is ignored)', () => {
      const m = makeManager(contacts);
      // 5710 → Chat C (companion) + Rpt D (repeater): only D can be a relay.
      expect(m.nameForRelayHash('5710')).toBe('Rpt D');
    });

    it('does not name a 2-byte hop shared by two repeaters', () => {
      const m = makeManager(contacts);
      expect(m.nameForRelayHash('5708')).toBeNull();
    });

    it('names a 3-byte hop that is unique', () => {
      const m = makeManager(contacts);
      expect(m.nameForRelayHash('5708bb')).toBe('Rpt B');
    });

    it('returns null when nothing matches', () => {
      const m = makeManager(contacts);
      expect(m.nameForRelayHash('ff')).toBeNull();
    });
  });
});
