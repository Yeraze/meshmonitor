/**
 * LoRa time-on-air estimate (#6255, P9 S3), matching the MeshCore radio setup.
 *
 * MeshCore sets the preamble per spreading factor: 32 symbols at SF <= 8,
 * 16 above (`RadioLibWrappers.h` `preambleLengthForSF`). Explicit header and
 * payload CRC are on; low-data-rate optimisation turns on when a symbol lasts
 * 16 ms or more.
 */

export interface LoraParams {
  sf: number;
  /** Bandwidth in kHz (the unit `get radio` prints: 62.5, 125, 250). */
  bw: number;
  /** Coding-rate denominator 5-8 (4/5 .. 4/8). 1-4 is read as the 4/(4+n) form. */
  cr: number;
}

export function meshcorePreambleSymbols(sf: number): number {
  return sf <= 8 ? 32 : 16;
}

/** Estimated on-air time in milliseconds for a `bytes`-long LoRa payload. */
export function estimateLoraAirtimeMs(bytes: number, { sf, bw, cr }: LoraParams): number {
  if (!(bytes >= 0) || !(sf >= 5 && sf <= 12) || !(bw > 0)) return NaN;
  const crDen = cr >= 5 ? cr : cr + 4;
  const crIdx = Math.min(4, Math.max(1, crDen - 4));
  const tSymMs = (2 ** sf / (bw * 1000)) * 1000;
  const de = tSymMs >= 16 ? 1 : 0;
  const tPreamble = (meshcorePreambleSymbols(sf) + 4.25) * tSymMs;
  const payloadSyms =
    8 + Math.max(Math.ceil((8 * bytes - 4 * sf + 28 + 16) / (4 * (sf - 2 * de))) * (crIdx + 4), 0);
  return tPreamble + payloadSyms * tSymMs;
}
