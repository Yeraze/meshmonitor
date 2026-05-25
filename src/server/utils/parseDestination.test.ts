/**
 * Tests for `parseDestinationNum` — the shared destination parser used by
 * the DM / traceroute / position / nodeInfo / neighborInfo / telemetry
 * routes. Issue #3186 background: a 64-char publicKey string fed through
 * the previous `parseInt(_, 16)` parser produced ~2.7e+76 and crashed
 * downstream PG queries; the helper now routes long hex strings into a
 * publicKey lookup and rejects malformed input with `null`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseDestinationNum } from './parseDestination.js';
import { MAX_NODE_NUM } from '../constants/meshtastic.js';

type DbFacade = Parameters<typeof parseDestinationNum>[2];

function fakeDb(getNodeByPublicKey: ReturnType<typeof vi.fn>): DbFacade {
  return { nodes: { getNodeByPublicKey } } as unknown as DbFacade;
}

describe('parseDestinationNum', () => {
  let lookup: ReturnType<typeof vi.fn>;
  let db: DbFacade;

  beforeEach(() => {
    lookup = vi.fn();
    db = fakeDb(lookup);
  });

  // ---- numeric inputs ----
  it('passes through a valid numeric nodeNum unchanged', async () => {
    const result = await parseDestinationNum(123456, 'src-A', db);
    expect(result).toBe(123456);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('accepts the broadcast address (uint32 max)', async () => {
    expect(await parseDestinationNum(MAX_NODE_NUM, 'src-A', db)).toBe(MAX_NODE_NUM);
  });

  it('rejects out-of-range numeric input', async () => {
    expect(await parseDestinationNum(MAX_NODE_NUM + 1, 'src-A', db)).toBeNull();
    expect(await parseDestinationNum(-1, 'src-A', db)).toBeNull();
    expect(await parseDestinationNum(1.5, 'src-A', db)).toBeNull();
    expect(await parseDestinationNum(NaN, 'src-A', db)).toBeNull();
  });

  // ---- 8-char nodeId inputs ----
  it('parses an 8-char hex nodeId', async () => {
    expect(await parseDestinationNum('ad8c9eff', 'src-A', db)).toBe(0xad8c9eff);
  });

  it("strips a leading '!' from an 8-char nodeId", async () => {
    expect(await parseDestinationNum('!ad8c9eff', 'src-A', db)).toBe(0xad8c9eff);
  });

  it('is case-insensitive for hex nodeIds', async () => {
    expect(await parseDestinationNum('!AD8C9EFF', 'src-A', db)).toBe(0xad8c9eff);
  });

  it('trims surrounding whitespace', async () => {
    expect(await parseDestinationNum('  !ad8c9eff  ', 'src-A', db)).toBe(0xad8c9eff);
  });

  // ---- 64-char publicKey inputs ----
  it('resolves a 64-char publicKey to its stored nodeNum (issue #3186)', async () => {
    const hex64 = 'a'.repeat(64);
    const expectedBase64 = Buffer.from(hex64, 'hex').toString('base64');
    lookup.mockResolvedValueOnce({ nodeNum: 42, publicKey: expectedBase64 });

    const result = await parseDestinationNum(hex64, 'src-A', db);

    expect(result).toBe(42);
    expect(lookup).toHaveBeenCalledWith(expectedBase64, 'src-A');
  });

  it("strips a leading '!' on a publicKey input before lookup", async () => {
    const hex64 = 'b'.repeat(64);
    const expectedBase64 = Buffer.from(hex64, 'hex').toString('base64');
    lookup.mockResolvedValueOnce({ nodeNum: 7, publicKey: expectedBase64 });

    const result = await parseDestinationNum(`!${hex64}`, 'src-A', db);

    expect(result).toBe(7);
    expect(lookup).toHaveBeenCalledWith(expectedBase64, 'src-A');
  });

  it('returns null when the publicKey is not found', async () => {
    lookup.mockResolvedValueOnce(null);
    expect(await parseDestinationNum('c'.repeat(64), 'src-A', db)).toBeNull();
  });

  it('returns null when the publicKey lookup yields a stored node with an invalid nodeNum', async () => {
    // Defense-in-depth: a corrupt row in the DB shouldn't leak garbage downstream.
    lookup.mockResolvedValueOnce({ nodeNum: 2.7130620829267897e+76, publicKey: 'x' });
    expect(await parseDestinationNum('d'.repeat(64), 'src-A', db)).toBeNull();
  });

  // ---- malformed inputs ----
  it('returns null for a 9-char hex string (neither nodeId nor publicKey)', async () => {
    expect(await parseDestinationNum('ad8c9effe', 'src-A', db)).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('returns null for a string with non-hex characters', async () => {
    expect(await parseDestinationNum('zz8c9eff', 'src-A', db)).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('returns null for empty string and non-string non-number types', async () => {
    expect(await parseDestinationNum('', 'src-A', db)).toBeNull();
    expect(await parseDestinationNum(null, 'src-A', db)).toBeNull();
    expect(await parseDestinationNum(undefined, 'src-A', db)).toBeNull();
    expect(await parseDestinationNum({}, 'src-A', db)).toBeNull();
  });

  // ---- sourceId scoping ----
  it('forwards an undefined sourceId to the lookup', async () => {
    lookup.mockResolvedValueOnce({ nodeNum: 99, publicKey: 'x' });
    await parseDestinationNum('e'.repeat(64), undefined, db);
    expect(lookup).toHaveBeenCalledWith(expect.any(String), undefined);
  });
});
