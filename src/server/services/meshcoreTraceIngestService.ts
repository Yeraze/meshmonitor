/**
 * MeshCore TRACE ingest (#5722): turn one TraceData push into per-hop SNR rows.
 *
 * Passive. Nothing here sends anything; it stores what the companion radio
 * reported. Both a reply to a trace MeshMonitor sent and a trace the radio
 * merely overheard come through {@link MeshCoreTraceIngestService.ingest}, with
 * `initiated` telling them apart (#5723's scheduled traces use the same path).
 *
 * How a TRACE reads (firmware `Mesh::onRecvPacket`): the payload lists the
 * path hashes h[0..N-1]; each forwarding hop appends the SNR at which IT heard
 * the packet. So `pathSnrs[i]` is the SNR at hop h[i], receiving from h[i-1]
 * (from the originator when i = 0), and the trailing `lastSnr` is the SNR at
 * our own radio, receiving from h[N-1]. Every row is therefore directional:
 * receiver heard sender.
 *
 * A path hash is the first 1 or 2 bytes of a node's public key. A hash that
 * matches exactly one known contact (or our own node) is resolved; otherwise
 * the key stays null and the candidate count is stored. Nothing is guessed.
 * For an overheard trace the originator is not on the wire at all.
 */
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import type { MeshCoreHopSnrRow } from '../../db/repositories/meshcoreHopSnr.js';

/** Bridge-event payload emitted by the native backend (`trace_data`). */
export interface TraceDataEvent {
  tag: number;
  auth_code: number;
  flags: number;
  /** 1 or 2 in current firmware (`1 << (flags & 0x03)`). */
  hash_bytes: number;
  path_hashes_hex: string;
  /** Signed quarter-dB, one per hop. */
  path_snrs_q: number[];
  /** Signed quarter-dB at our own radio for the final hop. */
  last_snr_q: number;
  /** True when this backend sent the trace. */
  initiated: boolean;
}

/** The same (tag, auth code) seen again within this window is one trace. */
export const TRACE_DEDUP_WINDOW_MS = 60_000;
/** History kept per source. */
export const HOP_SNR_RETENTION_MS = 90 * 24 * 60 * 60_000;
const PRUNE_EVERY_MS = 6 * 60 * 60_000;

interface Resolved { publicKey: string | null; candidates: number }

/** Resolve a path hash against known public keys (lower-case hex). */
export function resolvePathHash(hashHex: string, knownKeys: readonly string[]): Resolved {
  const prefix = hashHex.toLowerCase();
  let match: string | null = null;
  let candidates = 0;
  for (const key of knownKeys) {
    if (key.startsWith(prefix)) {
      candidates++;
      match = key;
    }
  }
  return { publicKey: candidates === 1 ? match : null, candidates };
}

/**
 * Build the hop rows for one trace. Pure: no I/O.
 *
 * @param knownKeys lower-case public keys of the source's contacts and its own node
 * @param localPublicKey the source's own node, the receiver of the final hop
 *   and (when `initiated`) the sender of the first
 */
export function traceToHopRows(
  sourceId: string,
  trace: TraceDataEvent,
  knownKeys: readonly string[],
  localPublicKey: string | null,
  timestamp: number,
): MeshCoreHopSnrRow[] {
  const hashBytes = trace.hash_bytes;
  if (hashBytes !== 1 && hashBytes !== 2 && hashBytes !== 4 && hashBytes !== 8) return [];
  const hex = (trace.path_hashes_hex ?? '').toLowerCase();
  const width = hashBytes * 2;
  if (hex.length === 0 || hex.length % width !== 0) return [];
  const hashes: string[] = [];
  for (let i = 0; i < hex.length; i += width) hashes.push(hex.slice(i, i + width));
  const snrs = trace.path_snrs_q ?? [];
  // A malformed push: one SNR per hop is the contract.
  if (snrs.length !== hashes.length) return [];
  const validSnr = (q: unknown): q is number => typeof q === 'number' && Number.isInteger(q) && q >= -128 && q <= 127;
  if (!snrs.every(validSnr) || !validSnr(trace.last_snr_q)) return [];

  const local = localPublicKey ? localPublicKey.toLowerCase() : null;
  const hops = hashes.map((h) => ({ hash: h, ...resolvePathHash(h, knownKeys) }));
  const hopCount = hashes.length + 1;
  const base = {
    sourceId,
    traceTag: trace.tag >>> 0,
    authCode: trace.auth_code >>> 0,
    hopCount,
    hashBytes,
    initiated: trace.initiated === true,
    timestamp,
  };
  const rows: MeshCoreHopSnrRow[] = [];
  hops.forEach((hop, i) => {
    const prev = i > 0 ? hops[i - 1] : null;
    rows.push({
      ...base,
      hopIndex: i,
      // First hop: the originator. Ours when we sent the trace; otherwise it
      // is not in the packet, so it stays unknown.
      senderPublicKey: prev ? prev.publicKey : (base.initiated ? local : null),
      senderHash: prev ? prev.hash : null,
      senderCandidates: prev ? prev.candidates : (base.initiated && local ? 1 : 0),
      receiverPublicKey: hop.publicKey,
      receiverHash: hop.hash,
      receiverCandidates: hop.candidates,
      snrQuarterDb: snrs[i],
    });
  });
  const lastHop = hops[hops.length - 1];
  rows.push({
    ...base,
    hopIndex: hops.length,
    senderPublicKey: lastHop.publicKey,
    senderHash: lastHop.hash,
    senderCandidates: lastHop.candidates,
    receiverPublicKey: local,
    receiverHash: null,
    receiverCandidates: local ? 1 : 0,
    snrQuarterDb: trace.last_snr_q,
  });
  return rows;
}

