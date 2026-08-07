/**
 * MeshCore source-config helpers.
 *
 * Converts a `sources.config` record (stored as JSON in the DB) into the
 * runtime `MeshCoreConfig` shape that `MeshCoreManager.connect()` expects.
 *
 * Extracted from meshcoreRegistry.ts so this logic can be imported without
 * pulling in the (now-deprecated) MeshCoreManagerRegistry class.
 */

import { ConnectionType, MeshCoreManager, type MeshCoreConfig } from './meshcoreManager.js';
import type { Source } from '../db/repositories/sources.js';
import { sourceManagerRegistry } from './sourceManagerRegistry.js';
import { isMeshCoreManager } from './sourceManagerTypes.js';
import { logger } from '../utils/logger.js';
import { normalizeBrokerUrl } from './transports/mqttBrokerClient.js';

export interface MeshCoreSourceConfig {
  transport?: 'usb' | 'serial' | 'tcp';
  port?: string;
  serialPort?: string;
  baudRate?: number;
  tcpHost?: string;
  tcpPort?: number;
  deviceType?: 'companion' | 'repeater';
  autoConnect?: boolean;
  /**
   * Companion heartbeat / auto-reconnect interval in seconds (0 = disabled).
   * Mirrors the Meshtastic source setting. When > 0 the manager periodically
   * probes the node (cheap RTC read) and, on repeated failure, tears down and
   * reconnects with exponential backoff. Only honoured for companion devices
   * (the native backend); repeater/direct-serial ignores it.
   */
  heartbeatIntervalSeconds?: number;
  // Virtual Node server — expose this node to the MeshCore app over WiFi (#3535).
  virtualNode?: {
    enabled?: boolean;
    port?: number;
    allowAdminCommands?: boolean;
    /**
     * Allow connected apps to read the node's Ed25519 private key over the
     * Virtual Node port via ExportPrivateKey(23). SECURITY-SENSITIVE, and
     * deliberately separate from `allowAdminCommands`: the VN port has no
     * per-client auth, so anything that can reach it gets the key. Off by
     * default.
     */
    allowPkiExport?: boolean;
  };
  observer?: MeshCoreObserverConfig;
}

/**
 * MeshCore Analyzer Observer output (#4457). When enabled, Phase 2's publisher
 * relays every OTA packet this companion hears to a MeshCore-Analyzer-compatible
 * MQTT broker. Observation-only: MeshMonitor publishes, never subscribes.
 *
 * NOTE: the Ed25519 signing key is deliberately NOT part of this block. It lives
 * encrypted in `meshcore_observer_keys` (see meshcoreObserverKeyStore) so it never
 * rides along in a config response or the source-edit form round-trip.
 */
export interface MeshCoreObserverConfig {
  enabled?: boolean;
  /**
   * How MeshMonitor authenticates to the broker (issue #4595).
   * - `token` (default, and the value assumed when absent): mint an
   *   Ed25519-signed token with the companion's own signing key; username is
   *   `v1_{PUBLIC_KEY}`. FL Mesh / LetsMesh-backbone brokers.
   * - `password`: send a STATIC MQTT username/password. Used by regional
   *   brokers (e.g. meshcoretel.ru) that don't verify the signature. The
   *   password is NEVER in this block — it lives encrypted in
   *   `meshcore_observer_credentials` (see meshcoreObserverCredentialStore).
   */
  authMode?: 'token' | 'password';
  /** Broker URL. ws/wss/mqtt/mqtts; bare host:port is normalized by normalizeBrokerUrl. */
  brokerUrl?: string;
  /** 3-letter IATA region code, or the literal 'test' for local validation. */
  iataCode?: string;
  /**
   * Must equal the broker's AUTH_EXPECTED_AUDIENCE, or auth is rejected.
   * Only meaningful in `token` mode — a static-credential broker signs
   * nothing, so there is no audience to match.
   */
  tokenAudience?: string;
}

/** Normalize the (optional, back-compatible) observer auth mode. */
export function observerAuthMode(o: MeshCoreObserverConfig | undefined | null): 'token' | 'password' {
  return o?.authMode === 'password' ? 'password' : 'token';
}

/** Default TCP port the Virtual Node server listens on when none is given. */
export const DEFAULT_VIRTUAL_NODE_PORT = 5000;

/**
 * Build the runtime virtual-node config from a source's saved config, or
 * undefined when disabled/absent. A non-positive or missing port falls back to
 * the default so an enabled server always binds to a usable port.
 */
