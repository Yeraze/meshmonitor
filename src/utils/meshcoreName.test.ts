import { describe, it, expect } from 'vitest';
import {
  sanitizeMeshCoreName,
  isGarbageMeshCoreName,
  isCorruptMeshCoreContactRecord,
} from './meshcoreName.js';
import { CORRUPT_CONTACT_FIXTURES, REAL_NAME_FIXTURES } from './meshcoreName.fixtures.js';

/**
 * Decode name bytes the way meshcore.js BufferReader.readCString(32) does:
 * stop at the first NUL, then a lenient (non-fatal) UTF-8 TextDecoder.
 */
function readCString(hex: string): string {
  const bytes = Buffer.from(hex, 'hex');
  const nul = bytes.indexOf(0);
  return new TextDecoder().decode(nul === -1 ? bytes : bytes.subarray(0, nul));
}

// Name fields captured from corrupt contact rows in a live dev DB (serial
// companion on /dev/ttyUSB2). Each is the stored UTF-8 of the decoded name.
const CORRUPT_NAMES_HEX = [
  '7c02', // "|\x02" — pubkey 8f6ef823…"CS187 SC Solar" spliced frame
  '02',
  '521c2d23efbfbdefbfbd78efbfbdefbfbdefbfbdefbfbdc4beefbfbd02',
  'efbfbd01393827efbfbdefbfbd32546a3eefbfbd',
  'efbfbd', // lone U+FFFD
  'efbfbdefbfbd01',
];

describe('isGarbageMeshCoreName', () => {
  it.each(CORRUPT_NAMES_HEX)('flags corrupt name bytes %s', (hex) => {
    expect(isGarbageMeshCoreName(Buffer.from(hex, 'hex').toString('utf8'))).toBe(true);
  });

  it('accepts ordinary and emoji names', () => {
    expect(isGarbageMeshCoreName('Coconut Grove Rptr')).toBe(false);
    expect(isGarbageMeshCoreName('Base \u{1F3E0}')).toBe(false);
    expect(isGarbageMeshCoreName('Ωmega · Ñode')).toBe(false);
    expect(isGarbageMeshCoreName('')).toBe(false);
    expect(isGarbageMeshCoreName(null)).toBe(false);
  });

  it('accepts a name whose trailing emoji the sender truncated', () => {
    // "Dvynsoul GAT562 Base " + first 3 bytes of a 4-byte emoji.
    const name = readCString(Buffer.from('Dvynsoul GAT562 Base ').toString('hex') + 'f09f8f');
    expect(name.endsWith('\ufffd')).toBe(true);
    expect(isGarbageMeshCoreName(name)).toBe(false);
  });
});

describe('sanitizeMeshCoreName', () => {
  it('drops a truncated trailing multi-byte char', () => {
    // Exact stored bytes from the live DB row.
    const stored = Buffer.from('4476796e736f756c20474154353632204261736520efbfbd', 'hex').toString('utf8');
    expect(sanitizeMeshCoreName(stored)).toBe('Dvynsoul GAT562 Base');
  });

  it('cuts at the first NUL of an untrimmed fixed-width field', () => {
    expect(sanitizeMeshCoreName('Repeater\u0000\u0000ÿjunk')).toBe('Repeater');
  });

  it('turns tab/CR/LF into spaces and trims', () => {
    expect(sanitizeMeshCoreName(' My\tNode\n ')).toBe('My Node');
  });

  it('discards a name holding other control characters', () => {
    expect(sanitizeMeshCoreName('My\u0007Node')).toBeNull();
  });

  it('discards a name with an undecodable byte before the tail', () => {
    expect(sanitizeMeshCoreName('ab\ufffdcd')).toBeNull();
  });

  it.each(CORRUPT_NAMES_HEX)('reduces corrupt bytes %s to null', (hex) => {
    expect(sanitizeMeshCoreName(Buffer.from(hex, 'hex').toString('utf8'))).toBeNull();
  });

  it('returns null when nothing printable remains', () => {
    expect(sanitizeMeshCoreName('\ufffd')).toBeNull();
    expect(sanitizeMeshCoreName('\u0002')).toBeNull();
    expect(sanitizeMeshCoreName('\ufffd\ufffd\u0001')).toBeNull();
    expect(sanitizeMeshCoreName('   ')).toBeNull();
    expect(sanitizeMeshCoreName(undefined)).toBeNull();
  });

  it('leaves good names untouched', () => {
    expect(sanitizeMeshCoreName('Base \u{1F3E0}')).toBe('Base \u{1F3E0}');
    expect(sanitizeMeshCoreName('KQ4 Mobile')).toBe('KQ4 Mobile');
  });
});

describe('isCorruptMeshCoreContactRecord', () => {
  it('rejects an adv_type outside 0..4', () => {
    // Types seen on corrupt rows: 79, 115, 76, 111, 48, 101, 67, 45.
    for (const t of [79, 115, 45, 5, -1]) {
      expect(isCorruptMeshCoreContactRecord({ adv_name: 'ok', adv_type: t })).toMatch(/adv_type/);
    }
  });

  it('rejects a binary name', () => {
    expect(isCorruptMeshCoreContactRecord({ adv_name: '|\u0002', adv_type: 2 })).toMatch(/name/);
    expect(isCorruptMeshCoreContactRecord({ name: '\ufffd', adv_type: 1 })).toMatch(/name/);
  });

  it('accepts real records, including nameless and truncated-emoji ones', () => {
    expect(isCorruptMeshCoreContactRecord({ adv_name: 'Repeater', adv_type: 2 })).toBeNull();
    expect(isCorruptMeshCoreContactRecord({ adv_name: '', adv_type: 0 })).toBeNull();
    expect(isCorruptMeshCoreContactRecord({})).toBeNull();
    expect(isCorruptMeshCoreContactRecord({ adv_name: 'Base \ufffd', adv_type: 2 })).toBeNull();
  });
});

describe('field fixtures from the dev rig', () => {
  const decode = (hex: string) => Buffer.from(hex, 'hex').toString('utf8');

  it.each(CORRUPT_CONTACT_FIXTURES)('rejects corrupt record $key ($nameHex, type $advType)', (fx) => {
    const name = fx.nameHex === null ? undefined : decode(fx.nameHex);
    expect(isCorruptMeshCoreContactRecord({ adv_name: name, adv_type: fx.advType })).not.toBeNull();
    if (name !== undefined) expect(sanitizeMeshCoreName(name)).toBeNull();
  });

  it.each(REAL_NAME_FIXTURES)('keeps real name $clean', ({ nameHex, clean }) => {
    const name = decode(nameHex);
    expect(isCorruptMeshCoreContactRecord({ adv_name: name, adv_type: 1 })).toBeNull();
    expect(sanitizeMeshCoreName(name)).toBe(clean);
  });

  it('rejects the swallowed frame header on its own and after printable chars', () => {
    // '>' + 0x94 (length 148) + 0x00: the header of the next Contact frame.
    const tail = new TextDecoder().decode(Uint8Array.from([0x6a, 0x3e, 0x94]));
    expect(tail).toBe('j>\ufffd');
    for (const n of ['>\ufffd', tail, '\u00b7j>\ufffd', '|j>\ufffd', '%\ufffdj>\ufffd']) {
      expect(isGarbageMeshCoreName(n)).toBe(true);
      expect(sanitizeMeshCoreName(n)).toBeNull();
    }
  });

  it('still accepts a plain ">" inside a real name', () => {
    expect(sanitizeMeshCoreName('Rptr > North')).toBe('Rptr > North');
    expect(isGarbageMeshCoreName('Rptr >')).toBe(false);
  });
});