export interface TraceIngestDeps {
  listContactKeys(sourceId: string): Promise<string[]>;
  hasTrace(sourceId: string, tag: number, authCode: number, sinceMs: number): Promise<boolean>;
  insertHops(sourceId: string, rows: MeshCoreHopSnrRow[]): Promise<void>;
  deleteOlderThan(sourceId: string, cutoffMs: number): Promise<void>;
  now(): number;
}

function defaultDeps(): TraceIngestDeps {
  return {
    listContactKeys: async (sourceId) =>
      (await databaseService.meshcore.getNodesBySource(sourceId))
        .map((n) => (n.publicKey ?? '').toLowerCase())
        .filter((k) => k.length > 0),
    hasTrace: (sourceId, tag, authCode, sinceMs) => databaseService.meshcoreHopSnr.hasTrace(sourceId, tag, authCode, sinceMs),
    insertHops: (sourceId, rows) => databaseService.meshcoreHopSnr.insertHops(sourceId, rows),
    deleteOlderThan: (sourceId, cutoffMs) => databaseService.meshcoreHopSnr.deleteOlderThan(sourceId, cutoffMs),
    now: () => Date.now(),
  };
}

export class MeshCoreTraceIngestService {
  /** Recently stored traces per source: `${tag}:${auth}` → stored-at ms. */
  private readonly recent = new Map<string, Map<string, number>>();
  private readonly lastPrune = new Map<string, number>();

  constructor(private readonly deps: TraceIngestDeps = defaultDeps()) {}

  /**
   * Store one trace for a source. Returns the number of rows written (0 when
   * it was a duplicate or malformed). Never throws.
   */
  async ingest(sourceId: string, trace: TraceDataEvent, localPublicKey: string | null): Promise<number> {
    try {
      if (!sourceId || !trace || typeof trace.tag !== 'number') return 0;
      const now = this.deps.now();
      const key = `${trace.tag >>> 0}:${trace.auth_code >>> 0}`;
      let seen = this.recent.get(sourceId);
      if (!seen) {
        seen = new Map();
        this.recent.set(sourceId, seen);
      }
      for (const [k, at] of seen) if (at <= now - TRACE_DEDUP_WINDOW_MS) seen.delete(k);
      if (seen.has(key)) return 0;
      // Claim before the awaits so two pushes of one trace cannot both pass.
      seen.set(key, now);
      // Across a restart the in-memory window is empty; the table still knows.
      if (await this.deps.hasTrace(sourceId, trace.tag >>> 0, trace.auth_code >>> 0, now - TRACE_DEDUP_WINDOW_MS)) return 0;

      const keys = await this.deps.listContactKeys(sourceId);
      const local = localPublicKey ? localPublicKey.toLowerCase() : null;
      if (local && !keys.includes(local)) keys.push(local);
      const rows = traceToHopRows(sourceId, trace, keys, local, now);
      if (rows.length === 0) return 0;
      await this.deps.insertHops(sourceId, rows);
      void this.pruneIfDue(sourceId, now);
      return rows.length;
    } catch (error) {
      logger.warn(`[MeshCore:${sourceId}] Failed to store trace SNRs:`, error);
      return 0;
    }
  }

  private async pruneIfDue(sourceId: string, now: number): Promise<void> {
    if ((this.lastPrune.get(sourceId) ?? 0) > now - PRUNE_EVERY_MS) return;
    this.lastPrune.set(sourceId, now);
    try {
      await this.deps.deleteOlderThan(sourceId, now - HOP_SNR_RETENTION_MS);
    } catch (error) {
      logger.debug(`[MeshCore:${sourceId}] hop SNR prune failed:`, error);
    }
  }
}

export const meshcoreTraceIngestService = new MeshCoreTraceIngestService();
