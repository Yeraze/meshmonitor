import { describe, it, expect } from 'vitest';
import {
  extractMeshCoreContactTokens,
  formatMeshCoreContactToken,
  isMeshCoreContactTokenType,
  parseMeshCoreContactToken,
  splitMeshCoreContactTokens,
} from './meshcoreContactToken';

const KEY_LOWER = 'a1b2c3d4e5f60718293a4b5c6d7e8f90' + '0123456789abcdef0123456789abcdef';
const KEY_UPPER = KEY_LOWER.toUpperCase();

describe('parseMeshCoreContactToken', () => {
  it('parses a companion token and lower-cases the key', () => {
    expect(parseMeshCoreContactToken(`<${KEY_UPPER}:1:Alice>`)).toEqual({
      publicKey: KEY_LOWER,
      type: 1,
      name: 'Alice',
    });
  });

  it('reads the key in any case', () => {
    expect(parseMeshCoreContactToken(`<${KEY_LOWER}:2:Hilltop RPT>`)?.publicKey).toBe(KEY_LOWER);
    const mixed = KEY_LOWER.slice(0, 32) + KEY_UPPER.slice(32);
    expect(parseMeshCoreContactToken(`<${mixed}:3:Room>`)?.publicKey).toBe(KEY_LOWER);
  });

  it('accepts types 1, 2 and 3', () => {
    expect(parseMeshCoreContactToken(`<${KEY_UPPER}:1:a>`)?.type).toBe(1);
    expect(parseMeshCoreContactToken(`<${KEY_UPPER}:2:a>`)?.type).toBe(2);
    expect(parseMeshCoreContactToken(`<${KEY_UPPER}:3:a>`)?.type).toBe(3);
  });

  it('keeps a ":" inside the name (split at most twice)', () => {
    expect(parseMeshCoreContactToken(`<${KEY_UPPER}:1:Base: North:2>`)?.name).toBe('Base: North:2');
  });

  it('keeps unicode in the name and trims surrounding whitespace', () => {
    expect(parseMeshCoreContactToken(`<${KEY_UPPER}:1:  Zoë 📡  >`)?.name).toBe('Zoë 📡');
  });

  it.each([
    ['63-char key', `<${KEY_UPPER.slice(1)}:1:Alice>`],
    ['65-char key', `<${KEY_UPPER}A:1:Alice>`],
    ['non-hex key', `<${'G'.repeat(64)}:1:Alice>`],
    ['type 0 (ADV_TYPE_NONE)', `<${KEY_UPPER}:0:Alice>`],
    ['type 4 (sensor)', `<${KEY_UPPER}:4:Alice>`],
    ['type 11', `<${KEY_UPPER}:11:Alice>`],
    ['negative type', `<${KEY_UPPER}:-1:Alice>`],
    ['missing type', `<${KEY_UPPER}::Alice>`],
    ['empty name', `<${KEY_UPPER}:1:>`],
    ['blank name', `<${KEY_UPPER}:1:   >`],
    ['missing brackets', `${KEY_UPPER}:1:Alice`],
    ['extra text', `hi <${KEY_UPPER}:1:Alice>`],
  ])('rejects %s', (_label, input) => {
    expect(parseMeshCoreContactToken(input)).toBeNull();
  });
});

