/**
 * Waypoint Service
 *
 * Handles waypoint domain logic: decoding inbound Meshtastic waypoint payloads,
 * persisting per-source rows, generating local ids for waypoints created in the
 * UI, and the periodic expire sweep. All persistence flows through
 * `databaseService.waypoints` so the raw-SQL ban (CLAUDE.md) is preserved.
 *
 * Wire protocol reference (meshtastic.Waypoint):
 *   - id (uint32)
 *   - latitude_i, longitude_i (sfixed32, divided by 1e7 for degrees)
 *   - expire (uint32 epoch seconds; 0 means "delete this waypoint")
 *   - locked_to (uint32 nodeNum; 0 = open to anyone)
 *   - name (≤30 chars), description (≤100 chars)
 *   - icon (fixed32 unicode codepoint)
 */
import crypto from 'crypto';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { dataEventEmitter } from './dataEventEmitter.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import type { Waypoint } from '../../db/repositories/waypoints.js';

/** Default emoji shown when a waypoint arrives without a valid icon codepoint. */
const FALLBACK_ICON = '\u{1F4CD}'; // 📍

/** Expire grace window: keep expired rows around for ~24h before sweeping. */
const DEFAULT_GRACE_SECONDS = 86400;

/** Inbound decoded protobuf shape we care about. Field names follow the
 * camelCase / snake_case duality emitted by protobufjs. */
export interface DecodedWaypointMessage {
  id?: number | bigint;
  // both casings are observed depending on the protobufjs config
  latitudeI?: number;
  latitude_i?: number;
  longitudeI?: number;
  longitude_i?: number;
  expire?: number;
  lockedTo?: number;
  locked_to?: number;
  name?: string;
  description?: string;
  icon?: number;
}

/**
 * Pick a numeric field that may have arrived in either camelCase or snake_case form.
 */
function pickNumber(...candidates: (number | bigint | undefined | null)[]): number | undefined {
  for (const v of candidates) {
    if (v === undefined || v === null) continue;
    return Number(v);
  }
  return undefined;
}

/**
 * Convert a unicode codepoint to its emoji string. Returns `null` when the
 * codepoint is 0 / out of range — callers should fall back to `FALLBACK_ICON`.
 */
export function codepointToEmoji(cp: number | undefined | null): string | null {
  if (cp === undefined || cp === null) return null;
  const n = Number(cp);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Valid Unicode codepoints are 0..0x10FFFF
  if (n > 0x10ffff) return null;
  try {
    return String.fromCodePoint(n);
  } catch {
    return null;
  }
}

/**
 * Convert a leading emoji/character to its codepoint, useful when the UI sends
 * an emoji string instead of a numeric codepoint.
 */
export function emojiToCodepoint(s: string | undefined | null): number | null {
  if (!s) return null;
  const cp = s.codePointAt(0);
  return cp ?? null;
}

export interface CreateLocalInput {
  latitude: number;
  longitude: number;
  name?: string;
  description?: string;
  /** Either a unicode codepoint number or a single-emoji string. */
  icon?: number | string | null;
  /** Epoch seconds; null/undefined = no expiry. */
  expireAt?: number | null;
  /** nodeNum that's allowed to edit, or 0/null for open. */
  lockedTo?: number | null;
  rebroadcastIntervalS?: number | null;
}

export interface UpdateInput {
  latitude?: number;
  longitude?: number;
  name?: string;
  description?: string;
  icon?: number | string | null;
  expireAt?: number | null;
  lockedTo?: number | null;
  rebroadcastIntervalS?: number | null;
}

