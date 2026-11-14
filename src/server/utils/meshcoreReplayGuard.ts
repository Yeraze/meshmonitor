/**
 * Clock-free MeshCore advert replay guard (Coverage Report D3, #5277).
 * Moved out of `coverageMeshCore.ts` so the Direct RF Contacts recorder
 * (#6210) can keep its own instance without importing the Coverage module.
 */
import { LruCache } from './lruCache.js';

interface ReplayGuardEntry {
  maxTs: number;
  packetKey: string;
  firstSeenMs: number;
  updatedMs: number;
}

const REPLAY_GUARD_DEFAULT_MAX_ENTRIES = 10_000;
const REPLAY_GUARD_DEFAULT_PATH_WINDOW_MS = 60_000;
const REPLAY_GUARD_DEFAULT_TTL_MS = 3_600_000;

/**
 * Clock-free replay guard (D3). MeshCore advert timestamps are the SENDER's
 * clock, and are often badly wrong, so this cannot be an advert-age rule
 * like the Meshtastic `isStaleCoverageRxTime` check. Instead it mirrors
 * firmware's own replay rule (`timestamp <= last_advert_timestamp` -> "possible
 * replay") and catches a shared-contact re-send: `shareContactZeroHop`
 * re-transmits the STORED advert bytes zero-hop from a third node
 * (`BaseChatMesh.cpp`), which looks like a direct reception from the
 * original sender with the sharer's SNR.
 *
 * State per key (`${sourceId}|${receiverId}|${senderId}`) in a bounded LRU:
 * - No entry, or the entry is older than `ttlMs` (measured from its last
 *   ACCEPTED update, never touched on a reject) -> accept, store. This is
 *   the recovery path for a receiver clock that jumped backwards (reboot
 *   without time sync): after an hour of nothing but rejects, the next
 *   packet is treated as fresh again.
 * - `advertTs > maxTs` -> accept, store the new advert (a genuinely newer
 *   advert instance).
 * - `advertTs === maxTs && packetKey === entry.packetKey && nowMs -
 *   firstSeenMs <= pathWindowMs` -> accept (another relayed copy of the SAME
 *   advert, arriving via a different path within the window).
 * - Else -> reject.
 *
 * Residual (documented, not fixed here, §2.2): a share of an advert this
 * receiver has not heard in the last `ttlMs` records as a zero-hop
 * reception, indistinguishable from a genuine direct hearing.
 */
export class MeshCoreReplayGuard {
  private readonly cache: LruCache<string, ReplayGuardEntry>;
  private readonly pathWindowMs: number;
  private readonly ttlMs: number;

  constructor(opts?: { maxEntries?: number; pathWindowMs?: number; ttlMs?: number }) {
    this.cache = new LruCache<string, ReplayGuardEntry>(opts?.maxEntries ?? REPLAY_GUARD_DEFAULT_MAX_ENTRIES);
    this.pathWindowMs = opts?.pathWindowMs ?? REPLAY_GUARD_DEFAULT_PATH_WINDOW_MS;
    this.ttlMs = opts?.ttlMs ?? REPLAY_GUARD_DEFAULT_TTL_MS;
  }

  /** True = accept and record; false = reject as a replay. */
  check(key: string, advertTs: number, packetKey: string, nowMs: number): boolean {
    // `get()` promotes recency on a hit, so a rejected (unmodified) entry
    // still stays alive in the LRU as long as it's being consulted.
    const entry = this.cache.get(key);

    if (!entry || nowMs - entry.updatedMs > this.ttlMs) {
      this.cache.set(key, { maxTs: advertTs, packetKey, firstSeenMs: nowMs, updatedMs: nowMs });
      return true;
    }

    if (advertTs > entry.maxTs) {
      this.cache.set(key, { maxTs: advertTs, packetKey, firstSeenMs: nowMs, updatedMs: nowMs });
      return true;
    }

    if (advertTs === entry.maxTs && packetKey === entry.packetKey && nowMs - entry.firstSeenMs <= this.pathWindowMs) {
      this.cache.set(key, { ...entry, updatedMs: nowMs });
      return true;
    }

    return false;
  }

  clear(): void {
    this.cache.clear();
  }
}
