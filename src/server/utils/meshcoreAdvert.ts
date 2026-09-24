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
 * Classify a repeater's reply to `advert` / `advert.zerohop`. MeshCore's
 * CommonCLI answers "OK - zerohop advert sent" for `advert.zerohop` and
 * "OK - Advert sent" for `advert`; firmware without the zero-hop verb matches
 * `advert.zerohop` on its `advert` prefix and gives the flood reply. An empty
 * reply (CLI timeout) is `unknown`.
 */
export function classifyRepeaterAdvertReply(reply: string): RepeaterAdvertReplyOutcome {
  const text = reply.toLowerCase();
  if (text.includes('zerohop advert sent')) return 'zero_hop';
  if (text.includes('advert sent')) return 'flood';
  if (text.includes('error') || text.includes('unknown')) return 'error';
  return 'unknown';
}
