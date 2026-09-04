/**
 * Meshtastic 2.8 node-number identity-change detection (issue #5032).
 *
 * These tests pin the *decisions*, not the plumbing: which pairs get reported,
 * which get vetoed, and how confident the report is allowed to be. The whole
 * point of the feature is that it never mutates anything, so a false positive
 * here becomes an operator merging two unrelated nodes' histories by hand.
 */
import { describe, it, expect } from 'vitest';
import { crc32 as zlibCrc32 } from 'node:zlib';
import {
  findIdentityChanges,
  firmwareIs28OrLater,
  IDENTITY_CHANGE_DEFAULTS,
} from './nodeIdentityChangeService.js';
import { nodeNumFromPublicKey } from '../../services/lowEntropyKeyService.js';
import type { NodeIdentityRow } from '../../db/repositories/nodes.js';

const NOW = 1_800_000_000; // fixed clock, unix seconds
const HOUR = 3600;
const DAY = 24 * HOUR;

/** A valid 32-byte key, base64. Its CRC-32 is the node's 2.8 identity. */
const KEY_A = Buffer.alloc(32, 0xab).toString('base64');
const KEY_B = (() => {
  const b = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) b[i] = i + 1;
  return b.toString('base64');
})();

const DERIVED_A = nodeNumFromPublicKey(KEY_A)!;
const DERIVED_B = nodeNumFromPublicKey(KEY_B)!;

function row(overrides: Partial<NodeIdentityRow> & { nodeNum: number }): NodeIdentityRow {
  return {
    nodeId: `!${overrides.nodeNum.toString(16).padStart(8, '0')}`,
    longName: null,
    shortName: null,
    publicKey: null,
    hwModel: null,
    firmwareVersion: null,
    lastHeard: null,
    createdAt: NOW,
    ...overrides,
  };
}

describe('nodeNumFromPublicKey — the firmware derivation this detector trusts', () => {
  it('matches zlib CRC-32 of the raw key bytes, not the base64 text', () => {
    // Pinned independently: if this drifts, every `derivedNodeNum` finding is
    // wrong and the detector would start pairing unrelated nodes.
    expect(DERIVED_A).toBe(zlibCrc32(Buffer.from(KEY_A, 'base64')) >>> 0);
    expect(DERIVED_A).toBe(3649751816);
    expect(DERIVED_B).toBe(2280057893);
  });
});

describe('findIdentityChanges — the firmware derivation (strongest signal)', () => {
  it("reports a pair when the old row's key CRC-32s to the new row's node number", () => {
    const upgradeAt = NOW - 2 * DAY;
    const rows = [
      // Pre-2.8: MAC-derived number, same key.
      row({
        nodeNum: 0x433d1ba4,
        publicKey: KEY_A,
        longName: 'Base Station',
        shortName: 'BASE',
        firmwareVersion: '2.7.11.ee68575',
        lastHeard: upgradeAt,
        createdAt: NOW - 200 * DAY,
      }),
      // Post-2.8: nodeNum == crc32(KEY_A).
      row({
        nodeNum: DERIVED_A,
        publicKey: KEY_A,
        longName: 'Base Station',
        shortName: 'BASE',
        firmwareVersion: '2.8.0.47db0e3',
        lastHeard: NOW - HOUR,
        createdAt: upgradeAt + 60,
      }),
    ];

    const { detections } = findIdentityChanges(rows, { nowSeconds: NOW });

    expect(detections).toHaveLength(1);
    const d = detections[0];
    expect(d.successor.nodeNum).toBe(DERIVED_A);
    expect(d.predecessor.nodeNum).toBe(0x433d1ba4);
    expect(d.basis).toBe('derivedNodeNum');
    expect(d.confidence).toBe('high');
    expect(d.derivedFromPredecessorKey).toBe(true);
    expect(d.successorNodeNumIsKeyDerived).toBe(true);
    expect(d.predecessorNodeNumIsKeyDerived).toBe(false);
    expect(d.successorFirmwareIs28OrLater).toBe(true);
    expect(d.otherCandidateCount).toBe(0);
    // The key itself must never leave the server.
    expect(d.successor).not.toHaveProperty('publicKey');
    expect(d.successor.hasPublicKey).toBe(true);
  });

  it('still fires when the operator renamed the node during the upgrade', () => {
    // The whole value of the CRC signal: it needs no name agreement at all.
    const upgradeAt = NOW - 3 * DAY;
    const rows = [
      row({ nodeNum: 111, publicKey: KEY_A, longName: 'Old Name', shortName: 'OLD', lastHeard: upgradeAt, createdAt: NOW - 100 * DAY }),
      row({ nodeNum: DERIVED_A, publicKey: KEY_A, longName: 'Brand New Name', shortName: 'NEW', lastHeard: NOW - HOUR, createdAt: upgradeAt }),
    ];

    const { detections } = findIdentityChanges(rows, { nowSeconds: NOW });
    expect(detections).toHaveLength(1);
    expect(detections[0].basis).toBe('derivedNodeNum');
    expect(detections[0].nameMatches).toBe(false);
  });
});

