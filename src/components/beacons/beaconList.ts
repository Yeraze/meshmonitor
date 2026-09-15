/**
 * Filtering, searching and sorting the beacons list (#5232).
 *
 * A plain `.ts` module rather than exports hanging off `BeaconsModal.tsx`:
 * React Fast Refresh only handles a component file that exports components and
 * nothing else, and these are pure functions that want testing without a DOM
 * anyway. This is the part users notice being wrong, and the part a render test
 * covers least well.
 */
import { isHidden, type BeaconFilter, type BeaconSort, type PublicBeaconOffer } from './types';

/** The canonical fallback label for a node we have no name for. */
export function nodeHexId(nodeNum: number): string {
  return `!${nodeNum.toString(16).padStart(8, '0')}`;
}

/** Filter, search and sort, in that order. */
export function selectOffers(
  offers: PublicBeaconOffer[],
  filter: BeaconFilter,
  query: string,
  sort: BeaconSort,
  nodeName?: (nodeNum: number) => string | undefined,
): PublicBeaconOffer[] {
  const label = (o: PublicBeaconOffer) => nodeName?.(o.nodeNum) ?? nodeHexId(o.nodeNum);

  const filtered = offers.filter((o) => {
    if (filter === 'pending') return !isHidden(o);
    if (filter === 'hidden') return isHidden(o);
    return true;
  });

  const needle = query.trim().toLowerCase();
  const searched = needle
    ? filtered.filter((o) => (
      label(o).toLowerCase().includes(needle)
        || nodeHexId(o.nodeNum).includes(needle)
        || (o.message ?? '').toLowerCase().includes(needle)
        || (o.offerChannelName ?? '').toLowerCase().includes(needle)
    ))
    : filtered;

  // Sorting a copy: the caller's array is React state.
  const sorted = [...searched].sort((a, b) => {
    let cmp: number;
    switch (sort.key) {
      case 'node':
        cmp = label(a).localeCompare(label(b));
        break;
      case 'channel':
        // Offers without a channel sort last in ascending order rather than
        // clumping at the top under an empty string — the named ones are what
        // someone sorting by channel is looking for. U+FFFF is the sentinel
        // because it collates past any realistic channel name; it is deliberate,
        // not a stray paste.
        cmp = (a.offerChannelName ?? '￿').localeCompare(b.offerChannelName ?? '￿');
        break;
      case 'firstSeenAt':
        cmp = a.firstSeenAt - b.firstSeenAt;
        break;
      case 'lastSeenAt':
      default:
        cmp = a.lastSeenAt - b.lastSeenAt;
        break;
    }
    // Stable tiebreak so two beacons heard in the same second do not swap
    // places between renders.
    if (cmp === 0) cmp = a.nodeNum - b.nodeNum;
    return sort.direction === 'asc' ? cmp : -cmp;
  });

  return sorted;
}
