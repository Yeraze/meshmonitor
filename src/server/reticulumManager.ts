/**
 * Reticulum source manager (#3960 Phase 1a WP4).
 *
 * `ISourceManager` implementation that owns a single `ReticulumBridgeClient`
 * and persists what it emits: `announce` events become
 * `reticulum_destinations` rows, `interface_stats` events become
 * `reticulum_interfaces` snapshot rows plus throttled throughput-history rows
 * on the shared `telemetry` table.
 *
 * Structural template: `meshcoreManager.ts` (`MeshCoreManager`). Mirrors:
 * constructor(sourceId, sourceName?), `configure()`/pendingConfig staging,
 * `start()` delegating to `connect()` and swallowing its error (logged, not
 * thrown — the registry's `addManager()` already has its own defensive
 * try/catch, but a manager whose `start()` never throws keeps that catch
 * purely defensive rather than load-bearing), `stop()` delegating to
 * `disconnect()`, `getLocalNodeInfo()` returning `null`, and no-op distance
 * schedulers (Reticulum destinations carry no position data until Phase 3).
 *
 * `sourceType`/`getStatus()`: `ISourceManager.sourceType` is typed as
 * `Source['type']`, which includes `'reticulum'` as of WP5 (build spec §3.3,
 * `src/db/repositories/sources.ts`) — no cast needed.
 */

import { EventEmitter } from 'events';
import type { Source } from '../db/repositories/sources.js';
import databaseService from '../services/database.js';
import type { DbTelemetry } from '../services/database.js';
import { logger } from '../utils/logger.js';
import type { ISourceManager, SourceStatus } from './sourceManagerRegistry.js';
import { ReticulumBridgeClient } from './reticulumBridgeClient.js';
import type { ReticulumConfig } from './reticulumConfig.js';
import type {
  AnnounceMessage,
  InterfaceStatsEntry,
  InterfaceStatsMessage,
} from './reticulumProtocol.js';
import {
  reticulumInterfaceNodeId,
  reticulumInterfaceNodeNum,
  RETICULUM_IFACE_RX_RATE,
  RETICULUM_IFACE_TX_RATE,
} from './services/reticulumTelemetry.js';

/** Per-interface byte-counter snapshot used to throttle throughput-history writes. */
interface InterfaceSample {
  txBytes: number;
  rxBytes: number;
  atMs: number;
}

export class ReticulumManager extends EventEmitter implements ISourceManager {
  public readonly sourceId: string;
  private sourceName: string;

  private client: ReticulumBridgeClient | null = null;
  private pendingConfig: ReticulumConfig | null = null;

  /**
   * Last-seen tx/rx byte counters per interface name, used to throttle
   * throughput-history writes: a poll whose counters haven't moved since the
   * last one is not written to the shared `telemetry` table (§5.3-equivalent
   * write-cadence guidance in the build spec — keep it simple, only write on
   * a genuine delta). A first-ever poll for an interface has nothing to diff
   * against, so it seeds the baseline without writing a row.
   */
  private readonly lastInterfaceSample = new Map<string, InterfaceSample>();

  constructor(sourceId: string, sourceName?: string) {
    super();
    if (!sourceId) {
      throw new Error('ReticulumManager requires a sourceId');
    }
    this.sourceId = sourceId;
    this.sourceName = sourceName ?? sourceId;
    logger.info(`[Reticulum:${sourceId}] Manager initialized`);
  }

  /** ISourceManager: source type discriminant — drives type guards in sourceManagerTypes.ts. */
  get sourceType(): Source['type'] {
    return 'reticulum';
  }

  /**
   * Store the connection config so the parameterless start() can call
   * connect(). Call this before addManager() (which invokes start()
   * automatically) — mirrors MeshCoreManager.configure().
   */
  configure(cfg: ReticulumConfig): void {
    this.pendingConfig = cfg;
  }

  /** Update the stored display name used by getStatus() when no override is passed. */
  setSourceName(name: string): void {
    this.sourceName = name;
  }

