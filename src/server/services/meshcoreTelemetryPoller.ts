/**
 * MeshCore Telemetry Poller — local-node-only stats collection.
 *
 * Walks every connected MeshCore COMPANION manager on a fixed interval and
 * pulls GetStats(core|radio|packets), GetDeviceTime, and DeviceQuery over
 * the companion-protocol link. None of these commands touch the air; they
 * read counters and config off the directly-attached node only.
 *
 * Each sample writes rows into the existing `telemetry` table with
 * `telemetryType` strings prefixed `mc_` and the manager's `sourceId`
 * stamped on every row. Cumulative counters (txAirSecs, rxAirSecs, packet
 * totals) are also differenced against the prior sample to produce
 * `mc_tx_duty_pct`, `mc_rx_duty_pct`, and `mc_pkt_*_rate` time-series.
 *
 * The latest in-memory sample per source is exposed via `getLastSnapshot()`
 * so the Info endpoint can render current health without re-querying the
 * device on every page-load.
 */

import { logger } from '../../utils/logger.js';
import type { DbTelemetry } from '../../services/database.js';
import type { MeshCoreManager, MeshCoreDeviceInfo } from '../meshcoreManager.js';
import type { MeshCoreManagerRegistry } from '../meshcoreRegistry.js';

/**
 * Minimal slice of DatabaseService the poller depends on. Lets us unit-test
 * without spinning up better-sqlite3.
 */
export interface PollerDatabase {
  telemetry: {
    insertTelemetryBatch: (rows: DbTelemetry[], sourceId?: string) => Promise<number>;
  };
}

/**
 * Default poll interval (5 minutes). Override via the `MESHCORE_TELEMETRY_INTERVAL_MS`
 * environment variable. Clamped to a minimum of 10 seconds to keep
 * runaway configs from melting the bridge.
 */
export const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
const MIN_POLL_INTERVAL_MS = 10 * 1000;

/** Telemetry type prefix used for every MeshCore-source-derived sample. */
export const MC_TELEMETRY_PREFIX = 'mc_';

/**
 * Snapshot of the most recent poll for a given source. Held in-memory and
 * returned by `/api/sources/:id/meshcore/info` so the Info page can render
 * latest values without forcing a synchronous bridge round-trip.
 */
export interface MeshCorePollSnapshot {
  /** Wall-clock timestamp of the poll (ms since epoch). */
  timestamp: number;
  batteryMv?: number;
  uptimeSecs?: number;
  errors?: number;
  queueLen?: number;
  noiseFloor?: number;
  lastRssi?: number;
  lastSnr?: number;
  txAirSecs?: number;
  rxAirSecs?: number;
  txDutyPct?: number;
  rxDutyPct?: number;
  packetsRecv?: number;
  packetsSent?: number;
  floodTx?: number;
  directTx?: number;
  floodRx?: number;
  directRx?: number;
  recvErrors?: number | null;
  packetsRecvRatePerMin?: number;
  packetsSentRatePerMin?: number;
  rtcDriftSecs?: number;
  /** Most recent DeviceQuery payload from this source, if any. */
  deviceInfo?: MeshCoreDeviceInfo;
}

interface PrevSample {
  ts: number;
  txAirSecs?: number;
  rxAirSecs?: number;
  packetsRecv?: number;
  packetsSent?: number;
}

export interface MeshCoreTelemetryPollerOptions {
  registry: MeshCoreManagerRegistry;
  database: PollerDatabase;
  /** Override the env-derived interval (mostly for tests). */
  intervalMs?: number;
}

/**
 * Parse the configured interval, applying the floor and falling back to
 * the default on any non-positive or unparseable value.
 */
export function resolvePollIntervalMs(envValue: string | undefined): number {
  if (!envValue) return DEFAULT_POLL_INTERVAL_MS;
  const parsed = parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_POLL_INTERVAL_MS;
  return Math.max(parsed, MIN_POLL_INTERVAL_MS);
}

export class MeshCoreTelemetryPoller {
  private readonly registry: MeshCoreManagerRegistry;
  private readonly database: PollerDatabase;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly prevSamples = new Map<string, PrevSample>();
  private readonly lastSnapshots = new Map<string, MeshCorePollSnapshot>();

