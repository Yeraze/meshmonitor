/**
 * Shared shapes for the beacons surface (#4723, #5232).
 *
 * Kept in their own module so the button, the modal and the join dialog can all
 * import them without one of the components becoming the de-facto owner of the
 * other two.
 */

/**
 * Server projection of a `mesh_beacon_offers` row.
 *
 * Note there is no PSK field. The offered channel key stays server-side, which
 * is why accepting is a server endpoint rather than the client resolving a slot
 * and calling `PUT /api/channels/:id` — the client has no key to send.
 */
export interface PublicBeaconOffer {
  sourceId: string;
  nodeNum: number;
  message: string | null;
  offerChannelName: string | null;
  hasChannelKey: boolean;
  offerRegion: number | null;
  offerPreset: number | null;
  hasOffer: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Hidden until the sender advertises something different. */
  dismissedAt: number | null;
  /** Hidden for good; survives a changed offer (#5232). */
  mutedAt: number | null;
}

/** Which slice of the table the list is showing. */
export type BeaconFilter = 'pending' | 'hidden' | 'all';

/** Sortable columns. `lastSeenAt` is the default — "last heard", newest first. */
export type BeaconSortKey = 'node' | 'channel' | 'firstSeenAt' | 'lastSeenAt';

export interface BeaconSort {
  key: BeaconSortKey;
  direction: 'asc' | 'desc';
}

/** A beacon is hidden when either flag is set; the two differ only in durability. */
export function isHidden(offer: PublicBeaconOffer): boolean {
  return offer.dismissedAt != null || offer.mutedAt != null;
}
