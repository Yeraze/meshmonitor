/**
 * Transport-traffic writer (#5101 Phase 3 WP3).
 *
 * Computes two per-transport time series — "nodes heard" and "packets RX" —
 * in fixed 5-minute bins (`TRANSPORT_SERIES_BIN_MS`), for every Meshtastic
 * TCP source. "Nodes heard" comes from the DB-persisted per-transport stamps
 * (`nodes.transportLast{Rf,Mqtt,Udp}`, migration 126) via
 * `NodesRepository.countNodesHeardByTransport`. "Packets RX" comes from an
 * in-memory counter fed by a single hook at the packet-receive seam in
 * `meshtasticManager.ts`, backed by a per-source DB checkpoint (a
 * `transportTrafficCheckpoint` settings row) so in-progress counts survive a
 * restart.
 *
 * See `docs/internal/dev-notes/TRANSPORT_BREAKDOWN_P3_SPEC.md` §3.4 for the
 * full design this file implements (restore/recovery, the two independent
 * timers, invariant I1, and the risk log — R1-R13).
 *
 * Invariant I1: a bin's telemetry rows are NEVER written before the bin
 * closes. The 032 unique index (sourceId, nodeNum, packetId, telemetryType)
 * keeps the first write, so an early write would freeze a partial count.
 *
 * R2 (documented, not fixed here): the counter does not use the packet-log
 * dedup map, so a firmware double-delivered packet (#4811) counts twice.
 * R6 (documented): the synthetic `packetId` (`transportBinIndex`) is not
 * joined to `packet_log` — nothing else reads `telemetry.packetId` for
 * `system*` types, and the unique tuple already includes `telemetryType`.
 *
 * R13 (found in restart validation, fixed): "bin opened" is itself a
 * checkpoint event, independent of `dirty`. An idle source's bin never goes
 * dirty, so the original dirty-only 30s cadence never checkpointed it — its
 * persisted checkpoint kept pointing at whatever bin it was last dirty in,
 * possibly several bins ago. A crash landed between then and the idle bin's
 * boundary left NO checkpoint at all for that closed bin, so `start()`'s
 * recovery had nothing to recover from: a hole in both series for that bin,
 * even though its nodes-heard count (from DB stamps, independent of the
 * counter) was real. `writeBinOpenedCheckpoint` (called once per source at
 * `start()` and once per source at each `flush()` rollover — see below) now
 * persists a checkpoint the moment a new bin opens for a source whose
 * identity is known, using whatever counts already exist (0 for a genuinely
 * idle source). The existing dirty-only 30s cadence inside a bin is
 * unchanged — this adds one upsert per source per 5-minute bin, not per 30s.
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import type { ISourceManager } from '../sourceManagerRegistry.js';
import { isMeshtasticManager } from '../sourceManagerTypes.js';
import type { NodeTransportClass } from '../../utils/nodeTransport.js';
import {
  TRANSPORT_SERIES_BIN_MS,
  TRANSPORT_CHECKPOINT_INTERVAL_MS,
  TRANSPORT_CHECKPOINT_SETTING_KEY,
  binStartOf,
  buildTransportSeriesRows,
  encodeTransportCheckpoint,
  decodeTransportCheckpoint,
  type TransportCounts,
} from '../../utils/transportSeries.js';

/** Recovered bins older than this are skipped — the retention purge would delete them anyway. */
const RECOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Checkpoint codec version (mirrors the private constant in transportSeries.ts). */
const CHECKPOINT_VERSION = 1 as const;

interface BinState extends TransportCounts {
  binStartMs: number;
  /** Local-node identity, when known. Filled from the manager at checkpoint/flush time. */
  nodeId: string | null;
  nodeNum: number | null;
  /** Changed since the last checkpoint. */
  dirty: boolean;
}

function emptyCounts(): TransportCounts {
  return { rf: 0, udp: 0, mqtt: 0 };
}

export interface TransportTrafficServiceDeps {
  getManagers: () => ISourceManager[];
  db: Pick<typeof databaseService, 'insertTelemetryAsync' | 'nodes' | 'settings' | 'sources'>;
  /** Injectable clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export class TransportTrafficService {
  /**
   * sourceId -> binStartMs -> state. Holds the in-progress bin plus, briefly,
   * the one just closed (a packet can land after a boundary, before its flush).
   */
  private bins = new Map<string, Map<number, BinState>>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  /** Guards re-entrant start() and stops timer re-arming once stop() has run. */
  private running = false;