  /**
   * ISourceManager: parameterless start — delegates to connect() using the
   * config stored by configure(). Never throws: failures are logged so a
   * bad source doesn't abort the whole boot sequence (registry.addManager()
   * also wraps this call defensively, but that catch stays purely defensive
   * because this method already swallows its own errors).
   */
  async start(): Promise<void> {
    if (!this.pendingConfig) {
      logger.warn(
        `[Reticulum:${this.sourceId} (${this.sourceName})] start() called but no config stored — call configure() first`,
      );
      return;
    }
    try {
      await this.connect(this.pendingConfig);
      logger.info(`[Reticulum:${this.sourceId} (${this.sourceName})] Auto-connected`);
    } catch (err) {
      logger.warn(
        `[Reticulum:${this.sourceId} (${this.sourceName})] Auto-connect failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * ISourceManager: parameterless stop — delegates to disconnect(). Does NOT
   * remove this manager from any registry; per the build spec (§3.6/§7 note
   * 2), Reticulum sources are REMOVED from the registry on disconnect
   * (unlike MeshCore's keep-registered semantics) — that removal is the
   * registry's/route handler's responsibility (WP5), not this method's.
   */
  async stop(): Promise<void> {
    await this.disconnect();
  }

  /**
   * Connect (or reconnect) to the bridge sidecar using the given config.
   * Tears down any existing client first. Propagates connect failures to the
   * caller (does not swallow) — `start()` is the one call site that catches;
   * `ensureReticulumManagerStarted`'s reconnect branch and route handlers are
   * expected to handle/report the rejection themselves.
   */
  async connect(cfg: ReticulumConfig): Promise<void> {
    if (this.client) {
      await this.disconnect();
    }
    this.pendingConfig = cfg;

    const client = new ReticulumBridgeClient({
      bridgeUrl: cfg.bridgeUrl,
      token: cfg.token,
      protocolVersion: cfg.protocolVersion,
    });
    this.wireClientEvents(client);
    this.client = client;

    await client.connect({ mode: cfg.mode, configDir: cfg.configDir, peers: cfg.peers });
  }

  /** Tear down the bridge client, if any. Idempotent. */
  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) {
      client.removeAllListeners();
      client.disconnect();
    }
  }

  /** Helper for routes/config recipes: true once the bridge client has completed its handshake. */
  isConnected(): boolean {
    return this.client?.isConnected() ?? false;
  }

  /**
   * ISourceManager: status snapshot. `connected` reflects the bridge
   * client's own state (`ready` == connected) rather than a
   * separately-tracked flag, so there's a single source of truth.
   */
  getStatus(sourceName?: string): SourceStatus {
    return {
      sourceId: this.sourceId,
      sourceName: sourceName ?? this.sourceName,
      sourceType: this.sourceType,
      connected: this.isConnected(),
    };
  }

  /**
   * ISourceManager contract. Reticulum destinations have no meshtastic-style
   * local nodeNum/nodeId in Phase 1a (mirrors MeshCoreManager, which returns
   * null for the same reason).
   */
  getLocalNodeInfo(): null {
    return null;
  }

  /**
   * ISourceManager: no-op in Phase 1a. Reticulum destinations carry no
   * position/telemetry columns yet (positions arrive Phase 3), so there is
   * nothing for an auto-delete-by-distance scheduler to act on.
   */
  async startDistanceDeleteScheduler(): Promise<void> {
    // positions arrive Phase 3 — no-op until then.
  }

  /** ISourceManager: no-op in Phase 1a — see startDistanceDeleteScheduler. */
  stopDistanceDeleteScheduler(): void {
    // positions arrive Phase 3 — no-op until then.
  }

  // --------------------------------------------------------------------
  // Bridge client event wiring
  // --------------------------------------------------------------------

  private wireClientEvents(client: ReticulumBridgeClient): void {
    client.on('announce', (msg: AnnounceMessage) => {
      this.handleAnnounce(msg).catch((err: unknown) => {
        logger.warn(
          `[Reticulum:${this.sourceId}] failed to persist announce for ${msg.destinationHash}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    });

    client.on('interface_stats', (msg: InterfaceStatsMessage) => {
      this.handleInterfaceStats(msg).catch((err: unknown) => {
        logger.warn(
          `[Reticulum:${this.sourceId}] failed to process interface_stats: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    });

    client.on('error', (err: Error) => {
      logger.warn(`[Reticulum:${this.sourceId}] bridge client error: ${err.message}`);
      this.emit('error', err);
    });
  }

  /** `announce` -> `reticulum_destinations` upsert (build spec §3.5/§4.4). */
  private async handleAnnounce(msg: AnnounceMessage): Promise<void> {
    const aspects = msg.aspects && msg.aspects.length > 0 ? msg.aspects.join('.') : null;
    await databaseService.reticulum.upsertDestination(this.sourceId, {
      destinationHash: msg.destinationHash,
      identityHash: msg.identityHash,
      appName: msg.appName,
      aspects,
      displayName: msg.displayName,
      appDataB64: msg.appDataB64,
      hops: msg.hops,
      nextHopInterface: msg.nextHopInterface,
      rssi: msg.rssi,
      snr: msg.snr,
      quality: msg.q,
      announceAt: msg.ts,
    });
  }

  /**
   * `interface_stats` -> `reticulum_interfaces` snapshot upsert (always) plus
   * throttled tx/rx-rate rows on the shared `telemetry` table (only when a
   * given interface's byte counters actually advanced since the last poll —
   * see {@link lastInterfaceSample}).
   */
  private async handleInterfaceStats(msg: InterfaceStatsMessage): Promise<void> {
    const rows: DbTelemetry[] = [];
    const writtenAt = Date.now();

    for (const iface of msg.interfaces) {
      try {
        await databaseService.reticulum.upsertInterface(this.sourceId, {
          interfaceName: iface.name,
          interfaceType: iface.type,
          interfaceHash: iface.hash ?? null,
          mode: iface.mode ?? null,
          status: iface.status,
          online: iface.online,
          bitrate: iface.bitrate ?? null,
          txBytes: iface.txBytes,
          rxBytes: iface.rxBytes,
          lastSeenAt: msg.ts,
        });
      } catch (err) {
        logger.warn(
          `[Reticulum:${this.sourceId}] failed to persist interface snapshot for ${iface.name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }

      this.pushInterfaceHistoryRows(rows, iface, msg.ts, writtenAt);
    }

    if (rows.length === 0) return;
    try {
      await databaseService.telemetry.insertTelemetryBatch(rows, this.sourceId);
    } catch (err) {
      logger.warn(
        `[Reticulum:${this.sourceId}] failed to write interface throughput history: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Diff `iface`'s byte counters against the last-seen sample and, on a
   * genuine positive delta, append tx/rx-rate rows to `rows`. Always updates
   * the stored sample so the next poll has a fresh baseline regardless of
   * whether this poll produced any rows. A negative delta (counter reset —
   * e.g. the bridge process restarted) is treated the same as "no prior
   * baseline": skip writing, just reseed.
   */
  private pushInterfaceHistoryRows(
    rows: DbTelemetry[],
    iface: InterfaceStatsEntry,
    pollTs: number,
    createdAt: number,
  ): void {
    const prev = this.lastInterfaceSample.get(iface.name);
    this.lastInterfaceSample.set(iface.name, { txBytes: iface.txBytes, rxBytes: iface.rxBytes, atMs: pollTs });

    if (!prev) return;
    const elapsedSec = (pollTs - prev.atMs) / 1000;
    if (elapsedSec <= 0) return;

    const nodeNum = reticulumInterfaceNodeNum(iface.name);
    const nodeId = reticulumInterfaceNodeId(iface.name);

    const txDelta = iface.txBytes - prev.txBytes;
    if (txDelta > 0) {
      rows.push({
        nodeId,
        nodeNum,
        telemetryType: RETICULUM_IFACE_TX_RATE,
        timestamp: pollTs,
        value: txDelta / elapsedSec,
        unit: 'B/s',
        createdAt,
      });
    }

    const rxDelta = iface.rxBytes - prev.rxBytes;
    if (rxDelta > 0) {
      rows.push({
        nodeId,
        nodeNum,
        telemetryType: RETICULUM_IFACE_RX_RATE,
        timestamp: pollTs,
        value: rxDelta / elapsedSec,
        unit: 'B/s',
        createdAt,
      });
    }
  }
}