class WaypointService {
  /**
   * Apply an inbound Meshtastic Waypoint packet. A non-zero `expire` in the
   * past is the Meshtastic Apple-client tombstone convention (delete);
   * `expire === 0` means "no expiration" and the waypoint is upserted.
   */
  async upsertFromMesh(
    sourceId: string,
    fromNum: number | bigint,
    decoded: DecodedWaypointMessage,
  ): Promise<Waypoint | null> {
    const waypointId = pickNumber(decoded.id);
    if (waypointId === undefined) {
      logger.warn('[waypointService] Inbound waypoint missing id, ignoring');
      return null;
    }

    const expire = pickNumber(decoded.expire) ?? 0;

    // Meshtastic delete tombstone: a non-zero past epoch (Apple sends expire=1).
    // expire === 0 means "no expiration" — Android/Apple both send 0 for waypoints
    // with no expiry set, so we must NOT treat 0 as a delete.
    const nowSec = Math.floor(Date.now() / 1000);
    if (expire > 0 && expire <= nowSec) {
      const removed = await databaseService.waypoints.deleteAsync(sourceId, waypointId);
      if (removed) {
        dataEventEmitter.emitWaypointDeleted({ sourceId, waypointId }, sourceId);
        logger.debug(`[waypointService] Deleted waypoint ${waypointId} via mesh tombstone (source ${sourceId})`);
      }
      return null;
    }

    const latI = pickNumber(decoded.latitudeI, decoded.latitude_i);
    const lonI = pickNumber(decoded.longitudeI, decoded.longitude_i);
    if (latI === undefined || lonI === undefined) {
      logger.warn(`[waypointService] Waypoint ${waypointId} missing coordinates, ignoring`);
      return null;
    }

    const lockedTo = pickNumber(decoded.lockedTo, decoded.locked_to) ?? 0;
    const rawIconCp = pickNumber(decoded.icon);
    // Treat 0/invalid codepoints as "no icon" — 0 is a falsy sentinel from the
    // wire format meaning the sender omitted it. We persist null + emit the
    // fallback emoji so the UI always has something to render.
    const iconCodepoint =
      rawIconCp !== undefined && rawIconCp > 0 && rawIconCp <= 0x10ffff ? rawIconCp : null;
    const iconEmoji = codepointToEmoji(iconCodepoint ?? undefined) ?? FALLBACK_ICON;
    const ownerNodeNum = Number(fromNum);

    const persisted = await databaseService.waypoints.upsertAsync({
      sourceId,
      waypointId,
      ownerNodeNum: Number.isFinite(ownerNodeNum) ? ownerNodeNum : null,
      latitude: latI / 1e7,
      longitude: lonI / 1e7,
      expireAt: expire,
      lockedTo: lockedTo === 0 ? null : lockedTo,
      name: (decoded.name ?? '').toString().slice(0, 30),
      description: (decoded.description ?? '').toString().slice(0, 100),
      iconCodepoint: iconCodepoint ?? null,
      iconEmoji,
      isVirtual: false,
    });

    dataEventEmitter.emitWaypointUpserted(persisted, sourceId);
    return persisted;
  }

