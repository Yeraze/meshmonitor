/**
 * Beacon offer actionability (#4723).
 *
 * The card shows un-actionable offers rather than hiding them, so these reasons
 * are user-facing copy, not internal diagnostics — a wrong verdict either hides
 * a joinable network or invites the user to apply a configuration the radio
 * cannot use.
 */
import { describe, it, expect } from 'vitest';
import { assessBeaconOffer } from './beaconOfferActionability';
import { isPresetLegalForRegion } from '../configuration/constants';

describe('assessBeaconOffer', () => {
  it('accepts a plain channel offer', () => {
    expect(assessBeaconOffer({ offerChannelName: 'RegionMesh' })).toEqual({ actionable: true });
  });

  it('rejects a text-only beacon with a plain-language reason', () => {
    const r = assessBeaconOffer({ offerChannelName: null, offerRegion: null, offerPreset: null });
    expect(r.actionable).toBe(false);
    expect(r.reason).toMatch(/text only/i);
  });

  it('treats region 0 / preset 0 as a real offer, not "nothing"', () => {
    // The falsy-check bug: `!offer.offerRegion` would call this text-only.
    const r = assessBeaconOffer({ offerRegion: 0, offerPreset: 0 });
    // May legitimately be actionable (no reason at all) or rejected on
    // legality — but never dismissed as carrying no offer.
    expect(r.reason ?? '').not.toMatch(/text only/i);
  });

  it('treats a whitespace-only channel name as no channel', () => {
    const r = assessBeaconOffer({ offerChannelName: '   ' });
    expect(r.actionable).toBe(false);
    expect(r.reason).toMatch(/text only/i);
  });

  it('does not judge legality when only one of region/preset is offered', () => {
    // Neither alone constrains the other, so there is nothing to fit-check.
    expect(assessBeaconOffer({ offerRegion: 1 }).actionable).toBe(true);
    expect(assessBeaconOffer({ offerPreset: 0 }).actionable).toBe(true);
  });

  it('agrees with isPresetLegalForRegion across every region/preset pair it is given', () => {
    // The card must never contradict the picker used elsewhere in the app.
    for (const region of [0, 1, 2, 3, 4, 5]) {
      for (const preset of [0, 1, 3, 4, 5, 6, 7, 8]) {
        const legal = isPresetLegalForRegion(region, preset);
        const assessed = assessBeaconOffer({ offerRegion: region, offerPreset: preset });
        expect(assessed.actionable).toBe(legal);
        if (!legal) expect(assessed.reason).toMatch(/not legal/i);
      }
    }
  });

  it('names the offending preset and region in the reason', () => {
    // Find a genuinely illegal pair rather than hard-coding one, so this keeps
    // working if REGION_FREQ_INFO changes.
    let illegal: { region: number; preset: number } | null = null;
    for (const region of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
      for (const preset of [0, 1, 3, 4, 5, 6, 7, 8]) {
        if (!isPresetLegalForRegion(region, preset)) { illegal = { region, preset }; break; }
      }
      if (illegal) break;
    }
    if (!illegal) return; // no illegal pair in the current table — nothing to assert

    const r = assessBeaconOffer({ offerRegion: illegal.region, offerPreset: illegal.preset });
    expect(r.actionable).toBe(false);
    // The reason must be specific enough to act on, not just "invalid".
    expect(r.reason).toMatch(/bandwidth/i);
    expect(r.reason!.length).toBeGreaterThan(30);
  });
});