describe('extractMeshCoreContactTokens', () => {
  it('finds a token inside a sentence with its offsets', () => {
    const text = `meet <${KEY_UPPER}:1:Alice> today`;
    const found = extractMeshCoreContactTokens(text);
    expect(found).toHaveLength(1);
    expect(found[0].raw).toBe(`<${KEY_UPPER}:1:Alice>`);
    expect(text.slice(found[0].start, found[0].end)).toBe(found[0].raw);
  });

  it('finds several tokens in one message', () => {
    const other = 'f'.repeat(64);
    const text = `<${KEY_UPPER}:1:Alice> and <${other}:2:Ridge>`;
    const found = extractMeshCoreContactTokens(text);
    expect(found.map((m) => m.token.name)).toEqual(['Alice', 'Ridge']);
    expect(found[1].token.type).toBe(2);
  });

  it('skips malformed tokens and keeps the valid ones', () => {
    const text = `<${KEY_UPPER}:4:Sensor> <${KEY_UPPER}:3:Room> <${KEY_UPPER}:1:  >`;
    const found = extractMeshCoreContactTokens(text);
    expect(found).toHaveLength(1);
    expect(found[0].token.name).toBe('Room');
  });

  it('returns nothing for plain text', () => {
    expect(extractMeshCoreContactTokens('no tokens <here>')).toEqual([]);
    expect(extractMeshCoreContactTokens('')).toEqual([]);
  });

  it('is safe to call repeatedly (no shared regex state)', () => {
    const text = `<${KEY_UPPER}:1:Alice>`;
    expect(extractMeshCoreContactTokens(text)).toHaveLength(1);
    expect(extractMeshCoreContactTokens(text)).toHaveLength(1);
  });
});

describe('formatMeshCoreContactToken', () => {
  it('writes the key in upper case', () => {
    expect(formatMeshCoreContactToken({ publicKey: KEY_LOWER, type: 1, name: 'Alice' }))
      .toBe(`<${KEY_UPPER}:1:Alice>`);
  });

  it('strips ">" from the name', () => {
    expect(formatMeshCoreContactToken({ publicKey: KEY_LOWER, type: 2, name: 'A>B>' }))
      .toBe(`<${KEY_UPPER}:2:AB>`);
  });

  it('turns line breaks into spaces', () => {
    expect(formatMeshCoreContactToken({ publicKey: KEY_LOWER, type: 1, name: 'A\nB' }))
      .toBe(`<${KEY_UPPER}:1:A B>`);
  });

  it.each([
    ['short key', { publicKey: 'abc', type: 1, name: 'A' }],
    ['type 0', { publicKey: KEY_LOWER, type: 0, name: 'A' }],
    ['type 4', { publicKey: KEY_LOWER, type: 4, name: 'A' }],
    ['empty name', { publicKey: KEY_LOWER, type: 1, name: '' }],
    ['name of only ">"', { publicKey: KEY_LOWER, type: 1, name: '>>' }],
    ['repeater placeholder key', { publicKey: 'repeater', type: 1, name: 'A' }],
  ])('returns null for %s', (_label, input) => {
    expect(formatMeshCoreContactToken(input)).toBeNull();
  });

  it('round-trips through the parser, including ":" in the name', () => {
    const token = formatMeshCoreContactToken({ publicKey: KEY_LOWER, type: 3, name: 'Club: Room 1' });
    expect(token).not.toBeNull();
    expect(parseMeshCoreContactToken(token!)).toEqual({ publicKey: KEY_LOWER, type: 3, name: 'Club: Room 1' });
  });

  it('parses a token the way MeshCore One writes it (upper-case key)', () => {
    // MC1 emits `<UPPERHEX:type:name>`; MeshMonitor must read it unchanged.
    const mc1 = `<${KEY_UPPER}:1:matt's T-Deck>`;
    expect(parseMeshCoreContactToken(mc1)).toEqual({ publicKey: KEY_LOWER, type: 1, name: "matt's T-Deck" });
  });
});

describe('splitMeshCoreContactTokens', () => {
  it('splits text around tokens', () => {
    const segs = splitMeshCoreContactTokens(`a <${KEY_UPPER}:1:Alice> b`);
    expect(segs.map((s) => s.kind)).toEqual(['text', 'token', 'text']);
    expect(segs[0]).toEqual({ kind: 'text', text: 'a ' });
    expect(segs[2]).toEqual({ kind: 'text', text: ' b' });
  });

  it('returns one text segment when there is no token', () => {
    expect(splitMeshCoreContactTokens('hello')).toEqual([{ kind: 'text', text: 'hello' }]);
  });
});

describe('isMeshCoreContactTokenType', () => {
  it('accepts only 1, 2 and 3', () => {
    expect([0, 1, 2, 3, 4, '1', null].map(isMeshCoreContactTokenType))
      .toEqual([false, true, true, true, false, false, false]);
  });
});