  /** List all waypoints for a source. */
  async list(sourceId: string, options?: { includeExpired?: boolean; bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number } }) {
    return databaseService.waypoints.listAsync(sourceId, options);
  }

  /** Fetch a specific waypoint. */
  async get(sourceId: string, waypointId: number) {
    return databaseService.waypoints.getAsync(sourceId, waypointId);
  }

  /**
   * Generate a fresh waypoint id matching the Python convention used in the
   * official Meshtastic clients: `randint(0, 2**32) * 1e9 / 2**32` floor'd to
   * an integer. Retries on collision with the existing id set.
   */
  async generateLocalIdAsync(sourceId: string): Promise<number> {
    const existing = await databaseService.waypoints.getExistingIdsAsync(sourceId);
    for (let attempt = 0; attempt < 32; attempt++) {
      const r = crypto.randomInt(0, 2 ** 32);
      const id = Math.floor((r * 1e9) / 2 ** 32);
      if (id > 0 && !existing.has(id)) return id;
    }
    throw new Error('Could not allocate a unique waypoint id after 32 attempts');
  }

  /** Locally create a waypoint (UI-driven). The caller is responsible for
   * broadcasting the new waypoint over the mesh when `virtual` is false. */
  async createLocal(
    sourceId: string,
    ownerNodeNum: number,
    fields: CreateLocalInput,
    options: { virtual?: boolean } = {},
  ): Promise<Waypoint> {
    const waypointId = await this.generateLocalIdAsync(sourceId);

    const iconCodepoint =
      typeof fields.icon === 'number'
        ? fields.icon
        : typeof fields.icon === 'string'
          ? emojiToCodepoint(fields.icon)
          : null;
    const iconEmoji = codepointToEmoji(iconCodepoint) ?? FALLBACK_ICON;

    const persisted = await databaseService.waypoints.upsertAsync({
      sourceId,
      waypointId,
      ownerNodeNum,
      latitude: fields.latitude,
      longitude: fields.longitude,
      expireAt: fields.expireAt ?? null,
      lockedTo: fields.lockedTo ?? null,
      name: (fields.name ?? '').slice(0, 30),
      description: (fields.description ?? '').slice(0, 100),
      iconCodepoint: iconCodepoint ?? null,
      iconEmoji,
      isVirtual: Boolean(options.virtual),
      rebroadcastIntervalS: fields.rebroadcastIntervalS ?? null,
    });

    dataEventEmitter.emitWaypointUpserted(persisted, sourceId);
    return persisted;
  }

  /**
   * Update an existing waypoint. Enforces `lockedTo`: a non-zero value means
   * only the owning nodeNum may modify; a different caller is rejected.
   */
  async update(
    sourceId: string,
    waypointId: number,
    callerNodeNum: number,
    fields: UpdateInput,
  ): Promise<Waypoint> {
    const existing = await databaseService.waypoints.getAsync(sourceId, waypointId);
    if (!existing) throw new Error(`waypoint ${waypointId} not found in source ${sourceId}`);
    if (existing.lockedTo && existing.lockedTo !== callerNodeNum) {
      throw new Error(`waypoint ${waypointId} is locked to ${existing.lockedTo}`);
    }

    let iconCodepoint = existing.iconCodepoint;
    let iconEmoji = existing.iconEmoji;
    if (fields.icon !== undefined && fields.icon !== null) {
      iconCodepoint = typeof fields.icon === 'number' ? fields.icon : emojiToCodepoint(fields.icon);
      iconEmoji = codepointToEmoji(iconCodepoint) ?? FALLBACK_ICON;
    }

    const persisted = await databaseService.waypoints.upsertAsync({
      sourceId,
      waypointId,
      ownerNodeNum: existing.ownerNodeNum,
      latitude: fields.latitude ?? existing.latitude,
      longitude: fields.longitude ?? existing.longitude,
      expireAt: fields.expireAt === undefined ? existing.expireAt : fields.expireAt,
      lockedTo: fields.lockedTo === undefined ? existing.lockedTo : fields.lockedTo,
      name: (fields.name ?? existing.name).slice(0, 30),
      description: (fields.description ?? existing.description).slice(0, 100),
      iconCodepoint,
      iconEmoji,
      isVirtual: existing.isVirtual,
      rebroadcastIntervalS:
        fields.rebroadcastIntervalS === undefined
          ? existing.rebroadcastIntervalS
          : fields.rebroadcastIntervalS,
    });

    dataEventEmitter.emitWaypointUpserted(persisted, sourceId);
    return persisted;
  }

  /** Delete a waypoint locally with the same lockedTo enforcement as update. */
  async deleteLocal(sourceId: string, waypointId: number, callerNodeNum: number): Promise<boolean> {
    const existing = await databaseService.waypoints.getAsync(sourceId, waypointId);
    if (!existing) return false;
    if (existing.lockedTo && existing.lockedTo !== callerNodeNum) {
      throw new Error(`waypoint ${waypointId} is locked to ${existing.lockedTo}`);
    }
    const removed = await databaseService.waypoints.deleteAsync(sourceId, waypointId);
    if (removed) {
      dataEventEmitter.emitWaypointDeleted({ sourceId, waypointId }, sourceId);
    }
    return removed;
  }

  /**
   * Rebroadcast scheduler tick. Picks at most ONE eligible waypoint across all
   * sources, re-broadcasts it through its source manager, and stamps
   * `lastBroadcastAt` on success. This enforces a hard global airtime floor:
   * the caller invokes this every 60 seconds, so at worst one waypoint per
   * minute goes out regardless of how many waypoints are configured.
   *
   * Returns the waypoint that was rebroadcast, or `null` when nothing was
   * eligible or the send failed.
   */
  async rebroadcastTick(): Promise<Waypoint | null> {
    const nowSec = Math.floor(Date.now() / 1000);
    let candidate: Waypoint | null;
    try {
      candidate = await databaseService.waypoints.findOldestEligibleForRebroadcastAsync(nowSec);
    } catch (error) {
      logger.error('[waypointService] rebroadcastTick: eligibility query failed:', error);
      return null;
    }

    if (!candidate) return null;

    const manager = sourceManagerRegistry.getManager(candidate.sourceId) as any;
    if (!manager || typeof manager.broadcastWaypoint !== 'function') {
      // Source manager isn't reachable (e.g. disconnected). Skip this tick;
      // we'll retry next minute. Do NOT stamp lastBroadcastAt — the waypoint
      // should remain eligible so it gets sent as soon as the manager is back.
      logger.debug(
        `[waypointService] rebroadcastTick: no manager for source ${candidate.sourceId}, skipping`,
      );
      return null;
    }

    try {
      const packetId = await manager.broadcastWaypoint({
        id: candidate.waypointId,
        latitude: candidate.latitude,
        longitude: candidate.longitude,
        expire: candidate.expireAt ?? 0,
        lockedTo: candidate.lockedTo ?? 0,
        name: candidate.name,
        description: candidate.description,
        icon: candidate.iconCodepoint ?? 0,
      });

      if (!packetId) {
        // Manager refused (e.g. not connected). Same rationale as above —
        // leave lastBroadcastAt alone so we retry next tick.
        logger.debug(
          `[waypointService] rebroadcastTick: broadcastWaypoint returned 0 for ${candidate.sourceId}/${candidate.waypointId}`,
        );
        return null;
      }

      await databaseService.waypoints.markRebroadcastedAsync(
        candidate.sourceId,
        candidate.waypointId,
        nowSec,
      );

      // Surface the updated row to listeners so the UI's lastBroadcastAt
      // refreshes without a polling round-trip.
      const refreshed = await databaseService.waypoints.getAsync(
        candidate.sourceId,
        candidate.waypointId,
      );
      if (refreshed) {
        dataEventEmitter.emitWaypointUpserted(refreshed, refreshed.sourceId);
      }

      logger.info(
        `[waypointService] Rebroadcast waypoint ${candidate.waypointId} on source ${candidate.sourceId} (packetId=${packetId})`,
      );
      return refreshed ?? candidate;
    } catch (error) {
      logger.error('[waypointService] rebroadcastTick: broadcast failed:', error);
      return null;
    }
  }

  /** Periodic sweep — removes waypoints whose `expire_at` is older than now-grace. */
  async expireSweep(graceSeconds = DEFAULT_GRACE_SECONDS): Promise<number> {
    try {
      const removed = await databaseService.waypoints.sweepExpiredAsync(graceSeconds);
      for (const w of removed) {
        dataEventEmitter.emitWaypointExpired(
          { sourceId: w.sourceId, waypointId: w.waypointId },
          w.sourceId,
        );
      }
      if (removed.length > 0) {
        logger.info(`[waypointService] Expired sweep removed ${removed.length} waypoint(s)`);
      }
      return removed.length;
    } catch (error) {
      logger.error('[waypointService] expireSweep failed:', error);
      return 0;
    }
  }
}

export const waypointService = new WaypointService();
