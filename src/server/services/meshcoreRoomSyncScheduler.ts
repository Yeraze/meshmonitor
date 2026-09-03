/**
 * MeshCore Room Sync Scheduler — periodic re-login to room servers to
 * trigger post push-sync.
 *
 * Room servers only push posts to logged-in clients. This scheduler
 * periodically re-logins to each opt-in room server (using saved
 * credentials from the credential store) so new posts are delivered
 * without requiring the user to be actively viewing the Rooms tab.
 *
 * Follows the same throttling pattern as MeshCoreRemoteTelemetryScheduler:
 *   - Per-room cadence: `roomSyncIntervalMinutes` from `meshcore_nodes` (min 60).
 *   - Per-source minimum: 60s between any two mesh operations.
 *   - Per-tick budget: at most one room login per manager per tick.
 *
 * Failure handling matters as much as the cadence. `lastRoomSyncAt` used to be
 * written only after a SUCCESSFUL login, so a room whose saved password had
 * gone stale never advanced its clock: it stayed the most-overdue room and was
 * retried on every 60s tick, for ever. At up to three login sends per attempt,
 * each flooding when the path is unknown, one wrong password cost on the order
 * of 180 login floods an hour — and a matching stream of rejected-login entries
 * in the room operator's own logs. So:
 *   - Every attempt stamps `lastRoomSyncAt`, success or not, so the configured
 *     interval is respected by failures too.
 *   - An explicit refusal (0x86 LoginFail) disables auto-sync immediately; the
 *     answer will not change on the next try.
 *   - Silence is ambiguous on LoRa, so it backs off and only disables after
 *     MAX_CONSECUTIVE_FAILURES attempts in a row.
 * The counter lives in the database, not on this instance: an in-memory one is
 * cleared by every restart, so a container that restarts hourly would never
 * reach the threshold (CLAUDE.md, "Does a save reset a safety timer?").
 */
import { logger } from '../../utils/logger.js';
import type { MeshCoreManager } from '../meshcoreManager.js';
import type { SourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshCoreManager } from '../sourceManagerTypes.js';
import type { MeshCoreCredentialStore } from './meshcoreCredentialStore.js';
import databaseService from '../../services/database.js';

const MIN_INTERVAL_BETWEEN_REQUESTS_MS = 60_000;
const DEFAULT_TICK_MS = 60_000;