export function virtualNodeConfigFromSource(cfg: MeshCoreSourceConfig): MeshCoreConfig['virtualNode'] {
  const vn = cfg.virtualNode;
  if (!vn?.enabled) return undefined;
  return {
    enabled: true,
    port: typeof vn.port === 'number' && vn.port > 0 ? vn.port : DEFAULT_VIRTUAL_NODE_PORT,
    allowAdminCommands: vn.allowAdminCommands === true,
    allowPkiExport: vn.allowPkiExport === true,
  };
}

/**
 * Build the runtime Analyzer Observer config from a source's saved config, or
 * undefined when disabled/absent or missing a required field.
 *
 * Required fields depend on the auth mode (#4595): `token` mode needs
 * brokerUrl + iataCode + tokenAudience; `password` mode needs only brokerUrl
 * + iataCode, because the broker verifies no signature and therefore has no
 * audience. The username/password themselves are NOT config — they live
 * encrypted in `meshcore_observer_credentials`.
 */
export function observerConfigFromSource(cfg: MeshCoreSourceConfig): MeshCoreConfig['observer'] {
  const o = cfg.observer;
  if (!o?.enabled) return undefined;
  const authMode = observerAuthMode(o);
  if (!o.brokerUrl || !o.iataCode) return undefined;
  if (authMode === 'token' && !o.tokenAudience) return undefined;
  // The stored URL was validated at write time, but normalize can still throw
  // on a row written by an older version or edited out-of-band. Silently
  // returning undefined here would disable the observer with no trace — warn
  // so the operator can see why it never started.
  let brokerUrl: string;
  try {
    brokerUrl = normalizeBrokerUrl(o.brokerUrl);
  } catch {
    logger.warn('[MeshCoreConfig] observer.brokerUrl failed to normalize; observer disabled for this source');
    return undefined;
  }
  return {
    enabled: true,
    authMode,
    brokerUrl,
    iataCode: o.iataCode.trim().toUpperCase(),
    // Carried through in password mode only when the operator happened to
    // leave a value behind; the publisher ignores it in that mode.
    tokenAudience: o.tokenAudience?.trim(),
  };
}

/**
 * Ensure a MeshCore manager is started for the given source.
 *
 * - If no manager is registered: creates one, configures it, and registers it
 *   (which auto-calls start() → connect()).
 * - If a MeshCore manager is registered but disconnected: reconnects it with
 *   the supplied config.
 * - If already registered and connected: logs a debug message and skips.
 *
 * This is the canonical create-or-connect recipe for MeshCore sources, shared
 * by sourceRoutes.ts (auto-connect on create/enable/config-change) and
 * server.ts (startup auto-connect loop).
 */
export async function ensureMeshCoreManagerStarted(source: Source, cfg: MeshCoreConfig): Promise<void> {
  const existing = sourceManagerRegistry.getManager(source.id);
  if (!existing) {
    const mc = new MeshCoreManager(source.id, source.name);
    mc.configure(cfg);
    await sourceManagerRegistry.addManager(mc);
  } else if (isMeshCoreManager(existing) && !existing.isConnected()) {
    await existing.connect(cfg);
  } else {
    logger.debug(`[MeshCore:${source.id}] Manager already registered as meshcore and connected — skipping auto-connect`);
  }
}

/**
 * Convert a `sources.config` record into the runtime `MeshCoreConfig`
 * shape that `MeshCoreManager.connect` expects. Supports companion-USB/serial
 * and TCP transports. Returns null when the config is missing required fields.
 */
export function meshcoreConfigFromSource(source: Source): MeshCoreConfig | null {
  const cfg = (source.config ?? {}) as MeshCoreSourceConfig;
  const firmwareType = cfg.deviceType === 'repeater' ? 'repeater' : 'companion';
  const virtualNode = virtualNodeConfigFromSource(cfg);
  const observer = observerConfigFromSource(cfg);

  // Companion-USB / direct serial — the v1 path.
  const port = cfg.serialPort || cfg.port;
  if ((cfg.transport === 'usb' || cfg.transport === 'serial' || !cfg.transport) && port) {
    return {
      connectionType: ConnectionType.SERIAL,
      serialPort: port,
      baudRate: cfg.baudRate ?? 115200,
      firmwareType,
      virtualNode,
      observer,
      heartbeatIntervalSeconds: cfg.heartbeatIntervalSeconds,
    };
  }

  if (cfg.transport === 'tcp' && cfg.tcpHost) {
    return {
      connectionType: ConnectionType.TCP,
      tcpHost: cfg.tcpHost,
      tcpPort: cfg.tcpPort ?? 4403,
      firmwareType,
      virtualNode,
      observer,
      heartbeatIntervalSeconds: cfg.heartbeatIntervalSeconds,
    };
  }

  return null;
}
