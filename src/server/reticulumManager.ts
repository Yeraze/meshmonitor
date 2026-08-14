/**
 * Reticulum source manager (#3960 Phase 1a WP4).
 *
 * `ISourceManager` implementation that owns a single `ReticulumBridgeClient`
 * and persists what it emits: `announce` events become
 * `reticulum_destinations` rows, `interface_stats` events become
 * `reticulum_interfaces` snapshot rows plus throttled throughput-history rows
 * on the shared `telemetry` table, and `telemetry` events (decoded Sideband
 * `FIELD_TELEMETRY`, #3960 Phase 3 WP2/WP4) become `telemetry` table rows
 * (sensors) plus a latest-only position overwrite on the destination's
 * `reticulum_destinations` row (location) — see `handleTelemetry`.
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

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import type { Source } from '../db/repositories/sources.js';
import type { ReticulumMessageRow, UpsertMessageInput, UpsertPathInput } from '../db/repositories/reticulum.js';
import databaseService from '../services/database.js';
import type { DbTelemetry } from '../services/database.js';
import { logger } from '../utils/logger.js';
import { shouldDiscardPosition } from '../utils/nullIsland.js';
import { getDiscardInvalidPositions } from '../utils/positionIngestConfig.js';
import { isOwnReticulumAddress } from './utils/ownNodes.js';
import type { ISourceManager, SourceStatus } from './sourceManagerRegistry.js';
import { dataEventEmitter } from './services/dataEventEmitter.js';
import { notificationService } from './services/notificationService.js';
import { ReticulumBridgeClient } from './reticulumBridgeClient.js';
import type { ReticulumConfig } from './reticulumConfig.js';
import type {
  AnnounceMessage,
  DeliveryStateEvent,
  DeviceInfoMessage,
  InterfaceStatsEntry,
  InterfaceStatsMessage,
  LxmfMessageEvent,
  LxmfMethod,
  PathTableMessage,
  ProbeResultMessage,
  RadioConfigMessage,
  ReadyMessage,
  RemoteStatusMessage,
  StatusMessage,
  TelemetryMessage,
  WelcomeMessage,
} from './reticulumProtocol.js';
import {
  reticulumDestinationNodeId,
  reticulumDestinationNodeNum,
  reticulumInterfaceNodeId,
  reticulumInterfaceNodeNum,
  RETICULUM_IFACE_RX_RATE,
  RETICULUM_IFACE_TX_RATE,
} from './services/reticulumTelemetry.js';

/**
 * Extract the DB `replyToHash`/`threadHash` columns from an LXMF message's
 * `fields` bag (bridge-sanitized, R3). LXMF carries these as the `replyTo`/
 * `thread` keys inside `fields` on the wire (see the `lxmf_message.json`
 * golden fixture) — there is no dedicated envelope field for either.
 */
function extractReplyAndThread(fields: Record<string, unknown> | null | undefined): {
  replyToHash: string | null;
  threadHash: string | null;
} {
  const replyToHash = fields && typeof fields.replyTo === 'string' ? fields.replyTo : null;
  const threadHash = fields && typeof fields.thread === 'string' ? fields.thread : null;
  return { replyToHash, threadHash };
}

/** Serialize an LXMF `fields` bag for the `fields` TEXT column — `null` for an absent/empty bag (not `"{}"`). */
function serializeFields(fields: Record<string, unknown> | null | undefined): string | null {
  if (!fields || Object.keys(fields).length === 0) return null;
  return JSON.stringify(fields);
}

