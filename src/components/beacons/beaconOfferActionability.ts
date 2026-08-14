/**
 * Can this beacon offer actually be accepted? (#4723)
 *
 * Some received offers are un-actionable — a text-only beacon advertises
 * nothing, and an offered preset can be illegal in the offered region. The card
 * SHOWS those rather than hiding them, with the reason, so a user can tell
 * "nobody is inviting me" from "this invitation cannot legally be accepted"
 * (maintainer decision on #4723).
 *
 * Region/preset legality has no wire field — it is the firmware fit-check
 * `(freqEnd - freqStart) >= presetBandwidth`, evaluated client-side by
 * `isPresetLegalForRegion`. So this must be assessed here, not trusted from the
 * beacon.
 */
import {
  isPresetLegalForRegion,
  MODEM_PRESET_OPTIONS,
  REGION_OPTIONS,
} from '../configuration/constants';

export interface BeaconOfferLike {
  offerChannelName?: string | null;
  offerRegion?: number | null;
  offerPreset?: number | null;
}

export interface OfferActionability {
  /** True when Add/Switch may be offered at all. */
  actionable: boolean;
  /** Why not, in user-facing words. Undefined when actionable. */
  reason?: string;
}

export function presetName(preset: number | null | undefined): string {
  if (preset == null) return 'unknown preset';
  return MODEM_PRESET_OPTIONS.find((o) => o.value === preset)?.name ?? `preset ${preset}`;
}

export function regionName(region: number | null | undefined): string {
  if (region == null) return 'unknown region';
  const opt = REGION_OPTIONS.find((o) => o.value === region);
  // RegionOption uses `name` like MODEM_PRESET_OPTIONS; fall back to the enum.
  return (opt as { name?: string } | undefined)?.name ?? `region ${region}`;
}

/**
 * Assess an offer. Note `!= null` rather than truthiness throughout: region and
 * preset 0 are valid enum values, and a falsy check would misreport a real
 * offer as "carries no network offer".
 */
export function assessBeaconOffer(offer: BeaconOfferLike): OfferActionability {
  const hasChannel = Boolean(offer.offerChannelName && offer.offerChannelName.trim());
  const hasRegion = offer.offerRegion != null;
  const hasPreset = offer.offerPreset != null;

  if (!hasChannel && !hasRegion && !hasPreset) {
    return { actionable: false, reason: 'This beacon carries no network offer — it is text only.' };
  }

  // Only a region+preset pair can be illegal; either alone is unconstrained.
  if (hasRegion && hasPreset && !isPresetLegalForRegion(offer.offerRegion!, offer.offerPreset!)) {
    return {
      actionable: false,
      reason: `${presetName(offer.offerPreset)} is not legal in ${regionName(offer.offerRegion)} — its bandwidth exceeds the region's frequency span, so the radio could not use this configuration.`,
    };
  }

  return { actionable: true };
}
