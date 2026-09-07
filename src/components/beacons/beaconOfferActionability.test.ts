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
  // --- Regulator-compliance warning (#5103) ---

  it('warns that Long Fast is not compliant in the US and names Long Turbo', () => {
    // The combination the official Meshtastic clients now flag. It PASSES the
    // firmware bandwidth-fits-the-band check, so only the compliance table
    // catches it — that is the whole point of the second check.
    const r = assessBeaconOffer({ ...joinable, offerRegion: 1, offerPreset: 0 });
    expect(isPresetLegalForRegion(1, 0)).toBe(true);
    expect(r.complianceNote).toMatch(/not compliant in/i);
    expect(r.complianceNote).toContain('LONG_FAST');
    expect(r.complianceNote).toContain('250 kHz');
    expect(r.complianceNote).toContain('LONG_TURBO');
  });

  it('never blocks the join on a compliance warning', () => {
    // Region/preset are context about the neighbour's mesh; joining a channel
    // does not touch this node's LoRa config, so a warning must not gate it.
    const r = assessBeaconOffer({ ...joinable, offerRegion: 1, offerPreset: 0 });
    expect(r.actionable).toBe(true);
  });

  it('still reports the compliance warning on an un-actionable offer', () => {
    const r = assessBeaconOffer({ offerChannelName: null, offerRegion: 1, offerPreset: 0 });
    expect(r.actionable).toBe(false);
    expect(r.complianceNote).toMatch(/not compliant in/i);
  });

  it('does not warn about a US preset that meets the 500 kHz floor', () => {
    for (const preset of [8, 9, 16]) { // SHORT_TURBO, LONG_TURBO, MEDIUM_TURBO
      expect(assessBeaconOffer({ ...joinable, offerRegion: 1, offerPreset: preset }).complianceNote)
        .toBeUndefined();
    }
  });

  it('is default-open: a region with no confirmed rule produces no warning', () => {
    // EU_868 with a 125 kHz preset — narrow, but no ETSI rule is encoded, and
    // guessing one would put a false legal claim in front of the user.
    expect(assessBeaconOffer({ ...joinable, offerRegion: 3, offerPreset: 1 }).complianceNote)
      .toBeUndefined();
    // An unknown region code likewise.
    expect(assessBeaconOffer({ ...joinable, offerRegion: 250, offerPreset: 0 }).complianceNote)
      .toBeUndefined();
  });

  it('needs both a region and a preset before it judges anything', () => {
    // offer_region UNSET (0) normalises to falsy; offer_preset 0 is LONG_FAST,
    // a real value — so the guards are deliberately asymmetric.
    expect(assessBeaconOffer({ ...joinable, offerPreset: 0 }).complianceNote).toBeUndefined();
    expect(assessBeaconOffer({ ...joinable, offerRegion: 1 }).complianceNote).toBeUndefined();
    expect(assessBeaconOffer({ ...joinable, offerRegion: 0, offerPreset: 0 }).complianceNote).toBeUndefined();
  });

  it('keeps the compliance warning separate from the plain preset note', () => {
    // They are rendered differently (warning box vs muted line), so a caller
    // must be able to tell them apart.
    const r = assessBeaconOffer({ ...joinable, offerRegion: 1, offerPreset: 0 });
    expect(r.presetNote).toMatch(/Advertises a mesh on/);
    expect(r.presetNote).not.toMatch(/not compliant/i);
  });
});