/** Parameters for {@link ReticulumManager.sendMessage} (mirrors the WP4 `POST /messages` route body). */
export interface SendReticulumMessageParams {
  to: string;
  content: string;
  title?: string;
  fields?: Record<string, unknown>;
  method?: LxmfMethod;
  replyToHash?: string;
}

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

  /**
   * Last-seen bridge/RNS versions (#3960 Phase 1b WP-B). `bridgeVersion` only
   * ever arrives on the `welcome` handshake message; `rnsVersion` arrives on
   * both `welcome` and the bridge's periodic `status` push (the latter wins
   * on update since it's the fresher read of the same value). Both stay
   * `null` until the first successful connect.
   */
  private bridgeVersion: string | null = null;
  private rnsVersion: string | null = null;

  /**
   * This source's own LXMF destination hash (Phase 2 WP3), cached from the
   * `destinationHash` field on `ready`/`status` once the LXMF router has
   * started. `null` until then. Feeds the cross-source self-origin guard
   * (`utils/ownNodes.ts`'s `isOwnReticulumAddress`, mirroring #3914) and
   * {@link getOwnAddresses}.
   */
  private ownDestinationHash: string | null = null;

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

  /** Last-seen bridge sidecar version from the `welcome` handshake (WP-B). Null until first connect. */
  getBridgeVersion(): string | null {
    return this.bridgeVersion;
  }

  /** Last-seen RNS library version from `welcome`/`status` (WP-B). Null until first connect. */
  getRnsVersion(): string | null {
    return this.rnsVersion;
  }

  /**
   * This source's own LXMF destination hash(es), for the cross-source
   * self-origin guard (Phase 2 WP3, mirrors `getLocalNodeInfo()`/`getSelfPublicKey`-
   * style accessors on the other manager types). A Reticulum source owns at
   * most one LXMF identity, so this is empty until `ready`/`status` reports
   * `destinationHash`, then a single-element array.
   */
  getOwnAddresses(): string[] {
    return this.ownDestinationHash ? [this.ownDestinationHash] : [];
  }

  // --------------------------------------------------------------------
  // LXMF identity/propagation commands (Phase 2 WP4)
  //
  // Thin delegates onto `ReticulumBridgeClient`'s already-wired commands
  // (WP1) — added here because routes only ever reach a source through its
  // manager (never the private `client` field directly), mirroring
  // `sendMessage`'s existing not-connected guard below.
  // --------------------------------------------------------------------

  /** Re-announce our own LXMF identity to the network (`announce_self`). */
  async announceSelf(): Promise<void> {
    if (!this.client) {
      throw new Error(`ReticulumManager(${this.sourceId}): not connected`);
    }
    await this.client.announceSelf();
  }

  /** Set this identity's LXMF display name (`set_display_name`). */
  async setDisplayName(name: string): Promise<void> {
    if (!this.client) {
      throw new Error(`ReticulumManager(${this.sourceId}): not connected`);
    }
    await this.client.setDisplayName(name);
  }

  /** Trigger a best-effort propagation-node sync (`sync_propagation`). */
  async syncPropagation(): Promise<void> {
    if (!this.client) {
      throw new Error(`ReticulumManager(${this.sourceId}): not connected`);
    }
    await this.client.syncPropagation();
  }

  /**
   * Configure the outbound propagation node (`set_propagation_node`).
   * `destinationHash` is required and non-empty — the bridge
   * (`rns_manager.py: RNSManager.set_propagation_node`) raises
   * `ValueError("destinationHash is required")` on a falsy value, so there
   * is currently no wire-level way to *clear* a configured propagation node.
   * Callers (the WP4 route) must validate non-null/non-empty before calling.
   */
  async setPropagationNode(destinationHash: string): Promise<void> {
    if (!this.client) {
      throw new Error(`ReticulumManager(${this.sourceId}): not connected`);
    }
    await this.client.setPropagationNode(destinationHash);
  }

  /**
   * Fetch this identity's PUBLIC info (`get_identity`) — destination hash +
   * display name ONLY. Mirrors `ReticulumBridgeClient.getIdentity()`'s R2/R5
   * contract: the bridge's reply also carries `identityHash`, which is
   * deliberately dropped here (never surfaced past this manager) since the
   * WP4 `GET /identity` route's public contract is `{ destinationHash,
   * displayName }` only — no other identifier, and never a private key.
   */
  async getIdentity(): Promise<{ destinationHash: string | null; displayName: string | null }> {
    if (!this.client) {
      throw new Error(`ReticulumManager(${this.sourceId}): not connected`);
    }
    const info = await this.client.getIdentity();
    return {
      destinationHash: info.destinationHash ?? this.ownDestinationHash ?? null,
      displayName: info.displayName ?? null,
    };
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
    client.on('welcome', (msg: WelcomeMessage) => this.handleWelcome(msg));
    client.on('status', (msg: StatusMessage) => this.handleStatus(msg));
    client.on('ready', (msg: ReadyMessage) => this.handleReady(msg));

    client.on('lxmf_message', (msg: LxmfMessageEvent) => {
      this.handleLxmfMessage(msg).catch((err: unknown) => {
        logger.warn(
          `[Reticulum:${this.sourceId}] failed to persist lxmf_message ${msg.hash}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    });

    client.on('delivery_state', (msg: DeliveryStateEvent) => {
      this.handleDeliveryState(msg).catch((err: unknown) => {
        logger.warn(
          `[Reticulum:${this.sourceId}] failed to process delivery_state for ${msg.hash}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    });

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

    client.on('path_table', (msg: PathTableMessage) => {
      this.handlePathTable(msg).catch((err: unknown) => {
        logger.warn(
          `[Reticulum:${this.sourceId}] failed to process path_table: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    });

    client.on('telemetry', (msg: TelemetryMessage) => {
      this.handleTelemetry(msg).catch((err: unknown) => {
        logger.warn(
          `[Reticulum:${this.sourceId}] failed to process telemetry for ${msg.destinationHash}: ${
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

  /**
   * `welcome` handshake -> cache the bridge sidecar's own version plus the
   * RNS library version it's running (#3960 Phase 1b WP-B). Always
   * overwrites both — `welcome` is sent exactly once per connection, right
   * after the socket opens.
   */
  private handleWelcome(msg: WelcomeMessage): void {
    this.bridgeVersion = msg.bridgeVersion;
    this.rnsVersion = msg.rnsVersion;
  }

  /**
   * `status` push -> refresh the cached RNS version, if present (WP-B).
   * `StatusMessage.rnsVersion` is optional (absent on the health-monitor's
   * failure broadcast, `pollers.py on_error` — see reticulumProtocol.ts), so
   * a status push with no version leaves the last-known value untouched
   * rather than clobbering it with null/undefined. `bridgeVersion` is not
   * carried on `status`, only on `welcome`.
   */
  private handleStatus(msg: StatusMessage): void {
    if (msg.rnsVersion) {
      this.rnsVersion = msg.rnsVersion;
    }
    if (msg.destinationHash) {
      this.ownDestinationHash = msg.destinationHash;
    }
  }

  /**
   * `ready` -> cache our own LXMF destination hash (Phase 2 WP3), when
   * present, and re-announce our identity to the network. Fires on BOTH the
   * initial connect AND every subsequent reconnect (the bridge client emits
   * `ready` at the end of `connectOnce`, which reconnects run through too).
   *
   * announce_self is fire-and-forget: the WP1 gotcha is that signature
   * validation needs both sides to have announced, but a missed announce
   * degrades signature checks — it must never break the connect/reconnect
   * flow itself, so failures are logged, not thrown.
   *
   * Deferred via `queueMicrotask`: `ReticulumBridgeClient.connectOnce` emits
   * `ready` (synchronously invoking this handler) BEFORE it flips its own
   * `state` to `'ready'` — calling `announceSelf()` synchronously from here
   * would still see `'configuring'` and be rejected as "not connected".
   * Queuing past this tick lets that state flip complete first.
   */
  private handleReady(msg: ReadyMessage): void {
    if (msg.destinationHash) {
      this.ownDestinationHash = msg.destinationHash;
    }
    queueMicrotask(() => {
      this.client?.announceSelf().catch((err: unknown) => {
        logger.warn(
          `[Reticulum:${this.sourceId}] announce_self failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
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
   * `path_table` -> `reticulum_paths` snapshot replace (#3960 Phase 4 WP3,
   * build spec §3.4). The bridge's `path_table` event always carries the
   * WHOLE table for this source, not a delta (build spec §0 R4) — so this
   * maps every wire row straight through to {@link UpsertPathInput} and
   * hands the full array to {@link ReticulumRepository.replacePaths}, which
   * does the delete-then-bulk-insert itself, scoped to `this.sourceId`
   * (never touches another source's rows). `expiresAt` converts the wire
   * `expires` (Unix epoch SECONDS, matching `PathTableEntry`'s doc) to ms;
   * `updatedAt` is this poll's wall-clock time, the row's age source.
   */
  private async handlePathTable(msg: PathTableMessage): Promise<void> {
    const rows: UpsertPathInput[] = msg.paths.map((p) => ({
      destinationHash: p.destinationHash,
      viaHash: p.via ?? null,
      hops: p.hops ?? null,
      interfaceName: p.interface ?? null,
      expiresAt: typeof p.expires === 'number' ? Math.round(p.expires * 1000) : null,
      updatedAt: Date.now(),
    }));
    await databaseService.reticulum.replacePaths(this.sourceId, rows);
  }

  /**
   * `telemetry` -> decoded Sideband `FIELD_TELEMETRY` payload (#3960 Phase 3
   * WP2/WP4, build spec §2.A/§4). Two independent writes, neither gated on
   * the other succeeding:
   *  - `sensors` (always present, `{}` if none) -> rows on the shared
   *    `telemetry` table, mirroring {@link handleInterfaceStats}'s
   *    `insertTelemetryBatch` pattern exactly, just keyed by the destination
   *    hash (`rns:dest:<hash>`, {@link reticulumDestinationNodeId}/
   *    {@link reticulumDestinationNodeNum}) instead of an interface name.
   *  - `location` (nullable) -> the six position columns +
   *    `positionUpdatedAt` on the destination's `reticulum_destinations` row,
   *    LATEST-ONLY overwrite (build spec §3/§4 — no history table, no
   *    `estimated_positions`), guarded by the same server-side null-island
   *    filter Meshtastic/MQTT/MeshCore ingest use.
   *
   * `msg.ts` is `SID_TIME` in Unix epoch **seconds** (or `null`) — NOT the
   * envelope's usual epoch-ms creation time (see `TelemetryMessage`'s doc in
   * reticulumProtocol.ts) — so it's converted to epoch-ms once here and
   * reused for both the telemetry rows' `timestamp` and the position
   * sample's `positionUpdatedAt`. A missing `ts` falls back to "now".
   *
   * Never creates a `reticulum_messages` row — telemetry-only Sideband
   * packets are intentionally invisible to the message/chat surface (R3).
   */
  private async handleTelemetry(msg: TelemetryMessage): Promise<void> {
    const sampleAtMs = msg.ts != null ? msg.ts * 1000 : Date.now();
    const createdAt = Date.now();

    const sensorEntries = Object.entries(msg.sensors);
    if (sensorEntries.length > 0) {
      const nodeId = reticulumDestinationNodeId(msg.destinationHash);
      const nodeNum = reticulumDestinationNodeNum(msg.destinationHash);
      const rows: DbTelemetry[] = sensorEntries.map(([telemetryType, reading]) => ({
        nodeId,
        nodeNum,
        telemetryType,
        timestamp: sampleAtMs,
        value: reading.value,
        unit: reading.unit ?? undefined,
        createdAt,
      }));
      try {
        await databaseService.telemetry.insertTelemetryBatch(rows, this.sourceId);
      } catch (err) {
        logger.warn(
          `[Reticulum:${this.sourceId}] failed to write Sideband telemetry for ${msg.destinationHash}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (msg.location) {
      const { lat, lon, altitude, speed, bearing, accuracy } = msg.location;
      if (shouldDiscardPosition(lat, lon, undefined, getDiscardInvalidPositions())) {
        logger.debug(
          `[Reticulum:${this.sourceId}] discarding null-island/invalid position for ${msg.destinationHash}`,
        );
      } else {
        try {
          await databaseService.reticulum.updateDestinationPosition(this.sourceId, {
            destinationHash: msg.destinationHash,
            latitude: lat,
            longitude: lon,
            altitude,
            speed,
            bearing,
            accuracy,
            positionUpdatedAt: sampleAtMs,
          });
        } catch (err) {
          logger.warn(
            `[Reticulum:${this.sourceId}] failed to write position for ${msg.destinationHash}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
  }

  // --------------------------------------------------------------------
  // Own mode: RNode radio config / device info (#3960 Phase 3 WP1/WP4)
  //
  // Thin delegates onto ReticulumBridgeClient's id-correlated commands
  // (mirrors the LXMF identity/propagation delegates above) — only
  // meaningful when this source's mode is 'own'; the bridge itself rejects
  // these with a typed OWN_MODE_REQUIRED ReticulumBridgeError otherwise
  // (surfaced to the caller unchanged, same as any other client rejection).
  // --------------------------------------------------------------------

  /** Fetch the own-mode RNode's current radio config (`get_radio_config`). */
  async getRadioConfig(): Promise<RadioConfigMessage> {
    if (!this.client) {
      throw new Error(`ReticulumManager(${this.sourceId}): not connected`);
    }
    return this.client.getRadioConfig();
  }

  /** Apply a partial radio-config patch to the own-mode RNode (`set_radio_config`). */
  async setRadioConfig(patch: {
    frequency?: number;
    bandwidth?: number;
    spreadingFactor?: number;
    codingRate?: number;
    txPower?: number;
    stAlock?: number;
    ltAlock?: number;
    radioState?: boolean;
  }): Promise<RadioConfigMessage> {
    if (!this.client) {
      throw new Error(`ReticulumManager(${this.sourceId}): not connected`);
    }
    return this.client.setRadioConfig(patch);
  }

  /** Fetch the own-mode RNode's device/firmware info (`get_device_info`). */
  async getDeviceInfo(): Promise<DeviceInfoMessage> {
    if (!this.client) {
      throw new Error(`ReticulumManager(${this.sourceId}): not connected`);
    }
    return this.client.getDeviceInfo();
  }

  // --------------------------------------------------------------------
  // Fleet monitoring: probe + remote status (#3960 Phase 4 WP3, build spec
  // §3.4). Thin delegates onto ReticulumBridgeClient's id-correlated
  // commands, same shape as the own-mode radio delegates above — but,
  // unlike those, NEITHER of these is own-mode gated: they're valid
  // whenever the bridge holds a live RNS instance (own/attach/tcp_peer
  // alike). Bridge-side typed failures (PROBE_FAILED/REMOTE_STATUS_FAILED/
  // REMOTE_MANAGEMENT_DENIED) surface unchanged as a ReticulumBridgeError —
  // the route layer maps them to the right HTTP status.
  // --------------------------------------------------------------------

  /** rnprobe-style reachability probe (`probe`) against `destinationHash`. */
  async probe(destinationHash: string, timeoutS?: number): Promise<ProbeResultMessage> {
    if (!this.client) {
      throw new Error(`ReticulumManager(${this.sourceId}): not connected`);
    }
    return this.client.probe({ destinationHash, timeoutS });
  }

  /** Remote Transport Node /status + /path query (`get_remote_status`). */
  async getRemoteStatus(destinationHash: string, timeoutS?: number): Promise<RemoteStatusMessage> {
    if (!this.client) {
      throw new Error(`ReticulumManager(${this.sourceId}): not connected`);
    }
    return this.client.getRemoteStatus({ destinationHash, timeoutS });
  }

  // --------------------------------------------------------------------
  // LXMF messaging (#3960 Phase 2 WP3)
  // --------------------------------------------------------------------

  /**
   * `lxmf_message` -> persist as a `reticulum_messages` row, then emit the
   * UI/automation-trigger event for genuinely INBOUND messages only.
   *
   * Self-origin guard (mirrors `utils/ownNodes.ts` #3914): when `msg.from` is
   * one of MeshMonitor's own LXMF destinations (a self-addressed message —
   * we sent a message to our own identity, or a multi-source setup owns both
   * ends), the row is still persisted, but `dataEventEmitter.emitReticulumMessage`
   * is NOT called — that call is what both updates the UI and feeds the
   * `trigger.message` automation matcher, so skipping it prevents an
   * automation from firing on our own traffic. The UI still reflects our own
   * sends through the `sendMessage`/`delivery_state` flow instead.
   */
  private async handleLxmfMessage(msg: LxmfMessageEvent): Promise<void> {
    const row = await this.persistLxmfMessage(msg);
    if (isOwnReticulumAddress(msg.from)) {
      return;
    }
    dataEventEmitter.emitReticulumMessage(row, this.sourceId);
    await this.sendInboundNotification(row);
  }

  /**
   * Push/Apprise/desktop notification for an inbound (non-self) LXMF DM.
   * Routes through the existing `notificationService.broadcast()` ->
   * `shouldFilterNotificationAsync` (`utils/notificationFiltering.ts`)
   * pipeline shared with Meshtastic/MQTT (`messagePushNotifier.ts`) — every
   * subscribed user's whitelist/blacklist/mute/enabled-channels preferences
   * are honored per-user there. LXMF messages are always DMs (no channel
   * concept), so `channelId` is a sentinel `-1` (unused when `isDirectMessage`
   * is true) and per-DM muting by `nodeUuid` is not yet wireable — Reticulum
   * destinations have no `uuid` column. Never throws: notification failures
   * must not break message processing.
   */
  private async sendInboundNotification(row: ReticulumMessageRow): Promise<void> {
    try {
      const serviceStatus = notificationService.getServiceStatus();
      if (!serviceStatus.anyAvailable) return;

      const source = await databaseService.sources.getSource(this.sourceId);
      const sourceName = source?.name || this.sourceId;
      const text = row.content ?? '';
      const body = text.length > 100 ? `${text.substring(0, 97)}...` : text;

      await notificationService.broadcast(
        {
          title: `Direct Message from ${row.fromHash}`,
          body,
          sourceId: this.sourceId,
          sourceName,
          data: { type: 'dm', messageId: row.id, senderNodeId: row.fromHash },
        },
        {
          messageText: text,
          channelId: -1,
          isDirectMessage: true,
          sourceId: this.sourceId,
          sourceName,
        },
      );
    } catch (err) {
      logger.warn(
        `[Reticulum:${this.sourceId}] failed to send inbound message notification: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Build and persist the `reticulum_messages` row for an inbound `lxmf_message` event. */
  private async persistLxmfMessage(msg: LxmfMessageEvent): Promise<ReticulumMessageRow> {
    const id = `${this.sourceId}_${msg.hash}`;
    const { replyToHash, threadHash } = extractReplyAndThread(msg.fields);
    const input: UpsertMessageInput = {
      id,
      fromHash: msg.from,
      toHash: msg.to,
      title: msg.title,
      content: msg.content,
      timestamp: msg.ts,
      receivedAt: Date.now(),
      state: 'delivered',
      method: msg.method,
      signatureValidated: msg.signatureValidated,
      ratcheted: msg.ratcheted,
      fields: serializeFields(msg.fields),
      replyToHash,
      threadHash,
      rssi: msg.rssi,
      snr: msg.snr,
      quality: msg.q,
    };
    await databaseService.reticulum.upsertMessage(this.sourceId, input);
    const row = await databaseService.reticulum.getMessage(this.sourceId, id);
    if (!row) {
      throw new Error(`ReticulumManager(${this.sourceId}): message ${id} vanished immediately after upsert`);
    }
    return row;
  }

  /**
   * `delivery_state` -> update the message row's state (+method) and emit a
   * UI-only update event. Unlike {@link handleLxmfMessage}, this is never
   * gated by the self-origin guard: a delivery-state transition only ever
   * describes OUR OWN outbound message's progress, so it is inherently
   * self-originated and never feeds `trigger.message`.
   */
  private async handleDeliveryState(msg: DeliveryStateEvent): Promise<void> {
    const id = `${this.sourceId}_${msg.hash}`;
    await databaseService.reticulum.updateMessageState(this.sourceId, id, msg.state, {
      method: msg.method ?? undefined,
    });
    dataEventEmitter.emitReticulumDeliveryStateUpdated(
      { id, hash: msg.hash, state: msg.state, method: msg.method, attempts: msg.attempts },
      this.sourceId,
    );
  }

  /**
   * Send an LXMF message. Optimistically persists a `state: 'outbound'` row
   * under a temporary id BEFORE the round-trip to the bridge (so a caller —
   * the WP4 route — can show it immediately), then calls `send_lxmf` and
   * reconciles the temporary id into the authoritative `${sourceId}_${hash}`
   * id once the bridge assigns the real LXM hash (the hash arrives on
   * `send_lxmf`'s own response, which doubles as the first `delivery_state`
   * transition — see `ReticulumBridgeClient.sendLxmf`). Subsequent state
   * transitions (sent/delivered/failed) arrive via the unsolicited
   * `delivery_state` push and are handled by {@link handleDeliveryState}.
   *
   * On a `send_lxmf` failure, the optimistic row is marked `failed` (under
   * its temporary id — no hash was ever assigned) rather than left stuck at
   * `outbound`, and the error is rethrown to the caller.
   */
  async sendMessage(params: SendReticulumMessageParams): Promise<ReticulumMessageRow> {
    if (!this.client) {
      throw new Error(`ReticulumManager(${this.sourceId}): not connected`);
    }
    const client = this.client;
    const now = Date.now();
    const tempId = `${this.sourceId}_pending-${randomUUID()}`;
    const wireFields: Record<string, unknown> | undefined = params.replyToHash
      ? { ...(params.fields ?? {}), replyTo: params.replyToHash }
      : params.fields;

    const optimistic: UpsertMessageInput = {
      id: tempId,
      fromHash: this.ownDestinationHash ?? '',
      toHash: params.to,
      title: params.title ?? null,
      content: params.content,
      timestamp: now,
      state: 'outbound',
      method: params.method ?? null,
      replyToHash: params.replyToHash ?? null,
      fields: serializeFields(wireFields),
    };
    await databaseService.reticulum.upsertMessage(this.sourceId, optimistic);

    try {
      const response = await client.sendLxmf({
        to: params.to,
        title: params.title,
        content: params.content,
        fields: wireFields,
        method: params.method,
      });
      const realId = `${this.sourceId}_${response.hash}`;
      await databaseService.reticulum.renameMessageId(this.sourceId, tempId, realId);
      await databaseService.reticulum.updateMessageState(this.sourceId, realId, response.state, {
        method: response.method ?? params.method ?? undefined,
      });
      const row = await databaseService.reticulum.getMessage(this.sourceId, realId);
      if (!row) {
        throw new Error(`ReticulumManager(${this.sourceId}): message ${realId} vanished immediately after reconciliation`);
      }
      return row;
    } catch (err) {
      await databaseService.reticulum.updateMessageState(this.sourceId, tempId, 'failed').catch(() => {
        // best-effort — the original error is what the caller needs to see.
      });
      throw err;
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