describe('findIdentityChanges — public-key and name fallbacks', () => {
  it('falls back to a plain public-key match when the key cannot be CRC-checked', () => {
    // A 16-byte key never CRC-32s to a node number (nodeNumFromPublicKey
    // requires exactly 32 bytes), so the derived path cannot apply — but two
    // rows sharing it are still one node, because 2.8 preserves the keypair.
    const shortKey = Buffer.alloc(16, 0x7).toString('base64');
    expect(nodeNumFromPublicKey(shortKey)).toBeNull();

    const upgradeAt = NOW - 2 * DAY;
    const rows = [
      row({ nodeNum: 111, publicKey: shortKey, lastHeard: upgradeAt, createdAt: NOW - 90 * DAY }),
      row({ nodeNum: 222, publicKey: shortKey, lastHeard: NOW - HOUR, createdAt: upgradeAt }),
    ];

    const { detections } = findIdentityChanges(rows, { nowSeconds: NOW });
    expect(detections).toHaveLength(1);
    expect(detections[0].basis).toBe('publicKey');
    expect(detections[0].confidence).toBe('high');
  });

  it('does NOT report a name-only match by default', () => {
    // The default report is key-verified only. Two rows that share a long and a
    // short name are indistinguishable from two genuinely different nodes with
    // the same name, and this list is what an operator merges history on.
    const upgradeAt = NOW - 2 * DAY;
    const rows = [
      row({ nodeNum: 111, longName: 'Hilltop Relay', shortName: 'HILL', lastHeard: upgradeAt, createdAt: NOW - 90 * DAY }),
      row({ nodeNum: 222, longName: 'Hilltop Relay', shortName: 'HILL', lastHeard: NOW - HOUR, createdAt: upgradeAt }),
    ];

    expect(findIdentityChanges(rows, { nowSeconds: NOW }).detections).toHaveLength(0);
  });

  it('still finds the name match when a caller explicitly opts in', () => {
    // The signal is kept one boolean away — it is the only one available for a
    // keyless node — but nothing in the product turns it on.
    const upgradeAt = NOW - 2 * DAY;
    const rows = [
      row({ nodeNum: 111, longName: 'Hilltop Relay', shortName: 'HILL', lastHeard: upgradeAt, createdAt: NOW - 90 * DAY }),
      row({ nodeNum: 222, longName: 'Hilltop Relay', shortName: 'HILL', lastHeard: NOW - HOUR, createdAt: upgradeAt }),
    ];

    const { detections } = findIdentityChanges(rows, { nowSeconds: NOW, includeNameBasis: true });
    expect(detections).toHaveLength(1);
    expect(detections[0].basis).toBe('name');
    // A name match is a guess, and must never claim otherwise.
    expect(detections[0].confidence).toBe('medium');
  });

  it('matches names case-insensitively but requires BOTH names to agree', () => {
    const upgradeAt = NOW - 2 * DAY;
    const base = { lastHeard: upgradeAt, createdAt: NOW - 90 * DAY };
    const casing = findIdentityChanges(
      [
        row({ nodeNum: 111, longName: 'hilltop relay', shortName: 'hill', ...base }),
        row({ nodeNum: 222, longName: 'Hilltop Relay', shortName: 'HILL', lastHeard: NOW - HOUR, createdAt: upgradeAt }),
      ],
      { nowSeconds: NOW, includeNameBasis: true },
    );
    expect(casing.detections).toHaveLength(1);

    const shortNameDiffers = findIdentityChanges(
      [
        row({ nodeNum: 111, longName: 'Hilltop Relay', shortName: 'HIL1', ...base }),
        row({ nodeNum: 222, longName: 'Hilltop Relay', shortName: 'HIL2', lastHeard: NOW - HOUR, createdAt: upgradeAt }),
      ],
      { nowSeconds: NOW, includeNameBasis: true },
    );
    expect(shortNameDiffers.detections).toHaveLength(0);
  });

  it('ignores firmware-default "Node !xxxxxxxx" long names', () => {
    // Otherwise every node we have no NodeInfo for pairs with every other one.
    // Asserted with the name signal explicitly ON, so the test proves the
    // placeholder guard rather than the default filter.
    const upgradeAt = NOW - 2 * DAY;
    const rows = [
      row({ nodeNum: 0x433d1ba4, longName: 'Node !433d1ba4', shortName: '1ba4', lastHeard: upgradeAt, createdAt: NOW - 90 * DAY }),
      row({ nodeNum: 0x11223344, longName: 'Node !433d1ba4', shortName: '1ba4', lastHeard: NOW - HOUR, createdAt: upgradeAt }),
    ];

    expect(
      findIdentityChanges(rows, { nowSeconds: NOW, includeNameBasis: true }).detections,
    ).toHaveLength(0);
  });
});

