/**
 * Shared, bounded position cache for Coverage Report receivers (#5277 P2,
 * §2.2). Used by both `meshtasticManager.maybeRecordCoverageReception`
 * (RF-source local receiver, P1 carry-over (b)) and the MQTT recording hook
 * (`coverageMqtt.ts`, per-gateway lookups). A busy survey session (or a busy
 * MQTT feed with hundreds of gateways) must not hit the `nodes` table on
 * every single reception, and a lookup failure must not be retried on every
 * subsequent packet.
 *
 * Key: `${sourceId}|${nodeNum}` — isolates receivers across sources even
 * when the same physical nodeNum happens to collide (distinct sources are
 * distinct node tables).
 *
 * - **Hit:** the cached value is returned while `now - at < ttl` for that
 *   entry (`ttlMs` on a successful lookup, `failureTtlMs` on a failed one).
 * - **Miss:** `databaseService.nodes.getNode(nodeNum, sourceId)` →
 *   {@link nodeCoveragePosition}, the override-aware rule moved verbatim
 *   from the former per-manager `refreshCoverageReceiverPos`.
 * - **Failure:** a thrown lookup never propagates (`get()` never throws).
 *   With no prior cached value, `{lat: null, lon: null}` is stored, stamped
 *   `now`, expiring after `failureTtlMs` — so a failing receiver is retried
 *   at most once per `failureTtlMs`, not on every reception. With an older
 *   good value present, that value is KEPT and its `at` is pushed forward
 *   (stamped `now`, `failureTtlMs` window) rather than being replaced with
 *   nulls — a transient DB hiccup must not blank out a receiver's position
 *   on the map.
 * - **Single-flight:** concurrent `get()` calls for the same key while a
 *   lookup is in flight share one lookup call instead of stampeding it
 *   (e.g. ten copies of one packet arriving from different gateways in one
 *   MQTT burst, all resolving the SAME gateway's position).
 *
 * See docs/internal/dev-notes/COVERAGE_P2_SPEC.md §2.2 and Decision D11.
 *
 * ## Optional `loader` (#5277 P3, §2.3)
 *
 * The key was always `${sourceId}|${key}`, but `key` was hardwired to a
 * Meshtastic `nodeNum` (number) resolved via `databaseService.nodes.getNode`.
 * A MeshCore Observer receiver is identified by a 64-hex public key
 * (string), resolved via `databaseService.meshcore.getNodeByPublicKeyAndSource`
 * instead — a different table, a different key type, and a different
 * bogus-position rule (the MeshCore loader filters through
 * `shouldDiscardPosition`, which the Meshtastic default does not). Rather
 * than special-case the type inside this class, the constructor takes an
 * optional `loader` that replaces the Meshtastic-specific lookup entirely;
 * everything else (TTL, failure TTL, LRU, single-flight) applies unchanged
 * to either loader. The default loader is exactly today's
 * `nodes.getNode(Number(key), sourceId)` path, so every existing
 * caller/test is unaffected.
 */

import databaseService from '../../services/database.js';
import type { DbNode } from '../../db/types.js';
import { LruCache } from './lruCache.js';
import { logger } from '../../utils/logger.js';

export interface ReceiverPos {
  lat: number | null;
  lon: number | null;
}

interface CacheEntry {
  pos: ReceiverPos;
  at: number;
  ttl: number;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_FAILURE_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 2000;

/**
 * Resolve a node row into the position Coverage should snapshot for it:
 * the manual lat/lon override when enabled and fully populated, otherwise
 * the node's live position. Pure. `null`/undefined node (no row, e.g. a
 * gateway MeshMonitor has never seen a NodeInfo for) yields
 * `{lat: null, lon: null}`.
 */
export function nodeCoveragePosition(node: DbNode | null | undefined): ReceiverPos {
  const hasOverride =
    node?.positionOverrideEnabled === true &&
    node?.latitudeOverride != null &&
    node?.longitudeOverride != null;
  const lat = hasOverride ? node!.latitudeOverride! : (node?.latitude ?? null);
  const lon = hasOverride ? node!.longitudeOverride! : (node?.longitude ?? null);
  return { lat: lat ?? null, lon: lon ?? null };
}

/** Today's Meshtastic lookup path, unchanged, as the default loader. */
async function defaultReceiverPositionLoader(sourceId: string, key: string): Promise<ReceiverPos> {
  const node = await databaseService.nodes.getNode(Number(key), sourceId);
  return nodeCoveragePosition(node);
}

export class CoverageReceiverPositionCache {
  private readonly cache: LruCache<string, CacheEntry>;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly inFlight = new Map<string, Promise<ReceiverPos>>();
  private readonly loader: (sourceId: string, key: string) => Promise<ReceiverPos>;

  constructor(opts?: {
    ttlMs?: number;
    failureTtlMs?: number;
    maxEntries?: number;
    loader?: (sourceId: string, key: string) => Promise<ReceiverPos>;
  }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.failureTtlMs = opts?.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
    this.cache = new LruCache<string, CacheEntry>(opts?.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.loader = opts?.loader ?? defaultReceiverPositionLoader;
  }

  /** Never throws — a lookup failure resolves to the best available (possibly null) position. */
  async get(sourceId: string, receiverKey: number | string): Promise<ReceiverPos> {
    const keyStr = String(receiverKey);
    const key = `${sourceId}|${keyStr}`;
    const now = Date.now();

    const cached = this.cache.get(key);
    if (cached && now - cached.at < cached.ttl) {
      return cached.pos;
    }

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const loader = (async (): Promise<ReceiverPos> => {
      try {
        const pos = await this.loader(sourceId, keyStr);
        this.cache.set(key, { pos, at: Date.now(), ttl: this.ttlMs });
        return pos;
      } catch (err) {
        logger.debug(`📡 Coverage receiver position lookup failed for ${key} (non-fatal): ${err}`);
        // Re-read rather than reuse the `cached` closure value: nothing else
        // could have written this key while the loader awaited (single-flight),
        // so this is exactly the pre-lookup value, but going through the
        // cache keeps this branch correct even if that invariant ever changes.
        const prior = this.cache.get(key);
        const pos = prior ? prior.pos : { lat: null, lon: null };
        this.cache.set(key, { pos, at: Date.now(), ttl: this.failureTtlMs });
        return pos;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, loader);
    return loader;
  }

  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }
}
