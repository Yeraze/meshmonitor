/**
 * MeshCore TRACE ingest (#5722, #5742): turn one heard TRACE into per-hop SNR rows.
 *
 * Passive. Nothing here sends anything; it stores what the source's radio
 * heard. A Companion reports each completed trace as a TraceData push: both a
 * reply to a trace MeshMonitor sent and one the radio merely overheard, with
 * `initiated` telling them apart (#5723's scheduled traces use the same path).
 * A Repeater prints the raw packet on its serial log, at whatever stage of the
 * trip it heard it (`inFlight`, #5742). Both come through
 * {@link MeshCoreTraceIngestService.ingest}.
 *
 * How a TRACE reads (firmware `Mesh::onRecvPacket`): the payload lists the
 * path hashes h[0..N-1]; each forwarding hop appends the SNR at which IT heard
 * the packet. So `pathSnrs[i]` is the SNR at hop h[i], receiving from h[i-1]
 * (from the originator when i = 0), and the trailing `lastSnr` is the SNR at
 * our own radio, receiving from whoever sent the packet last. Every row is
 * therefore directional: receiver heard sender.
 *
 * A path hash is the first 1 or 2 bytes of a node's public key. A hash that
 * matches exactly one known contact (or our own node) is resolved; otherwise
 * the key stays null and the candidate count is stored. Nothing is guessed.
 * For an overheard trace the originator is not on the wire at all.
 */
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import type { MeshCoreHopSnrRow } from '../../db/repositories/meshcoreHopSnr.js';
import type { TraceDataEvent } from '../../utils/meshcoreTrace.js';

export type { TraceDataEvent };

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

