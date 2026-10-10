/**
 * MeshCore per-hop trace SNR (#5722): shared shapes and the per-link summary.
 *
 * A link is DIRECTIONAL: `receiver` heard `sender`. A→B and B→A are two links.
 */

/** The hop-row fields the summary reads (a subset of the repository row). */
export interface HopSnrSample {
  senderPublicKey: string | null;
  senderHash: string | null;
  senderCandidates: number;
  receiverPublicKey: string | null;
  receiverHash: string | null;
  receiverCandidates: number;
  snrQuarterDb: number;
  initiated: boolean;
  timestamp: number;
}

/** One end of a link: a resolved contact, an unresolved hash, or unknown. */
export interface HopSnrEnd {
  publicKey: string | null;
  /** Path hash as hex when the key is not resolved. */
  hash: string | null;
  /** 1 = resolved, 0 = unknown, >1 = that many contacts share the hash. */
  candidates: number;
}

export interface HopSnrLink {
  sender: HopSnrEnd;
  receiver: HopSnrEnd;
  count: number;
  /** dB */
  lastSnr: number;
  avgSnr: number;
  minSnr: number;
  maxSnr: number;
  lastTimestamp: number;
  /** How many samples came from traces MeshMonitor sent. */
  initiatedCount: number;
  /** Oldest first, capped at {@link HOP_SNR_POINTS_PER_LINK}. `[timestamp, dB]`. */
  points: Array<[number, number]>;
}

export const HOP_SNR_POINTS_PER_LINK = 120;

const endKey = (publicKey: string | null, hash: string | null): string =>
  publicKey ? `k:${publicKey}` : hash ? `h:${hash}` : '?';

/** Group hop rows into directional links, newest link first. */
export function summarizeHopSnrLinks(rows: readonly HopSnrSample[]): HopSnrLink[] {
  const byLink = new Map<string, { sender: HopSnrEnd; receiver: HopSnrEnd; samples: HopSnrSample[] }>();
  for (const r of rows) {
    const key = `${endKey(r.senderPublicKey, r.senderHash)}>${endKey(r.receiverPublicKey, r.receiverHash)}`;
    let entry = byLink.get(key);
    if (!entry) {
      entry = {
        sender: { publicKey: r.senderPublicKey, hash: r.senderPublicKey ? null : r.senderHash, candidates: r.senderCandidates },
        receiver: { publicKey: r.receiverPublicKey, hash: r.receiverPublicKey ? null : r.receiverHash, candidates: r.receiverCandidates },
        samples: [],
      };
      byLink.set(key, entry);
    }
    entry.samples.push(r);
  }
  const links: HopSnrLink[] = [];
  for (const { sender, receiver, samples } of byLink.values()) {
    samples.sort((a, b) => a.timestamp - b.timestamp);
    const db = samples.map((s) => s.snrQuarterDb / 4);
    const last = samples[samples.length - 1];
    links.push({
      sender,
      receiver,
      count: samples.length,
      lastSnr: last.snrQuarterDb / 4,
      avgSnr: Math.round((db.reduce((a, b) => a + b, 0) / db.length) * 100) / 100,
      minSnr: Math.min(...db),
      maxSnr: Math.max(...db),
      lastTimestamp: last.timestamp,
      initiatedCount: samples.filter((s) => s.initiated).length,
      points: samples.slice(-HOP_SNR_POINTS_PER_LINK).map((s) => [s.timestamp, s.snrQuarterDb / 4]),
    });
  }
  links.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  return links;
}
