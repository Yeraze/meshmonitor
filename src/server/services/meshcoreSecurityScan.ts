/**
 * Pure MeshCore security analysis (#6281 S3): per-key packet rates and clock
 * offsets. No IO. `meshcoreSecurityScan` callers load the packets (S2) and the
 * DM sender times (repo) and pass them in.
 *
 * Rates count DISTINCT packet hashes inside the window, so per-observer MQTT
 * rows and multi-path flood copies of one packet count once. A packet is
 * attributed to a key by its full key (ADVERT, ANON_REQ), or by its 1-byte
 * `srcHash` only when exactly one known node on the source starts with that
 * byte (REQ, RESPONSE, TXT_MSG). GRP_TXT, ACK and PATH carry no sender and are
 * never attributed.
 *
 * Clock offset = receipt ms minus sender ms (positive = the node is behind),
 * Meshtastic's sign convention. The newest observation per node wins, whether
 * it is an ADVERT or a DM. Every observed node is returned; the caller applies
 * {@link isClockOffsetFlagged}, so it can also clear flags that no longer hold.
 */
import { meshCorePacketHashOrUndefined } from './meshcoreObserverPacket.js';
import { decodeMeshCorePacket } from '../../utils/meshcorePacketDecode.js';
import { EXCESSIVE_PACKETS_WINDOW_MS, TIME_OFFSET_THRESHOLD_MS } from '../constants/securityThresholds.js';
import type { MeshcorePacketRow } from './meshcorePacketWindow.js';
import type { MeshCoreDmSenderTime } from '../../db/repositories/meshcore.js';

const PT_REQ = 0x00;
const PT_RESPONSE = 0x01;
const PT_TXT_MSG = 0x02;
const PT_ADVERT = 0x04;
const PT_ANON_REQ = 0x07;

export interface MeshcoreScanNode {
  publicKey: string;
}

export interface MeshcorePacketRate {
  /** Distinct packets attributed to the key in the window (adverts included). */
  packets: number;
  /** Of those, distinct ADVERT packets. */
  adverts: number;
}

export interface MeshcoreClockOffset {
  /** Receipt minus sender time, ms. Positive = the node's clock is behind. */
  offsetMs: number;
  source: 'advert' | 'message';
  /** When MeshMonitor observed it, epoch ms. */
  observedAt: number;
}

/** A DM sender-time row (from the repo) as the clock scan reads it. */
export type MeshcoreDmClock = MeshCoreDmSenderTime;

const lc = (s: string): string => s.toLowerCase();

export function computeMeshcorePacketRates(
  packets: readonly MeshcorePacketRow[],
  nodes: readonly MeshcoreScanNode[],
  opts: { nowMs: number; windowMs?: number; localKeys?: ReadonlySet<string> },
): Map<string, MeshcorePacketRate> {
  const windowMs = opts.windowMs ?? EXCESSIVE_PACKETS_WINDOW_MS;
  const cutoff = opts.nowMs - windowMs;
  const local = opts.localKeys ?? new Set<string>();

  // First byte -> known keys on this source (the local node counts toward ambiguity).
  const byHash = new Map<string, Set<string>>();
  for (const n of nodes) {
    const k = lc(n.publicKey);
    if (k.length < 2) continue;
    const h = k.slice(0, 2);
    const set = byHash.get(h) ?? new Set<string>();
    set.add(k);
    byHash.set(h, set);
  }

  const seen = new Map<string, { all: Set<string>; adverts: Set<string> }>();
  for (const p of packets) {
    if (!(p.timestamp >= cutoff && p.timestamp <= opts.nowMs)) continue;
    let key: string | null = null;
    if (p.payloadType === PT_ADVERT || p.payloadType === PT_ANON_REQ) {
      key = p.senderPubKey ? lc(p.senderPubKey) : null;
    } else if (p.payloadType === PT_REQ || p.payloadType === PT_RESPONSE || p.payloadType === PT_TXT_MSG) {
      const cands = p.srcHash ? byHash.get(lc(p.srcHash)) : undefined;
      if (cands && cands.size === 1) key = [...cands][0];
    }
    if (!key || local.has(key)) continue;
    const id = meshCorePacketHashOrUndefined(p.rawHex) ?? `row:${p.sourceId}:${p.id ?? `${p.timestamp}:${p.payloadType}`}`;
    const e = seen.get(key) ?? { all: new Set<string>(), adverts: new Set<string>() };
    e.all.add(id);
    if (p.payloadType === PT_ADVERT) e.adverts.add(id);
    seen.set(key, e);
  }

  const out = new Map<string, MeshcorePacketRate>();
  for (const [k, e] of seen) out.set(k, { packets: e.all.size, adverts: e.adverts.size });
  return out;
}

/** Sender time (s) read from an ADVERT frame, or null when it does not decode. */
function advertSenderSeconds(rawHex: string | null): { key: string; seconds: number } | null {
  const d = decodeMeshCorePacket(rawHex);
  const a = d?.payload.advert;
  if (!a) return null;
  return { key: lc(a.publicKey), seconds: a.timestamp };
}

export function computeMeshcoreClockOffsets(input: {
  adverts: readonly MeshcorePacketRow[];
  dms: readonly MeshcoreDmClock[];
  nodes: readonly MeshcoreScanNode[];
  nowMs: number;
  localKeys?: ReadonlySet<string>;
}): Map<string, MeshcoreClockOffset> {
  const local = input.localKeys ?? new Set<string>();
  const best = new Map<string, MeshcoreClockOffset>();
  const offer = (key: string, c: MeshcoreClockOffset) => {
    if (local.has(key)) return;
    const cur = best.get(key);
    if (!cur || c.observedAt > cur.observedAt) best.set(key, c);
  };

  for (const p of input.adverts) {
    if (p.payloadType !== PT_ADVERT) continue;
    const a = advertSenderSeconds(p.rawHex);
    if (!a) continue;
    // A zero stamp is a clock that was never set: its offset is the receipt time itself.
    offer(a.key, { offsetMs: p.timestamp - a.seconds * 1000, source: 'advert', observedAt: p.timestamp });
  }

  const keys = input.nodes.map((n) => lc(n.publicKey));
  const resolve = (from: string): string | null => {
    const f = lc(from);
    if (f.length >= 64) return f;
    if (f.length < 2) return null;
    const hits = keys.filter((k) => k.startsWith(f));
    return hits.length === 1 ? hits[0] : null;
  };
  for (const dm of input.dms) {
    if (!(dm.senderTimestamp > 0)) continue;
    const key = resolve(dm.fromPublicKey);
    if (!key) continue;
    offer(key, { offsetMs: dm.receivedAtMs - dm.senderTimestamp * 1000, source: 'message', observedAt: dm.receivedAtMs });
  }

  return best;
}

/** True when an observed offset is past the flag threshold (either direction). */
export function isClockOffsetFlagged(offsetMs: number, thresholdMs: number = TIME_OFFSET_THRESHOLD_MS): boolean {
  return Math.abs(offsetMs) > thresholdMs;
}