export interface TraceIngestOptions {
  /**
   * The trace is a raw packet a Repeater heard on the air (#5742), not a
   * Companion's push for a finished trace. It may be at any stage of its trip:
   *
   * - It carries an SNR for only the first k of its N hops (k ≤ N). Rows are
   *   built for those k links and no others.
   * - Our radio heard hop k-1, the node that sent this copy. That link is
   *   stored when the reception's SNR is known, our own key is known and
   *   k ≥ 1. With k = 0 the sender is the originator, which the packet does
   *   not name, so nothing is stored for it.
   * - The same trace is heard once per stage. A link already stored for the
   *   trace is not stored again.
   */
  inFlight?: boolean;
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
  options: TraceIngestOptions = {},
): MeshCoreHopSnrRow[] {
  const inFlight = options.inFlight === true;
  const hashBytes = trace.hash_bytes;
  // Firmware packs the width as `1 << (flags & 0x03)`. Companions send 1 or 2;
  // 4 is accepted as stored (it fits the hash column). 8 does not, and no
  // firmware sends it, so it is dropped rather than truncated.
  if (hashBytes !== 1 && hashBytes !== 2 && hashBytes !== 4) return [];
  const hex = (trace.path_hashes_hex ?? '').toLowerCase();
  const width = hashBytes * 2;
  if (hex.length === 0 || hex.length % width !== 0) return [];
  const hashes: string[] = [];
  for (let i = 0; i < hex.length; i += width) hashes.push(hex.slice(i, i + width));
  const snrs = trace.path_snrs_q ?? [];
  // A Companion push: one SNR per hop is the contract. A packet caught in
  // flight has one per hop that has forwarded so far, never more than the hops.
  if (inFlight ? snrs.length > hashes.length : snrs.length !== hashes.length) return [];
  const validSnr = (q: unknown): q is number => typeof q === 'number' && Number.isInteger(q) && q >= -128 && q <= 127;
  const lastSnr = trace.last_snr_q ?? null;
  if (!snrs.every(validSnr)) return [];
  if (lastSnr === null ? !inFlight : !validSnr(lastSnr)) return [];

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
  hops.slice(0, snrs.length).forEach((hop, i) => {
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
  // The link into our own radio. The packet was sent by the last hop that
  // added an SNR. For a Companion push that is always the final hop.
  // In flight it is stored only when both ends are known to be right: see
  // {@link TraceIngestOptions.inFlight}.
  if (lastSnr === null || (inFlight && (!local || snrs.length === 0))) return rows;
  const lastHop = hops[snrs.length - 1];
  rows.push({
    ...base,
    hopIndex: snrs.length,
    senderPublicKey: lastHop.publicKey,
    senderHash: lastHop.hash,
    senderCandidates: lastHop.candidates,
    receiverPublicKey: local,
    receiverHash: null,
    receiverCandidates: local ? 1 : 0,
    snrQuarterDb: lastSnr,
  });
  return rows;
}

/** Identity of a row within its trace. Only the row into our own radio has no receiver hash. */
const rowKey = (row: Pick<MeshCoreHopSnrRow, 'hopIndex' | 'receiverHash'>): string =>
  `${row.hopIndex}:${row.receiverHash === null ? 'local' : 'path'}`;

interface SeenTrace {
  at: number;
  /** Rows stored so far, by {@link rowKey}. Null: the trace is closed, store no more. */
  stored: Set<string> | null;
  /** Resolves false when the table already held this trace (after a restart). */
  fresh: Promise<boolean>;
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
  /** Recently stored traces per source: `${tag}:${auth}` → what was stored. */
  private readonly recent = new Map<string, Map<string, SeenTrace>>();
  private readonly lastPrune = new Map<string, number>();

  constructor(private readonly deps: TraceIngestDeps = defaultDeps()) {}

  /**
   * Store one trace for a source. Returns the number of rows written (0 when
   * it was a duplicate or malformed). Never throws.
   */
  async ingest(
    sourceId: string,
    trace: TraceDataEvent,
    localPublicKey: string | null,
    options: TraceIngestOptions = {},
  ): Promise<number> {
    try {
      if (!sourceId || !trace || typeof trace.tag !== 'number') return 0;
      const inFlight = options.inFlight === true;
      const now = this.deps.now();
      const tag = trace.tag >>> 0;
      const authCode = trace.auth_code >>> 0;
      const key = `${tag}:${authCode}`;
      let seen = this.recent.get(sourceId);
      if (!seen) {
        seen = new Map();
        this.recent.set(sourceId, seen);
      }
      for (const [k, entry] of seen) if (entry.at <= now - TRACE_DEDUP_WINDOW_MS) seen.delete(k);

      let entry = seen.get(key);
      // A finished trace is stored whole, once. Only a trace caught in flight
      // can gain rows from a later stage.
      if (entry && (!inFlight || entry.stored === null)) return 0;
      if (!entry) {
        // Claim before the awaits so two copies of one trace cannot both pass.
        // Across a restart the in-memory window is empty; the table still knows.
        entry = {
          at: now,
          stored: inFlight ? new Set() : null,
          fresh: this.deps.hasTrace(sourceId, tag, authCode, now - TRACE_DEDUP_WINDOW_MS).then(
            (has) => !has,
            (error) => {
              logger.warn(`[MeshCore:${sourceId}] Failed to check for a stored trace:`, error);
              return false;
            },
          ),
        };
        seen.set(key, entry);
      }

      const local = localPublicKey ? localPublicKey.toLowerCase() : null;
      // Row identity depends only on the packet, so claim the new rows now,
      // before any await, against what earlier stages stored.
      let claimed: Set<string> | null = null;
      if (entry.stored) {
        const stored = entry.stored;
        claimed = new Set();
        for (const row of traceToHopRows(sourceId, trace, [], local, now, options)) {
          const id = rowKey(row);
          if (stored.has(id)) continue;
          stored.add(id);
          claimed.add(id);
          // Our radio may itself be the next hop. Then it appends this same
          // reading and a later stage carries it back as a path SNR: one
          // measurement, so store it once.
          if (row.receiverHash === null && local) {
            const width = trace.hash_bytes * 2;
            const nextHash = (trace.path_hashes_hex ?? '').toLowerCase().slice(row.hopIndex * width, (row.hopIndex + 1) * width);
            if (nextHash.length === width && local.startsWith(nextHash)) stored.add(`${row.hopIndex}:path`);
          }
        }
        if (claimed.size === 0) return 0;
      }

      if (!(await entry.fresh)) {
        entry.stored = null;
        return 0;
      }

      const keys = await this.deps.listContactKeys(sourceId);
      if (local && !keys.includes(local)) keys.push(local);
      const all = traceToHopRows(sourceId, trace, keys, local, now, options);
      const rows = claimed ? all.filter((r) => claimed.has(rowKey(r))) : all;
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
