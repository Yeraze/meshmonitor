/**
 * #5292 — which source's position represents a node heard by several.
 *
 * The reported failure: node PARC sat at two positions kilometres apart on the
 * unified map, alternating. They were a 14-bit (±1.5 km) and a 13-bit (±2.9 km)
 * rendering of ONE physical spot; the 14-bit point falls inside the 13-bit grid
 * cell. Nothing moved. The coarse row simply kept becoming "newest by
 * lastHeard" whenever its source heard unrelated traffic.
 */
import { describe, it, expect } from 'vitest';
import { pickPositionRecord, SAME_OBSERVATION_WINDOW_MS } from './positionSelection';

const T = 1_760_000_000_000;

describe('pickPositionRecord (#5292)', () => {
  it('returns undefined when nothing has a position', () => {
    expect(pickPositionRecord([])).toBeUndefined();
  });

  it('ignores lastHeard chatter on the coarser record', () => {
    // The reported bug, exactly: the coarse source heard telemetry seconds ago
    // and so has the newest lastHeard, but its POSITION is the same observation
    // as the fine one.
    const fine = { latitude: 44.28923, positionPrecisionBits: 14, positionTimestamp: T, lastHeard: T / 1000 - 600 };
    const coarse = { latitude: 44.2761216, positionPrecisionBits: 13, positionTimestamp: T - 5_000, lastHeard: T / 1000 };
    expect(pickPositionRecord([coarse, fine])).toBe(fine);
    // Order of the input must not change the answer.
    expect(pickPositionRecord([fine, coarse])).toBe(fine);
  });

  it('prefers the finer precision for observations inside the window', () => {
    const coarse = { positionPrecisionBits: 13, positionTimestamp: T };
    const fine = { positionPrecisionBits: 16, positionTimestamp: T - SAME_OBSERVATION_WINDOW_MS + 1_000 };
    expect(pickPositionRecord([coarse, fine])).toBe(fine);
  });

  it('lets a genuinely newer fix win once it is outside the window', () => {
    // A node that moved and re-transmitted, heard only by the coarse source.
    // Showing its old position because it was finer would be worse.
    const fine = { positionPrecisionBits: 16, positionTimestamp: T };
    const coarse = { positionPrecisionBits: 13, positionTimestamp: T + SAME_OBSERVATION_WINDOW_MS + 1_000 };
    expect(pickPositionRecord([fine, coarse])).toBe(coarse);
  });

  it('breaks a precision tie inside the window by the newer observation', () => {
    const older = { positionPrecisionBits: 14, positionTimestamp: T };
    const newer = { positionPrecisionBits: 14, positionTimestamp: T + 1_000 };
    expect(pickPositionRecord([older, newer])).toBe(newer);
    expect(pickPositionRecord([newer, older])).toBe(newer);
  });

  it('treats a missing precision as coarser than any known precision', () => {
    const unknown = { positionTimestamp: T };
    const known = { positionPrecisionBits: 13, positionTimestamp: T - 1_000 };
    expect(pickPositionRecord([unknown, known])).toBe(known);
  });

  it('falls back to lastHeard SECONDS when a row predates positionTimestamp', () => {
    // Mixing the units silently would put one of these ~56,000 years from the
    // other, so the older row would always win or always lose.
    const legacyOld = { lastHeard: T / 1000 - 86_400 };
    const legacyNew = { lastHeard: T / 1000 };
    expect(pickPositionRecord([legacyOld, legacyNew])).toBe(legacyNew);
  });

  it('prefers a row with a position timestamp over one with only lastHeard of the same age', () => {
    const withTs = { positionPrecisionBits: 16, positionTimestamp: T };
    const legacy = { positionPrecisionBits: 13, lastHeard: T / 1000 };
    expect(pickPositionRecord([legacy, withTs])).toBe(withTs);
  });

  it('returns the only candidate even when it carries no timestamps at all', () => {
    const lone = { latitude: 1, longitude: 2 };
    expect(pickPositionRecord([lone])).toBe(lone);
  });
});