  constructor(opts: MeshCoreTelemetryPollerOptions) {
    this.registry = opts.registry;
    this.database = opts.database;
    this.intervalMs = opts.intervalMs ?? resolvePollIntervalMs(process.env.MESHCORE_TELEMETRY_INTERVAL_MS);
  }

  /** Start the recurring poll. No-op if already running. */
  start(): void {
    if (this.timer) return;
    logger.info(
      `[MeshCorePoller] Starting local-node telemetry poll every ${Math.round(this.intervalMs / 1000)}s`,
    );
    this.timer = setInterval(() => {
      this.pollOnce().catch((err) =>
        logger.error('[MeshCorePoller] Unhandled error in poll cycle:', err),
      );
    }, this.intervalMs);
    // Allow the process to exit even if this timer is alive (parity with
    // other intervals registered alongside it in server.ts).
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Stop the recurring poll. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Visible for tests. Returns the latest cached snapshot for a source. */
  getLastSnapshot(sourceId: string): MeshCorePollSnapshot | undefined {
    return this.lastSnapshots.get(sourceId);
  }

  /** Visible for tests. Drop cached state for a source (e.g. on disconnect). */
  clearSource(sourceId: string): void {
    this.prevSamples.delete(sourceId);
    this.lastSnapshots.delete(sourceId);
  }

  /**
   * Walk all registered managers and sample any connected companions.
   * Failures on one source never block another — each manager polls inside
   * its own try/catch. Concurrency intentionally low (sequential): the
   * bridges are stdin/stdout pipes and parallelism wouldn't help, but a
   * bug in one bridge would corrupt the shared event loop more visibly.
   */
  async pollOnce(): Promise<void> {
    if (this.running) {
      logger.debug('[MeshCorePoller] Previous poll still running, skipping tick');
      return;
    }
    this.running = true;
    try {
      const managers = this.registry.list();
      for (const manager of managers) {
        try {
          await this.pollManager(manager);
        } catch (err) {
          logger.warn(`[MeshCorePoller:${manager.sourceId}] Poll failed:`, err);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Sample one manager. Visible for tests. Skips disconnected sources and
   * sources whose localNode hasn't been resolved yet (we need a publicKey
   * to key telemetry rows on).
   */
  async pollManager(manager: MeshCoreManager): Promise<void> {
    if (!manager.isConnected()) return;
    const localNode = manager.getLocalNode();
    if (!localNode || !localNode.publicKey) {
      logger.debug(`[MeshCorePoller:${manager.sourceId}] No localNode yet, skipping`);
      return;
    }

    const now = Date.now();
    // Fetch in parallel — they're independent bridge calls and the bridge
    // serializes them anyway, but Promise.all keeps the error path tidy.
    const [core, radio, packets, deviceTimeSecs, deviceInfo] = await Promise.all([
      manager.getStatsCore(),
      manager.getStatsRadio(),
      manager.getStatsPackets(),
      manager.getDeviceTime(),
      manager.deviceQuery(),
    ]);

    if (deviceInfo) {
      manager.applyDeviceInfo(deviceInfo);
    }

    const nodeId = localNode.publicKey;
    // MeshCore has no Meshtastic-style 32-bit nodeNum. We synthesise one from
    // the low 32 bits of the pubkey to satisfy the NOT NULL constraint on
    // `telemetry.nodeNum` while keeping it stable per source. Collisions are
    // possible but harmless — queries filter on `nodeId`, not `nodeNum`.
    const nodeNum = nodeNumFromPubkey(localNode.publicKey);
    const rows: DbTelemetry[] = [];
    const push = (telemetryType: string, value: number | null | undefined, unit?: string) => {
      if (value === null || value === undefined || !Number.isFinite(value)) return;
      rows.push({
        nodeId,
        nodeNum,
        telemetryType,
        value,
        unit,
        timestamp: now,
        createdAt: now,
      });
    };

    const snapshot: MeshCorePollSnapshot = { timestamp: now };
    if (deviceInfo) snapshot.deviceInfo = deviceInfo;

    if (core) {
      if (core.batteryMv !== undefined) {
        push(`${MC_TELEMETRY_PREFIX}battery_mv`, core.batteryMv, 'mV');
        // Also store the volts-form so the existing telemetry-graph
        // formatters that key off `voltage` units pick it up nicely.
        push(`${MC_TELEMETRY_PREFIX}battery_volts`, core.batteryMv / 1000, 'V');
        snapshot.batteryMv = core.batteryMv;
      }
      if (core.uptimeSecs !== undefined) {
        push(`${MC_TELEMETRY_PREFIX}uptime_secs`, core.uptimeSecs, 's');
        snapshot.uptimeSecs = core.uptimeSecs;
      }
      if (core.errors !== undefined) {
        push(`${MC_TELEMETRY_PREFIX}errors`, core.errors);
        snapshot.errors = core.errors;
      }
      if (core.queueLen !== undefined) {
        push(`${MC_TELEMETRY_PREFIX}queue_len`, core.queueLen);
        snapshot.queueLen = core.queueLen;
      }
    }

    if (radio) {
      if (radio.noiseFloor !== undefined) {
        push(`${MC_TELEMETRY_PREFIX}noise_floor`, radio.noiseFloor, 'dBm');
        snapshot.noiseFloor = radio.noiseFloor;
      }
      if (radio.lastRssi !== undefined) {
        push(`${MC_TELEMETRY_PREFIX}last_rssi`, radio.lastRssi, 'dBm');
        snapshot.lastRssi = radio.lastRssi;
      }
      if (radio.lastSnr !== undefined) {
        push(`${MC_TELEMETRY_PREFIX}last_snr`, radio.lastSnr, 'dB');
        snapshot.lastSnr = radio.lastSnr;
      }
      if (radio.txAirSecs !== undefined) {
        push(`${MC_TELEMETRY_PREFIX}tx_air_secs`, radio.txAirSecs, 's');
        snapshot.txAirSecs = radio.txAirSecs;
      }
      if (radio.rxAirSecs !== undefined) {
        push(`${MC_TELEMETRY_PREFIX}rx_air_secs`, radio.rxAirSecs, 's');
        snapshot.rxAirSecs = radio.rxAirSecs;
      }
    }

    if (packets) {
      if (packets.recv !== undefined) {
        push(`${MC_TELEMETRY_PREFIX}pkt_recv`, packets.recv);
        snapshot.packetsRecv = packets.recv;
      }
      if (packets.sent !== undefined) {
        push(`${MC_TELEMETRY_PREFIX}pkt_sent`, packets.sent);
        snapshot.packetsSent = packets.sent;
      }
      if (packets.floodTx !== undefined) {
        push(`${MC_TELEMETRY_PREFIX}pkt_flood_tx`, packets.floodTx);
        snapshot.floodTx = packets.floodTx;
      }
      if (packets.directTx !== undefined) {
        push(`${MC_TELEMETRY_PREFIX}pkt_direct_tx`, packets.directTx);
        snapshot.directTx = packets.directTx;
      }
      if (packets.floodRx !== undefined) {
        push(`${MC_TELEMETRY_PREFIX}pkt_flood_rx`, packets.floodRx);
        snapshot.floodRx = packets.floodRx;
      }
      if (packets.directRx !== undefined) {
        push(`${MC_TELEMETRY_PREFIX}pkt_direct_rx`, packets.directRx);
        snapshot.directRx = packets.directRx;
      }
      if (packets.recvErrors !== null && packets.recvErrors !== undefined) {
        push(`${MC_TELEMETRY_PREFIX}pkt_recv_errors`, packets.recvErrors);
        snapshot.recvErrors = packets.recvErrors;
      } else {
        snapshot.recvErrors = packets.recvErrors ?? null;
      }
    }

    if (deviceTimeSecs !== null) {
      const drift = Math.floor(now / 1000) - deviceTimeSecs;
      push(`${MC_TELEMETRY_PREFIX}rtc_drift_secs`, drift, 's');
      snapshot.rtcDriftSecs = drift;
    }

    if (deviceInfo && typeof deviceInfo.firmwareVer === 'number') {
      push(`${MC_TELEMETRY_PREFIX}firmware_ver`, deviceInfo.firmwareVer);
    }

    // ---- Compute deltas / rates against the prior sample ----
    const prev = this.prevSamples.get(manager.sourceId);
    if (prev) {
      const dtSecs = (now - prev.ts) / 1000;
      if (dtSecs > 0) {
        // Duty-cycle = cumulative-air-time delta / wall-clock delta.
        // Clamp to [0, 100] to absorb counter resets and minor rollover.
        if (radio?.txAirSecs !== undefined && prev.txAirSecs !== undefined) {
          const delta = radio.txAirSecs - prev.txAirSecs;
          if (delta >= 0) {
            const pct = Math.min(100, (delta / dtSecs) * 100);
            push(`${MC_TELEMETRY_PREFIX}tx_duty_pct`, pct, '%');
            snapshot.txDutyPct = pct;
          }
        }
        if (radio?.rxAirSecs !== undefined && prev.rxAirSecs !== undefined) {
          const delta = radio.rxAirSecs - prev.rxAirSecs;
          if (delta >= 0) {
            const pct = Math.min(100, (delta / dtSecs) * 100);
            push(`${MC_TELEMETRY_PREFIX}rx_duty_pct`, pct, '%');
            snapshot.rxDutyPct = pct;
          }
        }
        // Packet rates expressed per minute so the y-axis is human-friendly.
        if (packets?.recv !== undefined && prev.packetsRecv !== undefined) {
          const delta = packets.recv - prev.packetsRecv;
          if (delta >= 0) {
            const rate = (delta / dtSecs) * 60;
            push(`${MC_TELEMETRY_PREFIX}pkt_recv_rate`, rate, '/min');
            snapshot.packetsRecvRatePerMin = rate;
          }
        }
        if (packets?.sent !== undefined && prev.packetsSent !== undefined) {
          const delta = packets.sent - prev.packetsSent;
          if (delta >= 0) {
            const rate = (delta / dtSecs) * 60;
            push(`${MC_TELEMETRY_PREFIX}pkt_sent_rate`, rate, '/min');
            snapshot.packetsSentRatePerMin = rate;
          }
        }
      }
    }

    this.prevSamples.set(manager.sourceId, {
      ts: now,
      txAirSecs: radio?.txAirSecs,
      rxAirSecs: radio?.rxAirSecs,
      packetsRecv: packets?.recv,
      packetsSent: packets?.sent,
    });
    this.lastSnapshots.set(manager.sourceId, snapshot);

    if (rows.length === 0) {
      logger.debug(
        `[MeshCorePoller:${manager.sourceId}] No metrics produced for ${nodeId.substring(0, 16)}`,
      );
      return;
    }

    try {
      await this.database.telemetry.insertTelemetryBatch(rows, manager.sourceId);
      logger.debug(
        `[MeshCorePoller:${manager.sourceId}] Wrote ${rows.length} telemetry rows for ${nodeId.substring(0, 16)}`,
      );
    } catch (err) {
      logger.warn(`[MeshCorePoller:${manager.sourceId}] insertTelemetryBatch failed:`, err);
    }
  }
}

/**
 * Module-level handle for the singleton poller. server.ts constructs the
 * instance once at startup and registers it here; route handlers and other
 * subsystems read it back via `getMeshCoreTelemetryPoller()` without having
 * to thread it through their imports.
 */
let _poller: MeshCoreTelemetryPoller | null = null;

export function setMeshCoreTelemetryPoller(poller: MeshCoreTelemetryPoller | null): void {
  _poller = poller;
}

export function getMeshCoreTelemetryPoller(): MeshCoreTelemetryPoller | null {
  return _poller;
}

/**
 * Stable 31-bit numeric derived from the low 4 bytes of a hex pubkey.
 * The `telemetry.nodeNum` column is `NOT NULL` everywhere, but MeshCore has
 * no genuine equivalent — queries against MeshCore telemetry always go
 * through `nodeId` (the pubkey). We synthesise a non-negative integer so
 * inserts succeed without lying about Meshtastic provenance.
 */
export function nodeNumFromPubkey(publicKey: string): number {
  if (!publicKey) return 0;
  const tail = publicKey.replace(/^0x/, '').slice(-8);
  const n = parseInt(tail, 16);
  if (!Number.isFinite(n)) return 0;
  return n & 0x7fffffff;
}
