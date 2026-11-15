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
 *
 * Blank-password re-join (#6408). A room server keeps an ACL of clients that
 * logged in before, and a blank-password login from a key in that ACL gets
 * back in with its old permission. So once a room login from this source has
 * succeeded (`lastRoomLoginOkAt`, migration 237 — no secret stored):
 *   - With no saved password, the scheduler logs in with a blank one.
 *   - After the source connects (startup or reconnect), each such room gets
 *     ONE re-join on the normal tick, still at most one login per source per
 *     60s — unless something logged in to it within the last hour, judged
 *     from the persisted timestamps, so a restart is never itself a trigger.
 *   - Failures follow the rules above: a refusal disables auto-sync, silence
 *     counts towards MAX_CONSECUTIVE_FAILURES.
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

/**
 * Re-join on connect (#6408): a room is not re-joined on startup / source
 * connect when the last login to it — attempt or success, both PERSISTED —
 * was within this window. That is what keeps a restart from ever being a
 * trigger on its own: a container that restarts every few minutes sends at
 * most one re-join per room per hour, because every attempt stamps
 * `lastRoomSyncAt` in the database.
 */
export const STARTUP_REJOIN_QUIET_MS = 60 * 60_000;

interface RoomSyncNode {
  publicKey: string;
  sourceId: string;
  roomSyncEnabled: boolean;
  roomSyncIntervalMinutes: number;
  lastRoomSyncAt: number | null;
  /** Last SUCCESSFUL login from this source (#6408). Non-null = joined: the
   *  room's ACL holds our key, so a blank-password login gets back in. */
  lastRoomLoginOkAt?: number | null;
}

/** Most recent persisted login to the room: a scheduled attempt or any success. */
function lastLoginAt(node: RoomSyncNode): number {
  return Math.max(node.lastRoomSyncAt ?? 0, node.lastRoomLoginOkAt ?? 0);
}

export function isRoomSyncEligible(node: RoomSyncNode, now: number): boolean {
  if (!node.roomSyncEnabled) return false;
  const interval = node.roomSyncIntervalMinutes;
  if (interval === null || interval === undefined || interval < 60) return false;
  // An interactive login counts too: re-logging in minutes after the user did
  // only spends airtime.
  return (now - lastLoginAt(node)) >= interval * 60_000;
}

/**
 * May this room be re-joined now that the source has (re)connected? Only
 * rooms this source has joined before, and only when nothing logged in to it
 * within STARTUP_REJOIN_QUIET_MS.
 */
export function isStartupRejoinEligible(node: RoomSyncNode, now: number): boolean {
  if (!node.roomSyncEnabled) return false;
  if (node.lastRoomLoginOkAt === null || node.lastRoomLoginOkAt === undefined) return false;
  return (now - lastLoginAt(node)) >= STARTUP_REJOIN_QUIET_MS;
}

/**
 * Rooms due for a login, most overdue first. `startupPending` holds the keys
 * still owed their one re-join since the source connected; those are due on
 * the startup rule as well as their interval.
 */
export function rankRoomsForSync(
  nodes: RoomSyncNode[],
  now: number,
  startupPending?: ReadonlySet<string>,
): RoomSyncNode[] {
  const eligible = nodes.filter(n =>
    isRoomSyncEligible(n, now) ||
    (startupPending?.has(n.publicKey) === true && isStartupRejoinEligible(n, now)));
  eligible.sort((a, b) => {
    const aOver = now - lastLoginAt(a);
    const bOver = now - lastLoginAt(b);
    if (aOver !== bOver) return bOver - aOver;
    return a.publicKey.localeCompare(b.publicKey);
  });
  return eligible;
}

export function pickMostOverdueRoom(
  nodes: RoomSyncNode[],
  now: number,
  startupPending?: ReadonlySet<string>,
): RoomSyncNode | undefined {
  return rankRoomsForSync(nodes, now, startupPending)[0];
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
  /**
   * Per source: room keys whose one re-join since the source connected is
   * settled — tried, or ruled out (not joined, or logged in within the last
   * hour). Cleared when the source is seen disconnected, so a reconnect earns
   * one more try. Being in-memory is safe: whether a try is ALLOWED comes from
   * the persisted timestamps (STARTUP_REJOIN_QUIET_MS), never from this set.
   */
  private readonly rejoinSettled = new Map<string, Set<string>>();

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
        if (!manager.isConnected()) {
          this.rejoinSettled.delete(manager.sourceId);
          continue;
        }
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
        lastRoomLoginOkAt: n.lastRoomLoginOkAt ?? null,
      }));

    // Re-join on connect (#6408): each room gets ONE try per connection, and
    // only when the persisted timestamps allow it. A room ruled out now (not
    // joined, or logged in within the hour) is settled for this connection,
    // so the restart itself never becomes the trigger later on.
    let settled = this.rejoinSettled.get(sourceId);
    if (!settled) {
      settled = new Set();
      this.rejoinSettled.set(sourceId, settled);
    }
    const startupPending = new Set<string>();
    for (const room of roomNodes) {
      if (settled.has(room.publicKey)) continue;
      if (isStartupRejoinEligible(room, now)) startupPending.add(room.publicKey);
      else settled.add(room.publicKey);
    }

    // The most overdue room we can actually log in to: a saved password, or a
    // blank-password ACL login for a room this source has joined (#6408). A
    // room with neither is skipped rather than allowed to block the rest.
    let target: RoomSyncNode | undefined;
    let password = '';
    for (const room of rankRoomsForSync(roomNodes, now, startupPending)) {
      const cred = await this.credentialStore.loadRoom(sourceId, room.publicKey);
      if (cred.kind === 'ok') {
        target = room;
        password = cred.password;
        break;
      }
      if (room.lastRoomLoginOkAt !== null && room.lastRoomLoginOkAt !== undefined) {
        target = room;
        password = '';
        break;
      }
      logger.debug(
        `[RoomSyncScheduler] No usable credential for room ${room.publicKey.substring(0, 12)}… (${cred.kind}) ` +
        'and never joined from this source, skipping',
      );
    }
    if (!target) return;
    settled.add(target.publicKey);
    const blank = password === '';

    const shortKey = `${target.publicKey.substring(0, 12)}…`;
    logger.debug(
      `[RoomSyncScheduler] Syncing room ${shortKey} on source ${sourceId}` +
      (blank ? ' (blank-password ACL re-join)' : ''),
    );

    try {
      const outcome = await manager.loginToRoomWithOutcome(target.publicKey, password);

      // We transmitted either way — up to three login sends, each of which
      // floods when the room's path is unknown. Record it so the per-source
      // 60s TX floor applies to failures too.
      manager.recordMeshTx?.();

      if (outcome === 'ok') {
        // Both writes are attempted regardless: if stamping the timestamp
        // throws, a sequential await would skip the clear and leave a stale
        // failure count sitting against a room that is demonstrably working.
        const settled = await Promise.allSettled([
          databaseService.meshcore.updateLastRoomSyncAt(sourceId, target.publicKey),
          databaseService.meshcore.clearRoomSyncFailure(sourceId, target.publicKey),
        ]);
        for (const result of settled) {
          if (result.status === 'rejected') {
            logger.warn(`[RoomSyncScheduler] Room ${shortKey} synced but state update failed:`, result.reason);
          }
        }
        return;
      }

      // A refusal is the room server's final answer: this password will be
      // refused every time. Switch auto-sync off now rather than re-floods
      // that only add rejected-login entries to the operator's log.
      const disable = outcome === 'rejected';
      if (outcome === 'not_on_device') {
        logger.warn(
          `[RoomSyncScheduler] Room ${shortKey} is not in the radio's contact list — login not sent (#5349).`,
        );
      }
      const failures = await databaseService.meshcore.recordRoomSyncFailure(
        sourceId,
        target.publicKey,
        // The failure column only knows rejected / no_reply. "Not on the
        // device" still counts towards auto-disable so it cannot retry for
        // ever (#5036), recorded as no_reply.
        // `cancelled` needs an AbortSignal, which the scheduler never passes
        // (#5400); should one appear, it still counts, so it cannot dodge the
        // #5036 threshold.
        outcome === 'not_on_device' || outcome === 'cancelled' ? 'no_reply' : outcome,
        { disable },
      );

      if (disable) {
        logger.warn(
          blank
            ? `[RoomSyncScheduler] Room ${shortKey} refused the blank-password re-join (it may have cleared ` +
              'its member list or changed its password) — auto-sync disabled. Log in again with the password to re-enable it.'
            : `[RoomSyncScheduler] Room ${shortKey} refused the saved password — auto-sync disabled. ` +
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
