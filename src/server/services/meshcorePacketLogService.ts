import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import type { DbMeshCorePacket, MeshCorePacketQuery, MeshCoreGroupedPacket } from '../../db/repositories/meshcore.js';

/**
 * Service for the MeshCore Packet Monitor — the OTA-packet analogue of
 * `packetLogService` for Meshtastic. Wraps the MeshCore repository's
 * packet-log methods, exposes the opt-in enable/retention settings, and
 * runs a periodic retention sweep (age + per-source count cap).
 */
class MeshCorePacketLogService {
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
  private readonly DEFAULT_MAX_COUNT = 1000;
  private readonly DEFAULT_MAX_AGE_HOURS = 24;
  /**
   * Row cap for a `meshcore_mqtt` region feed (#5040 Phase 2).
   *
   * Deliberately far above the 1,000 a device-backed source gets. A region feed
   * carries what EVERY observer heard, one row per observer, so 1,000 rows is
   * minutes of history on a busy region and the monitor is useless. 50,000 is
   * roughly 50-100MB of SQLite per source at typical row sizes — noticeable on
   * a Pi, which is why the UI warns next to the input rather than burying it in
   * docs. User-configurable via `meshcore_mqtt_packet_log_max_count`.
   */
  private readonly DEFAULT_INGEST_MAX_COUNT = 50_000;

  constructor() {
    this.startCleanupScheduler();
  }

  private startCleanupScheduler(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    logger.debug('🧹 Starting MeshCore packet log cleanup scheduler (runs every 15 minutes)');
    this.cleanupInterval = setInterval(() => {
      void this.runCleanup();
    }, this.CLEANUP_INTERVAL_MS);
  }

  /**
   * Remove rows older than the configured max age, then trim each source's
   * log down to the configured max count.
   */
  async runCleanup(): Promise<void> {
    try {
      const maxAgeHours = await this.getMaxAgeHours();
      const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
      let removed = await databaseService.meshcore.deletePacketsOlderThan(cutoff);

      // Row caps are applied PER SOURCE, and the two source kinds have very
      // different volume profiles: a device-backed source logs its own radio's
      // earshot, while a meshcore_mqtt source logs what every observer in a
      // region heard, one row per observer (#5040 Phase 2). A single cap cannot
      // serve both — raising it for a region feed would bloat every device
      // source's log too — so each kind reads its own setting.
      const deviceMaxCount = await this.getMaxCount();
      const ingestMaxCount = await this.getIngestMaxCount();
      const ingestSourceIds = new Set(
        (await databaseService.sources.getAllSources())
          .filter((src) => src.type === 'meshcore_mqtt')
          .map((src) => src.id),
      );
      const sourceIds = await databaseService.meshcore.getPacketLogSourceIds();
      for (const sourceId of sourceIds) {
        const cap = ingestSourceIds.has(sourceId) ? ingestMaxCount : deviceMaxCount;
        removed += await databaseService.meshcore.trimPacketsToCount(sourceId, cap);
      }

      if (removed > 0) {
        logger.debug(`🧹 MeshCore packet log cleanup: removed ${removed} old packets`);
      }
    } catch (error) {
      logger.error('❌ Failed to cleanup MeshCore packet logs:', error);
    }
  }

  /**
   * Persist one OTA packet. Best-effort: a failure must not break the
   * MeshCore message stream.
   */
  async logPacket(packet: DbMeshCorePacket): Promise<void> {
    try {
      await databaseService.meshcore.insertPacket(packet);
    } catch (error) {
      logger.error('❌ Failed to log MeshCore packet:', error);
    }
  }

  async getPackets(query: MeshCorePacketQuery): Promise<DbMeshCorePacket[]> {
    return databaseService.meshcore.getPackets(query);
  }

  /**
   * Collapsed view: one entry per distinct frame, with the per-observer
   * receptions of a `meshcore_mqtt` source folded into counts (#5040 Phase 2b).
   * A device-backed source has one reception per frame, so this degenerates to
   * the flat list for it.
   */
  async getGroupedPackets(query: MeshCorePacketQuery): Promise<MeshCoreGroupedPacket[]> {
    return databaseService.meshcore.getGroupedPackets(query);
  }

  async getGroupedPacketCount(query: MeshCorePacketQuery): Promise<number> {
    return databaseService.meshcore.getGroupedPacketCount(query);
  }

  /** The per-observer receptions behind one grouped row. */
  async getPacketReceptions(sourceId: string, rawHex: string): Promise<DbMeshCorePacket[]> {
    return databaseService.meshcore.getPacketReceptions(sourceId, rawHex);
  }

  async getPacketCount(query: MeshCorePacketQuery): Promise<number> {
    return databaseService.meshcore.getPacketCount(query);
  }

  async clearPackets(sourceId?: string): Promise<number> {
    return databaseService.meshcore.deleteAllPackets(sourceId);
  }

  /** MeshCore OTA-packet capture is opt-in and off by default. */
  async isEnabled(): Promise<boolean> {
    const enabled = await databaseService.getSettingAsync('meshcore_packet_log_enabled');
    return enabled === '1';
  }

  async getMaxCount(): Promise<number> {
    const raw = await databaseService.getSettingAsync('meshcore_packet_log_max_count');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : this.DEFAULT_MAX_COUNT;
  }

  /** Row cap for meshcore_mqtt ingest sources; see DEFAULT_INGEST_MAX_COUNT. */
  async getIngestMaxCount(): Promise<number> {
    const raw = await databaseService.getSettingAsync('meshcore_mqtt_packet_log_max_count');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : this.DEFAULT_INGEST_MAX_COUNT;
  }

  async getMaxAgeHours(): Promise<number> {
    const raw = await databaseService.getSettingAsync('meshcore_packet_log_max_age_hours');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : this.DEFAULT_MAX_AGE_HOURS;
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      logger.debug('🛑 Stopped MeshCore packet log cleanup scheduler');
    }
  }
}

export default new MeshCorePacketLogService();
