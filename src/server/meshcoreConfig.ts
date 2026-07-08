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
  };
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

  // Companion-USB / direct serial — the v1 path.
  const port = cfg.serialPort || cfg.port;
  if ((cfg.transport === 'usb' || cfg.transport === 'serial' || !cfg.transport) && port) {
    return {
      connectionType: ConnectionType.SERIAL,
      serialPort: port,
      baudRate: cfg.baudRate ?? 115200,
      firmwareType,
      virtualNode,
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
      heartbeatIntervalSeconds: cfg.heartbeatIntervalSeconds,
    };
  }

  return null;
}
