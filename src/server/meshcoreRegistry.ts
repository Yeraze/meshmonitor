/**
 * MeshCoreManagerRegistry — per-source registry of MeshCoreManager instances.
 *
 * Slice 1 of the multi-source MeshCore refactor (companion-USB only):
 * lifts MeshCore from a module-level singleton to one manager per
 * `sources.id`, mirroring how Meshtastic TCP already works via
 * `sourceManagerRegistry`.
 *
 * Route nesting (`/api/sources/:id/meshcore/*`), the per-source UI, and
 * the `meshcore` permission collapse are deferred to slice 2/3.
 */
import { MeshCoreManager, ConnectionType, type MeshCoreConfig } from './meshcoreManager.js';
import type { Source } from '../db/repositories/sources.js';
import { logger } from '../utils/logger.js';

/** Source id minted by migration 056 for pre-multi-source MeshCore data. */
export const LEGACY_MESHCORE_SOURCE_ID = 'meshcore-legacy-default';

interface MeshCoreSourceConfig {
  transport?: 'usb' | 'serial' | 'tcp';
  port?: string;
  serialPort?: string;
  baudRate?: number;
  tcpHost?: string;
  tcpPort?: number;
  deviceType?: 'companion' | 'repeater';
  autoConnect?: boolean;
}

/**
 * Convert a `sources.config` record into the runtime `MeshCoreConfig`
 * shape that `MeshCoreManager.connect` expects. Slice 1 only supports
 * companion-USB; other transports are documented but not yet wired.
 */
export function meshcoreConfigFromSource(source: Source): MeshCoreConfig | null {
  const cfg = (source.config ?? {}) as MeshCoreSourceConfig;
  const firmwareType = cfg.deviceType === 'repeater' ? 'repeater' : 'companion';

  // Companion-USB / direct serial — the v1 path.
  const port = cfg.serialPort || cfg.port;
  if ((cfg.transport === 'usb' || cfg.transport === 'serial' || !cfg.transport) && port) {
    return {
      connectionType: ConnectionType.SERIAL,
      serialPort: port,
      baudRate: cfg.baudRate ?? 115200,
      firmwareType,
    };
  }

  if (cfg.transport === 'tcp' && cfg.tcpHost) {
    return {
      connectionType: ConnectionType.TCP,
      tcpHost: cfg.tcpHost,
      tcpPort: cfg.tcpPort ?? 4403,
      firmwareType,
    };
  }

  return null;
}

export class MeshCoreManagerRegistry {
  private readonly managers = new Map<string, MeshCoreManager>();

  /** Get the manager for a given source, or undefined if not yet created. */
  get(sourceId: string): MeshCoreManager | undefined {
    return this.managers.get(sourceId);
  }

  /**
   * Get-or-create the manager for a source. Does NOT call connect();
   * callers do that explicitly so they can decide whether to honour
   * `autoConnect` and surface failures.
   */
  getOrCreate(source: Source): MeshCoreManager {
    const existing = this.managers.get(source.id);
    if (existing) return existing;

    const manager = new MeshCoreManager(source.id);
    this.managers.set(source.id, manager);
    logger.info(`[MeshCoreRegistry] Registered manager for source ${source.id} (${source.name})`);
    return manager;
  }

  /** List all registered managers. */
  list(): MeshCoreManager[] {
    return Array.from(this.managers.values());
  }

  /**
   * Disconnect and forget the manager for a source. Used when a source is
   * deleted or disabled.
   */
  async remove(sourceId: string): Promise<void> {
    const manager = this.managers.get(sourceId);
    if (!manager) return;
    try {
      await manager.disconnect();
    } catch (err) {
      logger.warn(`[MeshCoreRegistry] Error disconnecting ${sourceId}:`, err);
    }
    this.managers.delete(sourceId);
    logger.info(`[MeshCoreRegistry] Removed manager for source ${sourceId}`);
  }

  /** Disconnect every manager. Used on shutdown. */
  async disconnectAll(): Promise<void> {
    const ids = Array.from(this.managers.keys());
    await Promise.all(
      ids.map(async (id) => {
        try {
          await this.managers.get(id)?.disconnect();
        } catch (err) {
          logger.warn(`[MeshCoreRegistry] Error disconnecting ${id}:`, err);
        }
      }),
    );
    this.managers.clear();
  }

  /**
   * Returns the "primary" manager for legacy `/api/meshcore/*` routes that
   * are not yet nested under `/api/sources/:id/meshcore/*` (deferred to
   * slice 2). The first manager that's currently connected wins; otherwise
   * any registered manager. Returns undefined if no managers exist — the
   * caller should treat that as "MeshCore not configured".
   *
   * TODO(slice-2): remove once routes are nested and carry sourceId.
   */
  getPrimaryForLegacyRoutes(): MeshCoreManager | undefined {
    for (const m of this.managers.values()) {
      if (m.isConnected()) return m;
    }
    return this.managers.values().next().value;
  }

  /**
   * Legacy helper: return an existing manager (preferring the connected
   * one) or lazily create one against `LEGACY_MESHCORE_SOURCE_ID`. Used
   * only by the un-nested `/api/meshcore/*` routes; new code paths must
   * use `getOrCreate(source)` so that the manager is bound to a real
   * source row.
   *
   * TODO(slice-2): remove once routes are nested and carry sourceId.
   */
  getOrCreateLegacyManager(): MeshCoreManager {
    const primary = this.getPrimaryForLegacyRoutes();
    if (primary) return primary;
    logger.warn(
      `[MeshCoreRegistry] No managers registered — lazily creating legacy manager bound to ${LEGACY_MESHCORE_SOURCE_ID}. ` +
        'Configure a MeshCore source to make this explicit.',
    );
    const manager = new MeshCoreManager(LEGACY_MESHCORE_SOURCE_ID);
    this.managers.set(LEGACY_MESHCORE_SOURCE_ID, manager);
    return manager;
  }
}

/**
 * Module-level registry instance. Imported by route handlers that haven't
 * yet been migrated to per-source paths (deferred to slice 2/N).
 */
export const meshcoreManagerRegistry = new MeshCoreManagerRegistry();