describe('findIdentityChanges — vetoes and false-positive guards', () => {
  it('vetoes a name match when the two rows carry DIFFERENT public keys', () => {
    // Two real neighbours that happen to share a name. Under 2.8 the number is
    // a function of the key, so different keys means different nodes, full
    // stop — this is the guard that keeps the feature from corrupting history.
    const upgradeAt = NOW - 2 * DAY;
    const rows = [
      row({ nodeNum: 111, publicKey: KEY_A, longName: 'Repeater', shortName: 'RPTR', lastHeard: upgradeAt, createdAt: NOW - 90 * DAY }),
      row({ nodeNum: 222, publicKey: KEY_B, longName: 'Repeater', shortName: 'RPTR', lastHeard: NOW - HOUR, createdAt: upgradeAt }),
    ];

    expect(findIdentityChanges(rows, { nowSeconds: NOW }).detections).toHaveLength(0);
  });

  it('does not report while the predecessor is still transmitting', () => {
    // Two live rows sharing a key is the key-cloning case, not an upgrade —
    // it belongs to the duplicate-key security warning, not to this notice.
    const rows = [
      row({ nodeNum: 111, publicKey: KEY_A, lastHeard: NOW - 60, createdAt: NOW - 90 * DAY }),
      row({ nodeNum: DERIVED_A, publicKey: KEY_A, lastHeard: NOW - 30, createdAt: NOW - 2 * DAY }),
    ];

    expect(findIdentityChanges(rows, { nowSeconds: NOW }).detections).toHaveLength(0);
  });

  it('does not report when the predecessor outlived the successor', () => {
    // Wrong direction for a handover: the "new" row went quiet first.
    const rows = [
      row({ nodeNum: 111, publicKey: KEY_A, lastHeard: NOW - 2 * DAY, createdAt: NOW - 90 * DAY }),
      row({ nodeNum: DERIVED_A, publicKey: KEY_A, lastHeard: NOW - 5 * DAY, createdAt: NOW - 6 * DAY }),
    ];

    expect(findIdentityChanges(rows, { nowSeconds: NOW }).detections).toHaveLength(0);
  });

  it('does not report a successor that is no longer new', () => {
    // Past the appear window the notice retires, so an old name collision does
    // not become a permanent badge.
    const old = NOW - (IDENTITY_CHANGE_DEFAULTS.appearWindowSeconds + DAY);
    const rows = [
      row({ nodeNum: 111, publicKey: KEY_A, lastHeard: old - HOUR, createdAt: old - 90 * DAY }),
      row({ nodeNum: DERIVED_A, publicKey: KEY_A, lastHeard: NOW - HOUR, createdAt: old }),
    ];

    expect(findIdentityChanges(rows, { nowSeconds: NOW }).detections).toHaveLength(0);
  });

  it('does not report when the predecessor died long before the successor appeared', () => {
    // Beyond quietLookback the two events are unrelated, whatever the names say.
    const appeared = NOW - DAY;
    const rows = [
      row({
        nodeNum: 111,
        longName: 'Hilltop Relay',
        shortName: 'HILL',
        lastHeard: appeared - (IDENTITY_CHANGE_DEFAULTS.quietLookbackSeconds + DAY),
        createdAt: NOW - 300 * DAY,
      }),
      row({ nodeNum: 222, longName: 'Hilltop Relay', shortName: 'HILL', lastHeard: NOW - HOUR, createdAt: appeared }),
    ];

    // Name signal ON, so the zero comes from the lookback gate rather than from
    // the default key-verified-only filter.
    expect(
      findIdentityChanges(rows, { nowSeconds: NOW, includeNameBasis: true }).detections,
    ).toHaveLength(0);
  });

  it('does not report a predecessor that has only just fallen silent', () => {
    // Inside minQuiet it is indistinguishable from a node between beacons.
    const rows = [
      row({ nodeNum: 111, publicKey: KEY_A, lastHeard: NOW - HOUR, createdAt: NOW - 90 * DAY }),
      row({ nodeNum: DERIVED_A, publicKey: KEY_A, lastHeard: NOW - 60, createdAt: NOW - 2 * HOUR }),
    ];

    expect(findIdentityChanges(rows, { nowSeconds: NOW }).detections).toHaveLength(0);
  });

  it('handles createdAt stored in milliseconds, as the nodes table actually stores it', () => {
    // `nodes.createdAt` is written as Date.now() (ms) while `lastHeard` is unix
    // seconds. Comparing them raw makes every handover gap look like ~56,000
    // years, and every detection silently vanishes — which is exactly what
    // happened the first time this was wired to the real table.
    const upgradeAt = NOW - 2 * DAY;
    const rows = [
      row({ nodeNum: 111, publicKey: KEY_A, lastHeard: upgradeAt, createdAt: (NOW - 90 * DAY) * 1000 }),
      row({ nodeNum: DERIVED_A, publicKey: KEY_A, lastHeard: NOW - HOUR, createdAt: upgradeAt * 1000 }),
    ];

    const { detections } = findIdentityChanges(rows, { nowSeconds: NOW });
    expect(detections).toHaveLength(1);
    // …and the payload is normalised to seconds, matching `lastHeard`.
    expect(detections[0].successor.createdAt).toBe(upgradeAt);
    expect(detections[0].handoverGapSeconds).toBe(0);
  });

  it('never pairs a node with itself', () => {
    const rows = [row({ nodeNum: DERIVED_A, publicKey: KEY_A, lastHeard: NOW - HOUR, createdAt: NOW - DAY })];
    expect(findIdentityChanges(rows, { nowSeconds: NOW }).detections).toHaveLength(0);
  });
});