/**
 * Consecutive unanswered syncs before auto-sync switches itself off for a
 * room. Three spread over three configured intervals (>= 3 hours) is well
 * past what a lossy link explains, and each one costs up to three login
 * floods, so waiting longer buys nothing but airtime.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

interface RoomSyncNode {
  publicKey: string;
  sourceId: string;
  roomSyncEnabled: boolean;
  roomSyncIntervalMinutes: number;
  lastRoomSyncAt: number | null;
}

export function isRoomSyncEligible(node: RoomSyncNode, now: number): boolean {
  if (!node.roomSyncEnabled) return false;
  const interval = node.roomSyncIntervalMinutes;
  if (interval === null || interval === undefined || interval < 60) return false;
  const last = node.lastRoomSyncAt ?? 0;
  return (now - last) >= interval * 60_000;
}

export function pickMostOverdueRoom(nodes: RoomSyncNode[], now: number): RoomSyncNode | undefined {
  const eligible = nodes.filter(n => isRoomSyncEligible(n, now));
  if (eligible.length === 0) return undefined;
  eligible.sort((a, b) => {
    const aOver = now - (a.lastRoomSyncAt ?? 0);
    const bOver = now - (b.lastRoomSyncAt ?? 0);
    if (aOver !== bOver) return bOver - aOver;
    return a.publicKey.localeCompare(b.publicKey);
  });
  return eligible[0];
}

export interface RoomSyncSchedulerOptions {
  registry: SourceManagerRegistry;
  credentialStore: MeshCoreCredentialStore;
  tickMs?: number;
  now?: () => number;
}

export class MeshCoreRoomSyncScheduler {
  private readonly registry: SourceManagerRegistry;
  private readonly credentialStore: MeshCoreCredentialStore;
  private readonly tickMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(opts: RoomSyncSchedulerOptions) {
    this.registry = opts.registry;
    this.credentialStore = opts.credentialStore;
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    logger.info(`[RoomSyncScheduler] Starting (tick=${this.tickMs}ms)`);
    this.timer = setInterval(() => void this.tick(), this.tickMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('[RoomSyncScheduler] Stopped');
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const managers = this.registry.getAllManagers().filter(isMeshCoreManager);
      for (const manager of managers) {
        if (!manager.isConnected()) continue;
        try {
          await this.tickOneManager(manager.sourceId, manager);
        } catch (err) {
          logger.warn(`[RoomSyncScheduler:${manager.sourceId}] Tick failed:`, err);
        }
      }
    } catch (err) {
      logger.error('[RoomSyncScheduler] tick error:', err);
    } finally {
      this.ticking = false;
    }
  }

  private async tickOneManager(sourceId: string, manager: MeshCoreManager): Promise<void> {
    // Receive-only (#4547): first statement, before any guarded send
    // primitive (loginToRoom).
    if (manager.isReceiveOnly()) {
      logger.debug(`[RoomSyncScheduler:${sourceId}] Skipping - receive-only mode`);
      return;
    }

    const now = this.now();

    // Respect per-source mesh TX spacing.
    const lastTx = manager.getLastMeshTxAt?.() ?? 0;
    if (now - lastTx < MIN_INTERVAL_BETWEEN_REQUESTS_MS) return;

    // Get room-sync-enabled nodes for this source.
    const dbNodes = await databaseService.meshcore.getRoomSyncEnabledNodes(sourceId);
    const roomNodes: RoomSyncNode[] = dbNodes
      .filter((n: any) => n.advType === 3)
      .map((n: any) => ({
        publicKey: n.publicKey,
        sourceId: n.sourceId ?? sourceId,
        roomSyncEnabled: true,
        roomSyncIntervalMinutes: n.roomSyncIntervalMinutes ?? 60,
        lastRoomSyncAt: n.lastRoomSyncAt ?? null,
      }));

    const target = pickMostOverdueRoom(roomNodes, now);
    if (!target) return;

    // Load saved credential for this room.
    const cred = await this.credentialStore.loadRoom(sourceId, target.publicKey);
    if (cred.kind !== 'ok') {
      logger.debug(
        `[RoomSyncScheduler] No usable credential for room ${target.publicKey.substring(0, 12)}… (${cred.kind}), skipping`,
      );
      return;
    }

    const shortKey = `${target.publicKey.substring(0, 12)}…`;
    logger.debug(`[RoomSyncScheduler] Syncing room ${shortKey} on source ${sourceId}`);

    try {
      const outcome = await manager.loginToRoomWithOutcome(target.publicKey, cred.password);

      // We transmitted either way — up to three login sends, each of which
      // floods when the room's path is unknown. Record it so the per-source
      // 60s TX floor applies to failures too.
      manager.recordMeshTx?.();

      if (outcome === 'ok') {
        await databaseService.meshcore.updateLastRoomSyncAt(sourceId, target.publicKey);
        await databaseService.meshcore.clearRoomSyncFailure(sourceId, target.publicKey);
        return;
      }

      // A refusal is the room server's final answer: this password will be
      // refused every time. Switch auto-sync off now rather than re-floods
      // that only add rejected-login entries to the operator's log.
      const disable = outcome === 'rejected';
      const failures = await databaseService.meshcore.recordRoomSyncFailure(
        sourceId,
        target.publicKey,
        outcome,
        { disable },
      );

      if (disable) {
        logger.warn(
          `[RoomSyncScheduler] Room ${shortKey} refused the saved password — auto-sync disabled. ` +
          'Forget the saved password (or log in again with the right one) to re-enable it.',
        );
        return;
      }

      // No reply. Ambiguous on a lossy link, so back off a full interval and
      // only give up once it has failed MAX_CONSECUTIVE_FAILURES times running.
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        await databaseService.meshcore.setRoomSyncConfig(sourceId, target.publicKey, {
          roomSyncEnabled: false,
        });
        logger.warn(
          `[RoomSyncScheduler] Room ${shortKey} failed ${failures} consecutive syncs — auto-sync disabled.`,
        );
        return;
      }

      logger.warn(
        `[RoomSyncScheduler] Login got no reply for room ${shortKey} ` +
        `(${failures}/${MAX_CONSECUTIVE_FAILURES}); next attempt in ${target.roomSyncIntervalMinutes}m`,
      );
    } catch (err) {
      logger.error(`[RoomSyncScheduler] Error syncing room ${shortKey}:`, err);
      // Count a thrown attempt as a failure too, so a room that reliably
      // explodes cannot sit at the head of the overdue queue for ever — and
      // hold it to the SAME threshold as an unanswered login. A JS-level throw
      // is not evidence about the password, but a room that throws on every
      // tick is not going to start working either, and letting the counter
      // climb for ever would keep paying the login cost indefinitely.
      try {
        const failures = await databaseService.meshcore.recordRoomSyncFailure(
          sourceId,
          target.publicKey,
          'no_reply',
          { disable: false },
        );
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          await databaseService.meshcore.setRoomSyncConfig(sourceId, target.publicKey, {
            roomSyncEnabled: false,
          });
          logger.warn(
            `[RoomSyncScheduler] Room ${shortKey} threw on ${failures} consecutive syncs — auto-sync disabled.`,
          );
        }
      } catch (recordErr) {
        logger.debug(`[RoomSyncScheduler] Could not record failure for ${shortKey}:`, recordErr);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let singleton: MeshCoreRoomSyncScheduler | null = null;

export function getMeshCoreRoomSyncScheduler(): MeshCoreRoomSyncScheduler | null {
  return singleton;
}

export function setMeshCoreRoomSyncScheduler(scheduler: MeshCoreRoomSyncScheduler | null): void {
  singleton = scheduler;
}
