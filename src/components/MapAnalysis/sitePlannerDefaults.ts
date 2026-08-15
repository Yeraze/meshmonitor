/**
 * Seeding the Site Planner from a radio's live configuration (#4727).
 *
 * Maintainer decision: prefill frequency and transmit power from the selected
 * source's actual LoRa config rather than generic constants, so a prediction
 * reflects the user's real radio. Everything stays editable — the point is a
 * better starting position, not a locked one.
 *
 * The failure this guards against is quiet and nasty: a plausible-looking
 * coverage polygon computed on the wrong region's frequency and a default
 * power the radio never used. Every field therefore falls back only when the
 * device genuinely did not report a value, and `seededFrom` records which
 * fields came from the device so the UI can say so.
 */
import { regionCenterFrequencyHz } from '../configuration/constants';

/** The subset of a device's LoRa config this needs. */
export interface LoraConfigLike {
  region?: number | null;
  modemPreset?: number | null;
  txPower?: number | null;
  /** dBi; firmware exposes a single scalar antenna gain. */
  txGain?: number | null;
}

export interface SitePlannerDefaults {
  frequencyHz: number;
  txPowerDbm: number;
  txGainDbi: number;
  rxGainDbi: number;
  lossesDb: number;
  sensitivityDbm: number;
  txHeightM: number;
  rxHeightM: number;
  radiusKm: number;
  /** Field names genuinely taken from the device, for UI disclosure. */
  seededFrom: string[];
  /**
   * Set when the radio reported a region MeshMonitor has no frequency band
   * for, so the UI can say which one rather than showing a generic "assumed".
   *
   * `REGION_FREQ_INFO` is transcribed from firmware and currently stops short
   * of several amateur and newer EU regions (27-32 as of writing). Guessing a
   * band from the region's NAME would be worse than falling back: the guess
   * would be reported as read-from-device and silently shift every prediction.
   */
  unknownRegion: number | null;
}

/**
 * Fallbacks used only where the device reported nothing.
 *
 * 915 MHz and 30 dBm describe a US-region radio at maximum legal power, which
 * is the most common deployment — but it IS a guess, which is why the UI
 * distinguishes seeded fields from assumed ones.
 */
export const SITE_PLANNER_FALLBACKS = {
  frequencyHz: 915e6,
  txPowerDbm: 30,
  txGainDbi: 2,
  rxGainDbi: 2,
  lossesDb: 1,
  /** Long-range LoRa preset sensitivity; the model's most optimistic input. */
  sensitivityDbm: -130,
  txHeightM: 10,
  /** A peer handheld, not a base station — deliberately pessimistic. */
  rxHeightM: 2,
  radiusKm: 15,
} as const;

export function buildSitePlannerDefaults(lora?: LoraConfigLike | null): SitePlannerDefaults {
  const seededFrom: string[] = [];

  const freq = regionCenterFrequencyHz(lora?.region);
  if (freq != null) seededFrom.push('frequency');
  // The radio told us a region but we have no band for it — a materially
  // different situation from "no radio config at all", and one the user can
  // fix immediately now that frequency is editable.
  const unknownRegion = lora?.region != null && freq == null ? Number(lora.region) : null;

  // `!= null` rather than truthiness: 0 dBm is a legitimate transmit power
  // (some regions cap low), and truthiness would silently replace it with 30.
  const txPower = lora?.txPower != null && Number.isFinite(lora.txPower) ? Number(lora.txPower) : null;
  if (txPower != null) seededFrom.push('txPower');

  const txGain = lora?.txGain != null && Number.isFinite(lora.txGain) ? Number(lora.txGain) : null;
  if (txGain != null) seededFrom.push('txGain');

  return {
    frequencyHz: freq ?? SITE_PLANNER_FALLBACKS.frequencyHz,
    txPowerDbm: txPower ?? SITE_PLANNER_FALLBACKS.txPowerDbm,
    txGainDbi: txGain ?? SITE_PLANNER_FALLBACKS.txGainDbi,
    rxGainDbi: SITE_PLANNER_FALLBACKS.rxGainDbi,
    lossesDb: SITE_PLANNER_FALLBACKS.lossesDb,
    sensitivityDbm: SITE_PLANNER_FALLBACKS.sensitivityDbm,
    txHeightM: SITE_PLANNER_FALLBACKS.txHeightM,
    rxHeightM: SITE_PLANNER_FALLBACKS.rxHeightM,
    radiusKm: SITE_PLANNER_FALLBACKS.radiusKm,
    seededFrom,
    unknownRegion,
  };
}
