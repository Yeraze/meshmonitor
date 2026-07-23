/**
 * ATAK Contact Service (ATAK/CoT Phase 2, issue #3691)
 *
 * Owns two responsibilities:
 *  1. `buildContactRow` — a pure mapper from a decoded PLI-variant TAKPacket
 *     (see `meshtasticManager.processTakPacket`) to an `AtakContactRow`, kept
 *     free of DB/singleton concerns so it is unit-testable in isolation.
 *  2. A retention cleanup scheduler, modeled on `mqttPacketLogService.ts`
 *     (constructor starts a `setInterval`, `stop()` clears it for test
 *     teardown / symmetry).
 *
 * **uid derivation.** `device_callsign` (the ATAK EUD's stable device UID)
 * when present, else `callsign` (user-mutable display name), else the
 * carrying node fallback `!<nodeNum hex>`. **Compressed exception:** when
 * `is_compressed=true`, the string fields are unishox2-encoded and NOT safe
 * to key identity on (garbage bytes could collide or be unstable across
 * beacons) — always fall back to the nodeNum-keyed uid in that case, while
 * still persisting the (unreliable) string fields as received. See
 * docs/internal/dev-notes/ATAK_COT_PHASE2_SPEC.md §3/§6.
 *
 * **Position.** `PLI.latitude_i` / `longitude_i` are sfixed32, ×1e-7 degrees.
 * Converted coordinates are passed through `isBogusPosition` (the same
 * Null-Island/out-of-range guard used by the rest of the ingest path) —
 * a bogus fix still upserts the contact row (team/status/callsign are still
 * useful), just with `latitude`/`longitude` nulled out.
 *
 * **Retention.** Fixed 24h window (`ATAK_CONTACT_RETENTION_MS`) — contacts
 * are low-volume (one row per ATAK EUD per source) and always-on (unlike the
 * opt-in packet-log tables), so no settings knob is warranted. A separate,
 * shorter staleness constant (`ATAK_CONTACT_STALE_MS`, 15 min) is exposed for
 * the API route to compute a `stale` flag without hiding/deleting the row.
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { isBogusPosition } from '../../utils/nullIsland.js';
import type { AtakContactRow } from '../../db/repositories/atakContacts.js';

/** A contact is flagged "stale" in API responses after this long without a fresh PLI. */
export const ATAK_CONTACT_STALE_MS = 15 * 60 * 1000; // 15 minutes

/** Contact rows are purged by the retention sweep after this long without a fresh PLI. */
export const ATAK_CONTACT_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes, mirrors mqttPacketLogService

/** Formats a nodeNum as the `!aabbccdd`-style fallback identity key. */
function nodeNumFallbackUid(nodeNum: number | null): string {
  if (nodeNum === null || !Number.isFinite(nodeNum)) return '!00000000';
  return `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Pure mapper: decoded PLI-variant TAKPacket → `AtakContactRow`. Returns
 * `null` when there is no PLI variant present (caller should not have
 * reached here in that case, but this stays defensive so it's safe to call
 * directly from tests / future callers) or the decode shape is unusable.
 *
 * `meshPacket` / `tak` are untyped protobuf-decoded shapes (no generated TS
 * type for protobufjs `decode()` output), matching the existing convention
 * in `processTakPacket` — dual camelCase/snake_case field access throughout.
 */
export function buildContactRow(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #3691 untyped protobuf-decoded MeshPacket shape, matching processTakPacket's existing convention
  meshPacket: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #3691 untyped protobuf-decoded TAKPacket shape, matching processTakPacket's existing convention
  tak: any,
  sourceId: string,
): AtakContactRow | null {
  if (!tak || typeof tak !== 'object' || tak instanceof Uint8Array) return null;

  const pli = tak.pli;
  if (!pli) return null;

  const nodeNumRaw = Number(meshPacket?.from);
  const nodeNum = Number.isFinite(nodeNumRaw) ? nodeNumRaw >>> 0 : null;

  const isCompressed = Boolean(tak.isCompressed ?? tak.is_compressed);
  const callsign: string | null = tak.contact?.callsign ?? null;
  const deviceCallsign: string | null = tak.contact?.deviceCallsign ?? tak.contact?.device_callsign ?? null;

  // Compressed strings are unishox2-encoded — unreliable for identity, so
  // always key on the carrying node when compressed (§3/§6 decision).
  let uid: string;
  if (isCompressed) {
    uid = nodeNumFallbackUid(nodeNum);
  } else if (deviceCallsign) {
    uid = deviceCallsign;
  } else if (callsign) {
    uid = callsign;
  } else {
    uid = nodeNumFallbackUid(nodeNum);
  }

  const team = tak.group?.team;
  const role = tak.group?.role;
  const battery = tak.status?.battery;

  const latitudeI = pli.latitudeI ?? pli.latitude_i;
  const longitudeI = pli.longitudeI ?? pli.longitude_i;
  let latitude: number | null = typeof latitudeI === 'number' ? latitudeI * 1e-7 : null;
  let longitude: number | null = typeof longitudeI === 'number' ? longitudeI * 1e-7 : null;
  if (latitude !== null && longitude !== null && isBogusPosition(latitude, longitude)) {
    latitude = null;
    longitude = null;
  }

  const altitude = typeof pli.altitude === 'number' ? pli.altitude : null;
  const speed = typeof pli.speed === 'number' ? pli.speed : null;
  const course = typeof pli.course === 'number' ? pli.course : null;

  const now = Date.now();

  return {
    uid,
    sourceId,
    nodeNum,
    callsign,
    deviceCallsign,
    team: typeof team === 'number' ? team : null,
    role: typeof role === 'number' ? role : null,
    battery: typeof battery === 'number' ? battery : null,
    latitude,
    longitude,
    altitude,
    speed,
    course,
    lastSeen: now,
    createdAt: now,
  };
}

/**
 * Cleanup scheduler for `atak_contacts` retention (fixed 24h window). Modeled
 * on `MqttPacketLogService` — a small singleton that starts a `setInterval`
 * in its constructor and exposes `stop()` for test teardown.
 */
class AtakContactService {
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startCleanupScheduler();
  }

  startCleanupScheduler(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    logger.debug('🧹 Starting ATAK contact retention cleanup scheduler (runs every 15 minutes)');
    this.cleanupInterval = setInterval(() => {
      void this.runCleanup();
    }, CLEANUP_INTERVAL_MS);
  }

  /** Removes contact rows whose `lastSeen` is older than the fixed 24h retention window. */
  async runCleanup(): Promise<void> {
    try {
      const cutoff = Date.now() - ATAK_CONTACT_RETENTION_MS;
      const removed = await databaseService.atakContacts.deleteContactsOlderThan(cutoff);
      if (removed > 0) {
        logger.debug(`🧹 ATAK contact cleanup: removed ${removed} stale contact row(s)`);
      }
    } catch (error) {
      logger.error('❌ Failed to clean up ATAK contacts:', error);
    }
  }

  /** Stops the retention scheduler — used for test teardown / graceful shutdown symmetry. */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      logger.debug('🛑 Stopped ATAK contact retention cleanup scheduler');
    }
  }
}

export const atakContactService = new AtakContactService();
export default atakContactService;
