/**
 * ATAK / CoT Feed Server (ATAK/CoT Phase 3, issue #3691)
 *
 * A single global-singleton, settings-gated, plaintext TCP "SA-server" that
 * streams Cursor-on-Target (CoT) `<event>` XML to ATAK/WinTAK clients that
 * add MeshMonitor as a network input. RX-only: the server never ingests
 * inbound bytes (mesh → TAK is one-way). Default OFF; enabled/port are read
 * from the `cotFeedEnabled` / `cotFeedPort` settings (wired in Phase 3 WP2).
 *
 * **Lifecycle** is modeled on `virtualNodeServer.ts` (EADDRINUSE-safe
 * start/stop, a client set, `stop()` destroying every socket) but the
 * *ownership* is modeled on the global notification-service singletons
 * (`lowBatteryNotificationService`, `mqttPacketLogService`, …) — this is one
 * process-wide feed, not a per-source construct.
 *
 * **Distribution model**: periodic full-snapshot resend (`COT_RESEND_INTERVAL_MS`)
 * plus an immediate snapshot on connect. ATAK dedupes by `uid` and honors
 * `stale`, so resending an unchanged event is a free idempotent refresh — see
 * docs/internal/dev-notes/ATAK_COT_PHASE3_SPEC.md §3.4 for the push-vs-periodic
 * rationale.
 *
 * **Feed content** (§Q3 — emit both, no de-dupe heuristic): every ATAK
 * contact row across all sources (`atakContacts.getContacts(ALL_SOURCES)`)
 * AND every positioned mesh node across all sources including MeshCore
 * (`nodes.getAllNodes(ALL_SOURCES)`). A node that also carries an ATAK
 * contact renders as two distinct CoT events (the EUD and the mesh radio are
 * different real-world things) — deliberately NOT de-duped.
 *
 * **Security** (see spec §3): bind address is `0.0.0.0` by design (ATAK EUDs
 * are remote), default OFF, no auth, no TLS — plaintext feed, document as a
 * trusted-network-only feature. Inbound data is always discarded. Max 16
 * concurrent clients. Every attacker-influenceable string (callsign,
 * longName, shortName, source name, remarks) is escaped via `escapeXml`.
 */
import { Server, Socket } from 'net';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { getEffectiveDbNodePosition } from '../utils/nodeEnhancer.js';
import { ALL_SOURCES } from '../../db/repositories/base.js';
import type { DbNode } from '../../db/types.js';
import type { AtakContactRow } from '../../db/repositories/atakContacts.js';
import { ATAK_CONTACT_STALE_MS } from './atakContactService.js';
import { teamLabel, roleLabel } from '../../utils/atakTeam.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';

export interface CotFeedConfig {
  enabled: boolean;
  port: number;
}

export interface CotFeedStatus {
  enabled: boolean;
  port: number;
  clientCount: number;
  listening: boolean;
}

const COT_DEFAULT_PORT = 8088;
const COT_MAX_CLIENTS = 16;
const COT_RESEND_INTERVAL_MS = 30_000; // periodic snapshot cadence
const COT_NODE_STALE_MS = 60 * 60_000; // 60 min — see spec §3.3

// CoT type for both synthesized mesh nodes and ATAK contacts: atom · friendly
// · Ground · Unit · Combat — the standard generic friendly-ground symbol.
const COT_TYPE_FRIENDLY_GROUND = 'a-f-G-U-C';
const COT_HOW_MACHINE_GPS = 'm-g';

// Sentinel used by the CoT spec for "error not modeled" circular/linear error
// and height-above-ellipsoid when we have no altitude reading.
const COT_UNKNOWN_SENTINEL = 9999999.0;

/**
 * `nodes.getAllNodes()` rows carry a `sourceId` column at runtime (the repo
 * selects the full `nodes` table), but `DbNode` (src/db/types.ts) does not
 * declare it — same pattern as `NodeRow` in nodeInfoEnrichmentService.ts /
 * `RepoNodeInput` in nodeCacheService.ts. Type it locally rather than
 * widening the shared `DbNode`.
 */
type NodeRow = DbNode & { sourceId: string };

// ---------------------------------------------------------------------------
// Pure builders — no I/O, unit-tested in isolation (§5a).
// ---------------------------------------------------------------------------

/** Escapes the five XML-significant characters. Load-bearing security: every
 * attacker-influenceable string (callsign, longName, source name, …) must
 * pass through this before being interpolated into CoT XML. */
export function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Deterministic uid for a synthesized mesh-node CoT event. Stable across
 * both Meshtastic (`!<nodeNum hex>`) and MeshCore (`!<pubkey8>`) nodeIds. */