  constructor(private readonly deps: TransportTrafficServiceDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private getOrCreateBin(sourceId: string, binStartMs: number): BinState {
    let perSource = this.bins.get(sourceId);
    if (!perSource) {
      perSource = new Map<number, BinState>();
      this.bins.set(sourceId, perSource);
    }
    let bin = perSource.get(binStartMs);
    if (!bin) {
      bin = { binStartMs, nodeId: null, nodeNum: null, dirty: false, ...emptyCounts() };
      perSource.set(binStartMs, bin);
    }
    return bin;
  }

  /**
   * Record one received packet's transport class for `sourceId`'s in-progress
   * bin. Sync, O(1), and never throws — this runs on the hot packet-receive
   * path in meshtasticManager.ts and must never delay packet processing.
   */
  recordRx(sourceId: string, cls: NodeTransportClass): void {
    try {
      const bin = this.getOrCreateBin(sourceId, binStartOf(this.now()));
      bin[cls] += 1;
      bin.dirty = true;
    } catch (error) {
      logger.warn(`transportTrafficService.recordRx failed for source ${sourceId}:`, error);
    }
  }

  /**
   * Restore/recover checkpoints, then arm both timers. Idempotent — a second
   * call while already running is a no-op. Must run BEFORE any manager can
   * receive a packet (R10): the caller wires this before `bootstrapSources`.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.restoreAndRecover();
    } catch (error) {
      logger.warn('transportTrafficService.start: restore/recovery failed, continuing without it:', error);
    }
    try {
      // R13: cover a known-identity source that restoreAndRecover() did not
      // already seed a fresh `cur` checkpoint for (no prior checkpoint at
      // all, but its manager already happens to be connected). In
      // production start() runs before bootstrapSources connects anything
      // (R10), so this is normally a no-op there; the recovery branch
      // inside restoreAndRecover() is what covers the real-world case.
      await this.ensureCurrentBinCheckpoints();
    } catch (error) {
      logger.warn('transportTrafficService.start: bin-open checkpoint pass failed, continuing:', error);
    }
    this.armFlushTimer();
    this.armCheckpointTimer();
  }

  private async restoreAndRecover(): Promise<void> {
    const sources = await this.deps.db.sources.getAllSources();
    const ids = sources.map((s) => s.id);
    if (ids.length === 0) return;

    const checkpoints = await this.deps.db.settings.getSettingForSources(ids, TRANSPORT_CHECKPOINT_SETTING_KEY);
    const cur = binStartOf(this.now());

    for (const sourceId of ids) {
      const raw = checkpoints.get(sourceId);
      if (raw === undefined) continue;

      const cp = decodeTransportCheckpoint(raw);
      if (!cp) {
        logger.warn(`transportTrafficService: discarding an unreadable checkpoint for source ${sourceId}`);
        continue;
      }

      if (cp.binStartMs === cur) {
        // Restart inside the bin: seed counts + identity. New packets add to
        // it; the bin is written once, at its normal boundary.
        const bin = this.getOrCreateBin(sourceId, cp.binStartMs);
        bin.rf = cp.rf;
        bin.udp = cp.udp;
        bin.mqtt = cp.mqtt;
        bin.nodeId = cp.nodeId;
        bin.nodeNum = cp.nodeNum;
        bin.dirty = false;
      } else if (cp.binStartMs < cur) {
        // The bin closed while the server was down: write it now. Packets
        // come from the checkpoint; nodes heard are exact, since no packet
        // has arrived since shutdown so no stamp in this window has moved.
        const binEndMs = cp.binStartMs + TRANSPORT_SERIES_BIN_MS;
        if (this.now() - binEndMs <= RECOVERY_MAX_AGE_MS) {
          try {
            await this.writeBin(sourceId, binEndMs, {
              nodeId: cp.nodeId,
              nodeNum: cp.nodeNum,
              packetsRx: { rf: cp.rf, udp: cp.udp, mqtt: cp.mqtt },
            });
          } catch (error) {
            logger.warn(`transportTrafficService: recovery write failed for source ${sourceId}:`, error);
          }
        }
        // R13: whether or not the closed bin's rows were recovered above
        // (the 7-day skip only excuses the WRITE, not this), the bin that is
        // current NOW needs its own "bin opened" checkpoint right away —
        // this source's identity is known (it's in the checkpoint we just
        // read) even though no manager has connected yet (R10). Without
        // this, a source that stays idle through the whole new bin leaves
        // the exact same hole on the NEXT restart that this fix closes now.
        await this.writeBinOpenedCheckpoint(sourceId, cur, cp.nodeId, cp.nodeNum);
      } else {
        // cp.binStartMs > cur: the clock went backwards. Discard.
        logger.warn(`transportTrafficService: checkpoint for source ${sourceId} is in the future — clock went backwards? Discarding.`);
      }
    }
  }

  /**
   * Compute nodes-heard for the closed bin `[binEndMs - BIN, binEndMs]` and
   * insert all six rows. Shared by the flush path and start()'s recovery
   * path. Never called for the bin currently in progress (invariant I1).
   */
  private async writeBin(
    sourceId: string,
    binEndMs: number,
    args: { nodeId: string; nodeNum: number; packetsRx: TransportCounts },
  ): Promise<void> {
    const binStartSec = Math.floor((binEndMs - TRANSPORT_SERIES_BIN_MS) / 1000);
    const binEndSec = Math.floor(binEndMs / 1000);
    const nodesHeard = await this.deps.db.nodes.countNodesHeardByTransport(
      sourceId,
      binStartSec,
      binEndSec,
      args.nodeNum,
    );
    const rows = buildTransportSeriesRows({
      nodeId: args.nodeId,
      nodeNum: args.nodeNum,
      binEndMs,
      nowMs: this.now(),
      nodesHeard,
      packetsRx: args.packetsRx,
    });
    for (const row of rows) {
      await this.deps.db.insertTelemetryAsync(row, sourceId);
    }
  }

  /**
   * Flush the bin that just closed at `binEndMs` (i.e. `[binEndMs - BIN,
   * binEndMs)`). Public for tests. Single-flight: a concurrent call is a
   * silent no-op.
   */
  async flush(binEndMs: number): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const binStartMs = binEndMs - TRANSPORT_SERIES_BIN_MS;
      const managers = this.deps.getManagers().filter(isMeshtasticManager);
      const managerBySourceId = new Map(managers.map((m) => [m.sourceId, m]));

      const sourceIds = new Set<string>(managerBySourceId.keys());
      for (const [sourceId, perSource] of this.bins) {
        if (perSource.has(binStartMs)) sourceIds.add(sourceId);
      }

      for (const sourceId of sourceIds) {
        try {
          const manager = managerBySourceId.get(sourceId);
          const bin = this.bins.get(sourceId)?.get(binStartMs);

          let identity: { nodeId: string; nodeNum: number } | null = null;
          if (manager && manager.getStatus().connected) {
            const info = manager.getLocalNodeInfo();
            if (info) identity = { nodeId: info.nodeId, nodeNum: info.nodeNum };
          }
          if (!identity && bin?.nodeId != null && bin?.nodeNum != null) {
            identity = { nodeId: bin.nodeId, nodeNum: bin.nodeNum };
          }
          // No listener and no counts: a bin has no honest value. Skip.
          if (!identity) continue;

          const packetsRx: TransportCounts = bin
            ? { rf: bin.rf, udp: bin.udp, mqtt: bin.mqtt }
            : emptyCounts();

          try {
            await this.writeBin(sourceId, binEndMs, {
              nodeId: identity.nodeId,
              nodeNum: identity.nodeNum,
              packetsRx,
            });
          } catch (error) {
            logger.warn(`transportTrafficService: flush failed for source ${sourceId}:`, error);
          }

          // R13: the bin that just opened (`binEndMs`) gets its own
          // checkpoint right away, independent of whether it ever goes
          // dirty. Runs even when the write above failed — continuity for
          // the NEW bin does not depend on whether the just-closed bin's
          // telemetry made it.
          await this.writeBinOpenedCheckpoint(sourceId, binEndMs, identity.nodeId, identity.nodeNum);
        } catch (error) {
          // One source's failure must never block another's flush.
          logger.warn(`transportTrafficService: flush failed for source ${sourceId}:`, error);
        }
      }

      // Drop BinStates strictly older than the new current bin (binEndMs).
      // The checkpoint row is NOT deleted here — it is naturally overwritten
      // by the next bin's first checkpoint, and a stale one is harmless
      // (recovery would just re-insert an existing bin, a no-op via I1).
      for (const perSource of this.bins.values()) {
        for (const key of Array.from(perSource.keys())) {
          if (key < binEndMs) perSource.delete(key);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private armFlushTimer(): void {
    const now = this.now();
    const next = (Math.floor(now / TRANSPORT_SERIES_BIN_MS) + 1) * TRANSPORT_SERIES_BIN_MS;
    const delay = next - now + 2_000;
    const timer = setTimeout(() => {
      void this.flush(next).finally(() => {
        if (this.running) this.armFlushTimer();
      });
    }, delay);
    timer.unref?.();
    this.flushTimer = timer;
  }

  private armCheckpointTimer(): void {
    const timer = setInterval(() => {
      void this.checkpointAll();
    }, TRANSPORT_CHECKPOINT_INTERVAL_MS);
    timer.unref?.();
    this.checkpointTimer = timer;
  }

  /**
   * Checkpoint every source's current bin that is `dirty`. Public for tests.
   * At most one settings upsert per source per call, and none on an idle
   * source (an idle source's own "bin opened" checkpoint — see
   * `writeBinOpenedCheckpoint` — already covers it once per bin; R13). Errors
   * per source are caught and logged; one source's DB failure never blocks
   * another's checkpoint.
   */
  async checkpointAll(): Promise<void> {
    const cur = binStartOf(this.now());
    for (const [sourceId, perSource] of this.bins) {
      const bin = perSource.get(cur);
      if (!bin || !bin.dirty) continue;

      if (bin.nodeId === null || bin.nodeNum === null) {
        const manager = this.deps.getManagers().find((m) => m.sourceId === sourceId);
        const info = manager?.getLocalNodeInfo();
        if (info) {
          bin.nodeId = info.nodeId;
          bin.nodeNum = info.nodeNum;
        }
      }
      // Identity still unknown: recovery could not key the rows. Skip.
      if (bin.nodeId === null || bin.nodeNum === null) {
        logger.warn(`transportTrafficService: skipping checkpoint for source ${sourceId} — identity unknown`);
        continue;
      }

      await this.persistCheckpoint(sourceId, bin);
    }
  }

  /**
   * Encode and persist `bin` as `sourceId`'s checkpoint, then clear `dirty`.
   * Shared by the dirty-only 30s cadence (`checkpointAll`, above) and the
   * "bin opened" event (`writeBinOpenedCheckpoint`, below — R13). Assumes
   * the caller has already ensured `bin.nodeId`/`bin.nodeNum` are set.
   * Self-contained: catches and logs its own errors, never throws, so
   * callers never need their own try/catch around it.
   */
  private async persistCheckpoint(sourceId: string, bin: BinState): Promise<void> {
    if (bin.nodeId === null || bin.nodeNum === null) return;
    try {
      const encoded = encodeTransportCheckpoint({
        v: CHECKPOINT_VERSION,
        binStartMs: bin.binStartMs,
        nodeId: bin.nodeId,
        nodeNum: bin.nodeNum,
        rf: bin.rf,
        udp: bin.udp,
        mqtt: bin.mqtt,
      });
      await this.deps.db.settings.setSourceSetting(sourceId, TRANSPORT_CHECKPOINT_SETTING_KEY, encoded);
      bin.dirty = false;
    } catch (error) {
      logger.warn(`transportTrafficService: checkpoint failed for source ${sourceId}:`, error);
    }
  }

  /**
   * R13: persist a checkpoint for `binStartMs` the moment it opens for
   * `sourceId`, independent of `dirty`. Writes whatever counts already exist
   * for that bin — 0 for a source that is genuinely idle, or
   * already-accumulated counts if a packet raced in between the boundary and
   * this call (see the flush() post-boundary-packet test). Called at most
   * once per source per bin: once at `start()` (via `ensureCurrentBinCheckpoints`
   * or the recovery branch of `restoreAndRecover`) and once per source at
   * each `flush()` rollover — never on the dirty-only 30s tick.
   */
  private async writeBinOpenedCheckpoint(
    sourceId: string,
    binStartMs: number,
    nodeId: string,
    nodeNum: number,
  ): Promise<void> {
    const bin = this.getOrCreateBin(sourceId, binStartMs);
    if (bin.nodeId === null) {
      bin.nodeId = nodeId;
      bin.nodeNum = nodeNum;
    }
    await this.persistCheckpoint(sourceId, bin);
  }

  /**
   * R13, start()-time half: for every Meshtastic TCP manager whose identity
   * is already known but whose current bin was not already seeded by
   * `restoreAndRecover()` (no prior checkpoint at all), open and checkpoint
   * its current bin now. In real deployments `start()` runs before
   * `bootstrapSources` connects anything (R10), so this is ordinarily a
   * no-op there; it exists so the guarantee holds regardless of connection
   * order (and is exercised directly in tests).
   */
  private async ensureCurrentBinCheckpoints(): Promise<void> {
    const cur = binStartOf(this.now());
    for (const manager of this.deps.getManagers().filter(isMeshtasticManager)) {
      const info = manager.getLocalNodeInfo();
      if (!info) continue;
      const bin = this.bins.get(manager.sourceId)?.get(cur);
      if (bin && bin.nodeId !== null) continue; // already seeded (restore, or an earlier pass this call)
      await this.writeBinOpenedCheckpoint(manager.sourceId, cur, info.nodeId, info.nodeNum);
    }
  }

  /**
   * Clear both timers, then checkpoint every dirty current bin so the next
   * start() restores the exact count. Never throws — a settings write
   * failure during shutdown must not block the shutdown sequence.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
    }
    try {
      await this.checkpointAll();
    } catch (error) {
      logger.warn('transportTrafficService.stop: checkpoint on shutdown failed:', error);
    }
  }
}

export const transportTrafficService = new TransportTrafficService({
  getManagers: () => sourceManagerRegistry.getAllManagers(),
  db: databaseService,
});
