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
 */
import { logger } from '../../utils/logger.js';
import type { MeshCoreManager } from '../meshcoreManager.js';
import type { MeshCoreManagerRegistry } from '../meshcoreRegistry.js';
import type { MeshCoreCredentialStore } from './meshcoreCredentialStore.js';
import databaseService from '../../services/database.js';

const MIN_INTERVAL_BETWEEN_REQUESTS_MS = 60_000;
const DEFAULT_TICK_MS = 60_000;

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
  registry: MeshCoreManagerRegistry;
  credentialStore: MeshCoreCredentialStore;
  tickMs?: number;
  now?: () => number;
}

export class MeshCoreRoomSyncScheduler {
  private readonly registry: MeshCoreManagerRegistry;
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
      const managers = this.registry.list();
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

    logger.debug(
      `[RoomSyncScheduler] Syncing room ${target.publicKey.substring(0, 12)}… on source ${sourceId}`,
    );

    try {
      const ok = await manager.loginToRoom(target.publicKey, cred.password);
      if (ok) {
        await databaseService.meshcore.updateLastRoomSyncAt(sourceId, target.publicKey);
        manager.recordMeshTx?.();
      } else {
        logger.warn(`[RoomSyncScheduler] Login failed for room ${target.publicKey.substring(0, 12)}…`);
      }
    } catch (err) {
      logger.error(`[RoomSyncScheduler] Error syncing room ${target.publicKey.substring(0, 12)}…:`, err);
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