export function nodeUid(node: Pick<NodeRow, 'sourceId' | 'nodeId'>): string {
  return `MESHMON-${node.sourceId}-${node.nodeId}`;
}

interface RenderEventOptions {
  uid: string;
  timeMs: number;
  staleMs: number;
  lat: number;
  lon: number;
  hae: number;
  callsign: string;
  group?: { name: string; role: string };
  battery?: number;
  track?: { speed: number; course: number };
  remarks?: string;
}

/** Shared XML renderer for both event kinds. Every string field is escaped. */
function renderEvent(opts: RenderEventOptions): string {
  const timeIso = new Date(opts.timeMs).toISOString();
  const staleIso = new Date(opts.staleMs).toISOString();

  const detail: string[] = [];
  detail.push(`<contact callsign="${escapeXml(opts.callsign)}"/>`);
  if (opts.group) {
    detail.push(`<__group name="${escapeXml(opts.group.name)}" role="${escapeXml(opts.group.role)}"/>`);
  }
  if (opts.battery !== undefined) {
    detail.push(`<status battery="${opts.battery}"/>`);
  }
  if (opts.track) {
    detail.push(`<track speed="${opts.track.speed}" course="${opts.track.course}"/>`);
  }
  if (opts.remarks) {
    detail.push(`<remarks>${escapeXml(opts.remarks)}</remarks>`);
  }

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<event version="2.0" uid="${escapeXml(opts.uid)}" type="${COT_TYPE_FRIENDLY_GROUND}" how="${COT_HOW_MACHINE_GPS}" ` +
    `time="${timeIso}" start="${timeIso}" stale="${staleIso}">\n` +
    `  <point lat="${opts.lat}" lon="${opts.lon}" hae="${opts.hae}" ce="${COT_UNKNOWN_SENTINEL}" le="${COT_UNKNOWN_SENTINEL}"/>\n` +
    `  <detail>\n    ${detail.join('\n    ')}\n  </detail>\n` +
    `</event>\n`
  );
}

/**
 * Positioned mesh node → CoT `<event>` XML. Returns `null` when there is no
 * usable position (no effective lat/lon), the position is a private
 * operator override (respect privacy — never leak it into the feed), or the
 * computed `stale` has already passed (don't ship an already-expired event).
 */
export function buildNodeEvent(node: NodeRow, sourceName: string | undefined, now: number): string | null {
  // Private position overrides must never leak into an unauthenticated feed.
  if (node.positionOverrideEnabled && node.positionOverrideIsPrivate) {
    return null;
  }

  const effPos = getEffectiveDbNodePosition(node);
  const lat = effPos.latitude;
  const lon = effPos.longitude;
  if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  // lastHeard is epoch seconds; a node we've never actually heard from has no
  // meaningful report cadence to stale against, so treat it as already stale.
  const lastHeardMs = (node.lastHeard ?? 0) * 1000;
  const staleMs = lastHeardMs + COT_NODE_STALE_MS;
  if (staleMs <= now) {
    return null;
  }

  const callsign = node.shortName || node.longName || node.nodeId;
  const hae = effPos.altitude != null ? effPos.altitude : COT_UNKNOWN_SENTINEL;

  const remarksParts = [sourceName ?? node.sourceId, node.nodeId];
  if (node.hwModel != null) remarksParts.push(`hw=${node.hwModel}`);
  if (node.lastHeard != null) {
    const ageSec = Math.max(0, Math.floor(now / 1000) - node.lastHeard);
    remarksParts.push(`heard ${ageSec}s ago`);
  }

  return renderEvent({
    uid: nodeUid(node),
    timeMs: now,
    staleMs,
    lat,
    lon,
    hae,
    callsign,
    battery: node.batteryLevel != null ? node.batteryLevel : undefined,
    remarks: remarksParts.join(' · '),
  });
}

/**
 * ATAK EUD contact row → CoT `<event>` XML. `uid` is `row.uid` unprefixed
 * (the EUD's own stable device id — reusing it lets ATAK correlate our echo
 * with the device's own beacon; prefixing it would create a ghost
 * duplicate). Returns `null` when there is no position or the computed
 * `stale` (lastSeen + 15 min) has already passed.
 */
export function buildContactEvent(row: AtakContactRow, now: number): string | null {
  if (row.latitude == null || row.longitude == null || !Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)) {
    return null;
  }

  const staleMs = row.lastSeen + ATAK_CONTACT_STALE_MS;
  if (staleMs <= now) {
    return null;
  }

  const callsign = row.callsign || row.deviceCallsign || row.uid;
  const hae = row.altitude != null ? row.altitude : COT_UNKNOWN_SENTINEL;

  const group = row.team !== null || row.role !== null
    ? { name: teamLabel(row.team), role: roleLabel(row.role) }
    : undefined;

  const track = row.speed != null || row.course != null
    ? { speed: row.speed ?? 0, course: row.course ?? 0 }
    : undefined;

  const remarksParts = [`ATAK contact`, `source=${row.sourceId}`];
  if (row.nodeNum != null) {
    remarksParts.push(`node=!${(row.nodeNum >>> 0).toString(16).padStart(8, '0')}`);
  }

  return renderEvent({
    uid: row.uid,
    timeMs: now,
    staleMs,
    lat: row.latitude,
    lon: row.longitude,
    hae,
    callsign,
    group,
    battery: row.battery != null ? row.battery : undefined,
    track,
    remarks: remarksParts.join(' · '),
  });
}

// ---------------------------------------------------------------------------
// Service — owns the TCP listener, client set, and resend timer.
// ---------------------------------------------------------------------------

class CotFeedService {
  private server: Server | null = null;
  private readonly clients: Set<Socket> = new Set();
  private resendTimer: ReturnType<typeof setInterval> | null = null;
  private config: CotFeedConfig = { enabled: false, port: COT_DEFAULT_PORT };

  // Test-only overrides — never touched in production. See configureForTest().
  private resendIntervalMs: number = COT_RESEND_INTERVAL_MS;
  private maxClients: number = COT_MAX_CLIENTS;

  /**
   * Test hook: shorten the resend interval and/or lower the client cap so
   * integration tests don't need real 30s sleeps or 16 real sockets. Call
   * before start()/restart(). Never used in production code paths.
   */
  configureForTest(overrides: { resendIntervalMs?: number; maxClients?: number }): void {
    if (overrides.resendIntervalMs !== undefined) this.resendIntervalMs = overrides.resendIntervalMs;
    if (overrides.maxClients !== undefined) this.maxClients = overrides.maxClients;
  }

  /**
   * Read `cotFeedEnabled`/`cotFeedPort` from settings and (re)start or stop
   * accordingly. Boot entry point and the settings-save callback target
   * (Phase 3 WP2). Never throws — a settings-read failure or bind failure
   * leaves the feed stopped rather than aborting boot.
   */
  async startFromSettings(): Promise<void> {
    let enabled: boolean;
    let port: number;
    try {
      const enabledSetting = await databaseService.settings.getSetting('cotFeedEnabled');
      enabled = enabledSetting === '1' || enabledSetting === 'true';
      if (enabled) {
        const portSetting = await databaseService.settings.getSetting('cotFeedPort');
        const parsedPort = portSetting ? parseInt(portSetting, 10) : NaN;
        // 0 is a legitimate value here (OS-assigned ephemeral port — used by
        // tests); only a genuinely unparseable/negative value falls back.
        port = Number.isFinite(parsedPort) && parsedPort >= 0 ? parsedPort : COT_DEFAULT_PORT;
      } else {
        port = COT_DEFAULT_PORT;
      }
    } catch (error) {
      logger.error('CoT feed: failed to read settings, leaving feed stopped:', error);
      enabled = false;
      port = COT_DEFAULT_PORT;
    }

    await this.restart({ enabled, port });
  }

  /**
   * Idempotent restart with the given config. No-ops when already listening
   * on the requested port with the requested enabled state; otherwise stops
   * (if running) and starts (if the new config is enabled).
   */
  async restart(config: CotFeedConfig): Promise<void> {
    const alreadyCorrect =
      this.server !== null &&
      this.config.enabled &&
      this.config.port === config.port &&
      config.enabled;

    this.config = config;

    if (alreadyCorrect) {
      return;
    }

    await this.stop();
    if (config.enabled) {
      await this.start();
    }
  }

  /**
   * Bind the TCP listener. Handles EADDRINUSE (and any other listen error)
   * like `VirtualNodeServer` — logs clearly, leaves `this.server === null`
   * so a later start() can retry, and NEVER throws (a feed bind failure
   * must not crash boot).
   */
  async start(): Promise<void> {
    if (this.server) {
      logger.warn('CoT feed server already started');
      return;
    }

    return new Promise((resolve) => {
      const server = new Server((socket) => this.handleNewClient(socket));
      this.server = server;

      server.on('error', (error: Error) => {
        this.server = null; // allow a future start() to retry instead of no-op'ing
        server.close();
        logger.error(`❌ CoT feed port ${this.config.port} unavailable — feed disabled: ${error.message}`);
        resolve();
      });

      server.listen(this.config.port, '0.0.0.0', () => {
        // When bound with an ephemeral port (0), remember the OS-assigned
        // port so getStatus()/tests can connect to it.
        const address = server.address();
        if (this.config.port === 0 && address && typeof address === 'object') {
          this.config = { ...this.config, port: address.port };
        }

        logger.info(`📡 CoT feed server listening on port ${this.config.port}`);
        this.resendTimer = setInterval(() => {
          void this.broadcastSnapshot();
        }, this.resendIntervalMs);

        resolve();
      });
    });
  }

  /** Clears the resend timer, destroys every connected client, and closes the server. */
  async stop(): Promise<void> {
    if (this.resendTimer) {
      clearInterval(this.resendTimer);
      this.resendTimer = null;
    }

    for (const socket of this.clients) {
      socket.destroy();
    }
    this.clients.clear();

    const server = this.server;
    if (!server) {
      return;
    }
    this.server = null;

    return new Promise((resolve) => {
      server.close(() => {
        logger.info('🛑 CoT feed server stopped');
        resolve();
      });
    });
  }

  getStatus(): CotFeedStatus {
    return {
      enabled: this.config.enabled,
      port: this.config.port,
      clientCount: this.clients.size,
      listening: this.server !== null,
    };
  }

  private handleNewClient(socket: Socket): void {
    if (this.clients.size >= this.maxClients) {
      logger.warn(`CoT feed: client cap (${this.maxClients}) reached, rejecting connection from ${socket.remoteAddress ?? 'unknown'}`);
      socket.destroy();
      return;
    }

    this.clients.add(socket);
    logger.debug(`📡 CoT feed client connected: ${socket.remoteAddress ?? 'unknown'} (${this.clients.size} total)`);

    // RX-only: never parse inbound bytes. Discarding here also eliminates a
    // parser attack surface entirely — see spec §3.
    socket.on('data', () => {});
    socket.on('error', (error: Error) => {
      logger.debug(`CoT feed client socket error: ${error.message}`);
      this.clients.delete(socket);
    });
    socket.on('close', () => {
      this.clients.delete(socket);
      logger.debug(`📡 CoT feed client disconnected (${this.clients.size} remaining)`);
    });

    void this.buildSnapshot()
      .then((snapshot) => {
        if (!socket.destroyed && socket.writable) {
          socket.write(snapshot);
        }
      })
      .catch((error) => {
        logger.error('CoT feed: failed to send snapshot to new client:', error);
      });
  }

  /**
   * Builds the full current snapshot: every ATAK contact across all sources
   * plus every positioned mesh node across all sources (including MeshCore).
   * No de-dupe (§Q3) — a node that also has an ATAK contact renders as both.
   */
  private async buildSnapshot(): Promise<string> {
    const now = Date.now();
    const events: string[] = [];

    const sourceNames = new Map<string, string>();
    try {
      for (const status of sourceManagerRegistry.getAllManagers().map((m) => m.getStatus())) {
        sourceNames.set(status.sourceId, status.sourceName);
      }
    } catch (error) {
      logger.debug('CoT feed: failed to build source name map, falling back to raw sourceIds:', error);
    }

    try {
      const contacts = await databaseService.atakContacts.getContacts(ALL_SOURCES);
      for (const row of contacts) {
        const event = buildContactEvent(row, now);
        if (event) events.push(event);
      }
    } catch (error) {
      logger.error('CoT feed: failed to load ATAK contacts for snapshot:', error);
    }

    try {
      // getAllNodes() rows carry sourceId at runtime — see the NodeRow comment above.
      const nodes = (await databaseService.nodes.getAllNodes(ALL_SOURCES)) as NodeRow[];
      for (const node of nodes) {
        const event = buildNodeEvent(node, sourceNames.get(node.sourceId), now);
        if (event) events.push(event);
      }
    } catch (error) {
      logger.error('CoT feed: failed to load nodes for snapshot:', error);
    }

    return events.join('');
  }

  /** Builds one snapshot and writes it to every connected client, dropping dead sockets. */
  private async broadcastSnapshot(): Promise<void> {
    if (this.clients.size === 0) return;

    let snapshot: string;
    try {
      snapshot = await this.buildSnapshot();
    } catch (error) {
      logger.error('CoT feed: failed to build snapshot for broadcast:', error);
      return;
    }

    for (const socket of this.clients) {
      if (socket.destroyed || !socket.writable) {
        this.clients.delete(socket);
        continue;
      }
      try {
        socket.write(snapshot);
      } catch (error) {
        logger.debug('CoT feed: failed to write to client, dropping:', error);
        this.clients.delete(socket);
        socket.destroy();
      }
    }
  }
}

export const cotFeedService = new CotFeedService();
export default cotFeedService;
