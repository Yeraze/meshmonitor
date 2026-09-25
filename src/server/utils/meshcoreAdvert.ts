/**
 * Server-side helpers for MeshCore self-adverts. The shared mode type lives in
 * src/types/meshcoreAdvert.ts.
 */

/**
 * A repeater cannot send a zero-hop advert because its firmware predates the
 * `advert.zerohop` CLI verb. `floodSent` is true when this very request went
 * out as a FLOOD (old firmware prefix-matches `advert.zerohop` as `advert`),
 * false when MeshMonitor refused it up front after an earlier detection.
 */
export class MeshCoreZeroHopAdvertUnsupportedError extends Error {
  readonly code = 'ZERO_HOP_ADVERT_UNSUPPORTED';
  constructor(readonly floodSent: boolean) {
    super(
      floodSent
        ? 'This repeater\'s firmware does not support zero-hop adverts (advert.zerohop) and sent a FLOOD advert instead. Update the repeater firmware to send zero-hop adverts.'
        : 'This repeater\'s firmware does not support zero-hop adverts (advert.zerohop). Update the repeater firmware, or send a flood advert.',
    );
    this.name = 'MeshCoreZeroHopAdvertUnsupportedError';
  }
}

export type RepeaterAdvertReplyOutcome = 'zero_hop' | 'flood' | 'error' | 'unknown';

/**
 * Classify a repeater's reply to `advert` / `advert.zerohop`.
 *
 * MeshCore firmware replies (src/helpers/CommonCLI.cpp):
 *   - `advert.zerohop` → "OK - zerohop advert sent"
 *   - `advert`         → "OK - Advert sent"
 * Firmware that predates `advert.zerohop` matches it on its `advert` prefix,
 * FLOODS, and gives the flood reply. The two matches are mutually exclusive
 * (the flood match excludes "zerohop"), so the result never depends on check
 * order. An empty reply (CLI timeout) is `unknown`.
 */
export function classifyRepeaterAdvertReply(reply: string): RepeaterAdvertReplyOutcome {
  const text = reply.toLowerCase();
  const zeroHop = text.includes('zerohop advert sent');
  const flood = text.includes('advert sent') && !text.includes('zerohop');
  if (zeroHop) return 'zero_hop';
  if (flood) return 'flood';
  if (text.includes('error') || text.includes('unknown')) return 'error';
  return 'unknown';
}
