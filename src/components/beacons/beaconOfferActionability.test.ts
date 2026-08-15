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

const joinable = { offerChannelName: 'RegionMesh', hasChannelKey: true };

describe('assessBeaconOffer', () => {
  it('accepts a channel offer that came with its key', () => {
    expect(assessBeaconOffer(joinable).actionable).toBe(true);
  });

  it('rejects a text-only beacon with a plain-language reason', () => {
    const r = assessBeaconOffer({ offerChannelName: null, offerRegion: null, offerPreset: null });
    expect(r.actionable).toBe(false);
    expect(r.reason).toMatch(/text only/i);
  });

  it('rejects a named channel with no key, rather than joining one that decrypts nothing', () => {
    // The whole reason the PSK is plumbed through: a name-only offer is not
    // joinable, and silently adding the channel would look like success.
    const r = assessBeaconOffer({ offerChannelName: 'RegionMesh', hasChannelKey: false });
    expect(r.actionable).toBe(false);
    expect(r.reason).toMatch(/did not include its key/i);
    expect(r.reason).toContain('RegionMesh');
  });

  it('treats a whitespace-only channel name as no channel', () => {
    const r = assessBeaconOffer({ offerChannelName: '   ', hasChannelKey: true });
    expect(r.actionable).toBe(false);
    expect(r.reason).toMatch(/text only/i);
  });

  it('distinguishes "advertises a mesh but no channel" from "text only"', () => {
    const r = assessBeaconOffer({ offerPreset: 0 });
    expect(r.actionable).toBe(false);
    expect(r.reason).toMatch(/no channel to join/i);
    expect(r.reason).not.toMatch(/text only/i);
  });

  describe('region 0 is UNSET, preset 0 is LONG_FAST', () => {
    // RegionCode.UNSET === 0 and `offer_region` is a plain proto3 enum field,
    // so 0 means "not offered". `offer_preset` is `optional`, so 0 is real.
    // Getting these the same way round is the easy mistake.
    it('treats region 0 as no region offered', () => {
      expect(assessBeaconOffer({ offerRegion: 0 }).reason).toMatch(/text only/i);
    });

    it('treats preset 0 as a genuine offer', () => {
      expect(assessBeaconOffer({ offerPreset: 0 }).presetNote).toBeDefined();
    });
  });

  describe('presetNote', () => {
    it('is informational only — an illegal region/preset never blocks a channel join', () => {
      // Joining a channel does not touch LoRa config, so legality of the
      // advertised preset is context, not a gate.
      let illegal: { region: number; preset: number } | null = null;
      for (const region of [1, 2, 3, 4, 5, 6, 7, 8]) {
        for (const preset of [0, 1, 3, 4, 5, 6, 7, 8]) {
          if (!isPresetLegalForRegion(region, preset)) { illegal = { region, preset }; break; }
        }
        if (illegal) break;
      }
      if (!illegal) return; // no illegal pair in the current table — nothing to assert

      const r = assessBeaconOffer({ ...joinable, offerRegion: illegal.region, offerPreset: illegal.preset });
      expect(r.actionable).toBe(true);
      expect(r.presetNote).toMatch(/not a legal combination/i);
    });

    it('agrees with isPresetLegalForRegion across every region/preset pair', () => {
      // The card must never contradict the picker used elsewhere in the app.
      for (const region of [1, 2, 3, 4, 5]) {
        for (const preset of [0, 1, 3, 4, 5, 6, 7, 8]) {
          const note = assessBeaconOffer({ ...joinable, offerRegion: region, offerPreset: preset }).presetNote ?? '';
          expect(/not a legal combination/i.test(note)).toBe(!isPresetLegalForRegion(region, preset));
        }
      }
    });

    it('is absent when the beacon advertises neither region nor preset', () => {
      expect(assessBeaconOffer(joinable).presetNote).toBeUndefined();
    });
  });
});
