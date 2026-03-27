/**
 * Detects channel moves by comparing before/after snapshots.
 * Matches channels by PSK + name identity across different slot positions.
 * Returns both directions for swaps so downstream migration handles them correctly.
 */

export interface ChannelSnapshot {
  id: number;
  psk?: string | null;
  name?: string | null;
}

export function detectChannelMoves(
  beforeSnapshot: ChannelSnapshot[],
  afterSnapshot: ChannelSnapshot[]
): { from: number; to: number }[] {
  const moves: { from: number; to: number }[] = [];
  for (const oldCh of beforeSnapshot) {
    if (!oldCh.psk || oldCh.psk === '') continue;
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