describe('findIdentityChanges — ambiguity is surfaced, not hidden', () => {
  it('picks the strongest candidate and counts the rest', () => {
    const upgradeAt = NOW - 2 * DAY;
    const rows = [
      // Weaker: name-only match, heard more recently than the key match.
      row({ nodeNum: 111, longName: 'Twin', shortName: 'TWIN', lastHeard: upgradeAt, createdAt: NOW - 90 * DAY }),
      // Stronger: the CRC-verified predecessor, quieter for longer.
      row({ nodeNum: 222, publicKey: KEY_A, longName: 'Twin', shortName: 'TWIN', lastHeard: upgradeAt - HOUR, createdAt: NOW - 90 * DAY }),
      row({ nodeNum: DERIVED_A, publicKey: KEY_A, longName: 'Twin', shortName: 'TWIN', lastHeard: NOW - HOUR, createdAt: upgradeAt }),
    ];

    const withNames = findIdentityChanges(rows, { nowSeconds: NOW, includeNameBasis: true });
    expect(withNames.detections).toHaveLength(1);
    expect(withNames.detections[0].basis).toBe('derivedNodeNum');
    expect(withNames.detections[0].predecessor.nodeNum).toBe(222);
    // The operator must be able to see that the pick was not the only option.
    expect(withNames.detections[0].otherCandidateCount).toBe(1);

    // …but by default the name-only rival is filtered out BEFORE the count, so
    // the report does not imply an ambiguity no key evidence supports.
    const { detections } = findIdentityChanges(rows, { nowSeconds: NOW });
    expect(detections).toHaveLength(1);
    expect(detections[0].predecessor.nodeNum).toBe(222);
    expect(detections[0].otherCandidateCount).toBe(0);
  });

  it('breaks a tie between equal-strength candidates on most-recently-heard', () => {
    const upgradeAt = NOW - 2 * DAY;
    const rows = [
      row({ nodeNum: 111, longName: 'Twin', shortName: 'TWIN', lastHeard: upgradeAt - 5 * DAY, createdAt: NOW - 90 * DAY }),
      row({ nodeNum: 222, longName: 'Twin', shortName: 'TWIN', lastHeard: upgradeAt, createdAt: NOW - 90 * DAY }),
      row({ nodeNum: 333, longName: 'Twin', shortName: 'TWIN', lastHeard: NOW - HOUR, createdAt: upgradeAt }),
    ];

    const { detections } = findIdentityChanges(rows, { nowSeconds: NOW, includeNameBasis: true });
    expect(detections).toHaveLength(1);
    expect(detections[0].predecessor.nodeNum).toBe(222);
    expect(detections[0].otherCandidateCount).toBe(1);
  });

  it('reports newest handover first', () => {
    const rows = [
      row({ nodeNum: 111, longName: 'Alpha', shortName: 'ALFA', lastHeard: NOW - 20 * DAY, createdAt: NOW - 90 * DAY }),
      row({ nodeNum: 222, longName: 'Alpha', shortName: 'ALFA', lastHeard: NOW - HOUR, createdAt: NOW - 20 * DAY }),
      row({ nodeNum: 333, longName: 'Bravo', shortName: 'BRVO', lastHeard: NOW - 2 * DAY, createdAt: NOW - 90 * DAY }),
      row({ nodeNum: 444, longName: 'Bravo', shortName: 'BRVO', lastHeard: NOW - HOUR, createdAt: NOW - 2 * DAY }),
    ];

    const { detections } = findIdentityChanges(rows, { nowSeconds: NOW, includeNameBasis: true });
    expect(detections.map(d => d.successor.nodeNum)).toEqual([444, 222]);
  });
});

describe('firmwareIs28OrLater', () => {
  it.each([
    ['2.8.0.47db0e3', true],
    ['2.8.1', true],
    ['2.8', true],
    ['2.9.0', true],
    ['3.0.0', true],
    ['2.7.11.ee68575', false],
    ['2.7.20', false],
    ['1.9.9', false],
    ['not-a-version', false],
    ['', false],
    [null, false],
  ] as const)('%s → %s', (version, expected) => {
    expect(firmwareIs28OrLater(version)).toBe(expected);
  });
});
