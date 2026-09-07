/**
 * Can this beacon offer actually be accepted? (#4723)
 *
 * Some received offers are un-actionable — a text-only beacon advertises
 * nothing, and an offer can name a channel without including its key. The card
 * SHOWS those rather than hiding them, with the reason, so a user can tell
 * "nobody is inviting me" from "this invitation cannot be accepted"
 * (maintainer decision on #4723).
 *
 * **Scope: accepting means joining the offered channel, nothing else.**
 * A beacon may also advertise a region and modem preset. Applying those is not
 * a channel edit — it rewrites the radio's LoRa config, which on this codebase
 * is a whole-struct replace that moves the node to a different network
 * entirely, potentially cutting it off from every peer it currently hears.
 * The firmware itself never auto-applies an offer, and a one-click button for
 * "change my whole radio" would be a sharper edge than this card is worth. So
 * region/preset are rendered as context ("there is a mesh on LongFast/US") and
 * `presetNote` explains when that combination could not legally be used, but
 * neither gates or drives the accept.
 */
import {
  getRegionComplianceWarning,
  isPresetLegalForRegion,
  MODEM_PRESET_OPTIONS,
  REGION_OPTIONS,
} from '../configuration/constants';

export interface BeaconOfferLike {
  offerChannelName?: string | null;
  /**
   * Whether the offer arrived with a channel key. Deliberately a boolean and
   * not the key itself: the PSK is a secret that stays server-side, so the
   * client is told only that one exists.
   */
  hasChannelKey?: boolean;
  /** `RegionCode.UNSET` (0) is normalized to null/undefined before it gets here. */
  offerRegion?: number | null;
  /** Preset 0 (LONG_FAST) is a real value — `offer_preset` has explicit presence. */
  offerPreset?: number | null;
}

export interface OfferActionability {
  /** True when the offered channel can be joined. */
  actionable: boolean;
  /** Why not, in user-facing words. Undefined when actionable. */
  reason?: string;
  /**
   * Informational note about the advertised region/preset. Present regardless
   * of `actionable` — it never blocks the join, because joining a channel does
   * not touch LoRa config.
   */
  presetNote?: string;
  /**
   * Regulator-compliance warning for the advertised (region, preset) pair —
   * a combination that fits the band but that the region's regulator does not
   * permit, e.g. Long Fast in the US (#5103).
   *
   * Kept separate from `presetNote` rather than appended to it so the card can
   * style it as a warning, matching the amateur-radio warning on the local LoRa
   * config. Like `presetNote`, it never gates the join: it describes the
   * neighbour's mesh, not anything this node is about to do.
   */
  complianceNote?: string;
}

export function presetName(preset: number | null | undefined): string {
  if (preset == null) return 'unknown preset';
  return MODEM_PRESET_OPTIONS.find((o) => o.value === preset)?.name ?? `preset ${preset}`;
}

export function regionName(region: number | null | undefined): string {
  if (region == null) return 'unknown region';
  const opt = REGION_OPTIONS.find((o) => o.value === region);
  return (opt as { name?: string } | undefined)?.name ?? `region ${region}`;
}

/**
 * Note `!= null` on preset but truthiness on region: `RegionCode.UNSET` is 0,
 * so a zero region means "none offered", while preset 0 is LONG_FAST. The
 * asymmetry comes from the protobuf — `offer_region` is a plain enum field and
 * `offer_preset` is `optional`.
 */
function hasRegion(offer: BeaconOfferLike): boolean {
  return Boolean(offer.offerRegion);
}
function hasPreset(offer: BeaconOfferLike): boolean {
  return offer.offerPreset != null;
}

/**
 * Warning for a (region, preset) pair that fits the band but that the region's
 * regulator does not permit (#5103). Independent of `isPresetLegalForRegion`,
 * which only answers the firmware's bandwidth-fits-the-span question — Long
 * Fast in the US passes that and is still non-compliant.
 *
 * Only produced when the offer carries BOTH a region and a preset: a rule is
 * per-region, and there is nothing to judge without the preset.
 */
function buildComplianceNote(offer: BeaconOfferLike): string | undefined {
  if (!hasRegion(offer) || !hasPreset(offer)) return undefined;
  const warning = getRegionComplianceWarning(offer.offerRegion!, offer.offerPreset!);
  if (!warning) return undefined;
  return `${presetName(offer.offerPreset)}'s ${warning.bandwidthKHz} kHz bandwidth is not compliant in ${regionName(offer.offerRegion)} — ${warning.rationale}. ${warning.recommendedPresetName} is the recommended preset there.`;
}

function buildPresetNote(offer: BeaconOfferLike): string | undefined {
  if (!hasRegion(offer) && !hasPreset(offer)) return undefined;

  if (hasRegion(offer) && hasPreset(offer)) {
    if (!isPresetLegalForRegion(offer.offerRegion!, offer.offerPreset!)) {
      return `Advertises ${presetName(offer.offerPreset)} on ${regionName(offer.offerRegion)}, which is not a legal combination — that preset's bandwidth exceeds the region's frequency span.`;
    }
    return `Advertises a mesh on ${presetName(offer.offerPreset)} / ${regionName(offer.offerRegion)}.`;
  }
  if (hasPreset(offer)) return `Advertises a mesh on ${presetName(offer.offerPreset)}.`;
  return `Advertises a mesh in ${regionName(offer.offerRegion)}.`;
}

export function assessBeaconOffer(offer: BeaconOfferLike): OfferActionability {
  const presetNote = buildPresetNote(offer);
  const complianceNote = buildComplianceNote(offer);
  const channelName = offer.offerChannelName?.trim();

  if (!channelName) {
    // No channel to join. Distinguish "advertises nothing at all" from
    // "advertises a network but gives no way in" — they mean different things
    // to someone deciding whether to chase it up.
    const reason = presetNote
      ? 'This beacon advertises a mesh but offers no channel to join, so there is nothing to apply automatically.'
      : 'This beacon carries no network offer — it is text only.';
    return { actionable: false, reason, presetNote, complianceNote };
  }

  if (!offer.hasChannelKey) {
    return {
      actionable: false,
      reason: `The beacon names a channel ("${channelName}") but did not include its key, so joining it would produce a channel that cannot decrypt anything.`,
      presetNote,
      complianceNote,
    };
  }

  return { actionable: true, presetNote, complianceNote };
}
