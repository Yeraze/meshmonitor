/**
 * Detects channel moves by comparing before/after snapshots.
 * Matches channels by PSK + name identity across different slot positions.
 * Returns both directions for swaps so downstream migration handles them correctly.
 *
 * Only matches when (psk, name) is unique in BOTH snapshots — duplicate identities
 * are ambiguous and skipped to avoid phantom swaps (see issue #3452).
 */

export interface ChannelSnapshot {
  id: number;
  psk?: string | null;
  name?: string | null;
}

/**
 * Build an "after" snapshot from channels decoded out of a Meshtastic config
 * URL, before they have reached the database (#5183).
 *
 * Names are normalised the way the device sync stores them — a blank secondary
 * becomes `Channel N`, slot 0 stays blank — so a named channel moved by the
 * import matches its stored row. Without a name here, PSK + name matching could
 * never recognise a move from a URL import, and the moved channel's message
 * history would be left behind.
 */
export function snapshotFromDecodedChannels(
  channels: ReadonlyArray<{ name?: string | null; psk?: string | null }>,
): ChannelSnapshot[] {
  return channels.map((ch, i) => ({
    id: i,
    psk: ch.psk === 'none' ? null : (ch.psk || null),
    name: ch.name || (i === 0 ? '' : `Channel ${i}`),
  }));
}

function channelKey(ch: ChannelSnapshot): string {
  return JSON.stringify([ch.psk, ch.name || '']);
}

function countByKey(snapshot: ChannelSnapshot[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ch of snapshot) {
    if (!ch.psk) continue;
    const k = channelKey(ch);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

export function detectChannelMoves(
  beforeSnapshot: ChannelSnapshot[],
  afterSnapshot: ChannelSnapshot[]
): { from: number; to: number }[] {
  const beforeCounts = countByKey(beforeSnapshot);
  const afterCounts = countByKey(afterSnapshot);
  const moves: { from: number; to: number }[] = [];

  for (const oldCh of beforeSnapshot) {
    if (!oldCh.psk || oldCh.psk === '') continue;
    const k = channelKey(oldCh);
    // Skip ambiguous identities — (psk, name) must be unique in both snapshots
    if ((beforeCounts.get(k) ?? 0) !== 1 || (afterCounts.get(k) ?? 0) !== 1) continue;
    const newCh = afterSnapshot.find(ch =>
      ch.id !== oldCh.id &&
      ch.psk === oldCh.psk &&
      (ch.name || '') === (oldCh.name || '')
    );
    if (newCh) {
      if (!moves.find(m => m.from === oldCh.id && m.to === newCh.id)) {
        moves.push({ from: oldCh.id, to: newCh.id });
      }
    }
  }
  return moves;
}
