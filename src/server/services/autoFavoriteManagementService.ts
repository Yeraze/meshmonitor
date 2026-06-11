/**
 * Automated Remote Favorites Management service + scheduler (issue #2608).
 *
 * Keeps the favorites list up to date on remote infrastructure nodes the user
 * administers via Remote Admin. Meshtastic gives zero-hop cost between favorited
 * routers, but only if the router's favorites are kept current — normally that
 * means a site visit or blind CLI spamming. This service automates it.
 *
 * Each enabled target (one config row per remote node) runs a "cycle" no more
 * often than its configured interval (default 24h). A cycle:
 *
 *   1. Optionally asks the target to broadcast NeighborInfo (so fresh adjacency
 *      data lands for a LATER cycle — firmware rate-limits responses to one per
 *      ~3 min, so we never block on it).
 *   2. Discovers candidate neighbors of the target from (a) stored NeighborInfo
 *      and (b) traceroutes that pass through the target.
 *   3. Filters candidates to the configured eligible roles, favorites up to
 *      `maxNewPerCycle` newly-seen neighbors via Remote Admin, and re-sends up
 *      to `maxRefavoritePerCycle` previously-assigned favorites (oldest first).
 *
 * IMPORTANT: Favorite assignment over LoRa is fire-and-forget — there is no ACK
 * that a favorite "stuck". The re-favorite pass exists to re-assert assignments
 * that may have been dropped. This is a heavy operation (multiple packets,
 * including a session-passkey handshake per remote node), so cycles are spaced
 * out and the per-cycle caps default to 1.
 *
 * Modeled on positionEstimationScheduler: a once-a-minute tick checks which
 * targets are due.
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { DEFAULT_ELIGIBLE_ROLES_JSON } from '../../db/schema/autoFavoriteTargets.js';
import { getRoutingErrorName } from '../constants/meshtastic.js';
import type { DbAutoFavoriteTarget, DbAutoFavoriteAssignment, DbTraceroute } from '../../db/types.js';

const CHECK_INTERVAL_MS = 60_000;
const BROADCAST_ADDR = 0xffffffff;
/** How many recent traceroutes to scan per target when discovering neighbors. */
const TRACEROUTE_SCAN_LIMIT = 200;

/** Result of a single set_favorite_node command + its routing ACK. */
export interface FavoriteAckResult {
  acked: boolean;
  errorReason: number | null;
  timedOut: boolean;
}

/** Structural view of the Meshtastic manager methods this service relies on. */
interface MeshtasticAdminManager extends ISourceManager {
  supportsFavorites(): boolean;
  sendFavoriteNodeAwaitAck(nodeNum: number, destinationNodeNum?: number, timeoutMs?: number): Promise<FavoriteAckResult>;
  sendNeighborInfoRequest(destination: number, channel?: number): Promise<{ packetId: number; requestId: number }>;
}

export interface CycleFavoriteOutcome {
  nodeNum: number;
  /** 'confirmed' | 'timeout' | routing error name (e.g. 'ADMIN_BAD_SESSION_KEY'). */
  ackStatus: string;
}

export interface CycleResult {
  /** True if the cycle actually executed (false = skipped, see reason). */
  ran: boolean;
  reason?: string;
  discoveredNeighbors: number;
  newlyFavorited: CycleFavoriteOutcome[];
  reFavorited: CycleFavoriteOutcome[];
}

// ============================== Pure helpers ==============================

/** A run is due if it never ran, or `intervalHours` have elapsed since lastRun. */
export function isCycleDue(lastRunMs: number | null | undefined, intervalHours: number, nowMs: number): boolean {
  if (lastRunMs == null) return true;
  return nowMs - lastRunMs >= intervalHours * 60 * 60 * 1000;
}

/** Parse the stored eligibleRoles JSON ("[2,11,12]") into a Set, defaulting safely. */
export function parseEligibleRoles(json: string | null | undefined): Set<number> {
  if (!json) return new Set(JSON.parse(DEFAULT_ELIGIBLE_ROLES_JSON));
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      const nums = parsed.map((n) => Number(n)).filter((n) => Number.isFinite(n));
      return new Set(nums);
    }
  } catch {
    // fall through to default
  }
  return new Set(JSON.parse(DEFAULT_ELIGIBLE_ROLES_JSON));
}

function isValidNeighbor(nodeNum: number, targetNodeNum: number): boolean {
  return (
    Number.isFinite(nodeNum) &&
    nodeNum > 0 &&
    nodeNum !== BROADCAST_ADDR &&
    nodeNum !== targetNodeNum
  );
}

/**
 * Find nodes directly adjacent to `targetNodeNum` in the hop paths of the given
 * traceroutes. A traceroute's full forward path is
 * [fromNodeNum, ...route, toNodeNum]; the back path is
 * [toNodeNum, ...routeBack, fromNodeNum]. Wherever the target appears, its
 * immediate predecessor and successor are its direct RF neighbors.
 *
 * Returns deduped nodeNums in the order first seen (callers pass traceroutes
 * most-recent-first, so recent observations rank higher).
 */
export function discoverTracerouteNeighbors(traceroutes: DbTraceroute[], targetNodeNum: number): number[] {
  const found: number[] = [];
  const seen = new Set<number>();

  const consider = (n: number) => {
    if (isValidNeighbor(n, targetNodeNum) && !seen.has(n)) {
      seen.add(n);
      found.push(n);
    }
  };

  const parseRoute = (raw: string | null | undefined): number[] => {
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map((n) => Number(n)) : [];
    } catch {
      return [];
    }
  };

  for (const tr of traceroutes) {
    const forward = [Number(tr.fromNodeNum), ...parseRoute(tr.route), Number(tr.toNodeNum)];
    const back = [Number(tr.toNodeNum), ...parseRoute(tr.routeBack), Number(tr.fromNodeNum)];
    for (const path of [forward, back]) {
      for (let i = 0; i < path.length; i++) {
        if (path[i] !== targetNodeNum) continue;
        if (i > 0) consider(path[i - 1]);
        if (i < path.length - 1) consider(path[i + 1]);
      }
    }
  }

  return found;
}

/**
 * Select up to `max` newly-seen candidates to favorite: not already assigned,
 * not excluded, and (when a role is known) in the eligible-role set. Candidates
 * with an unknown role are skipped — we can't confirm eligibility blindly.
 */
export function selectNewFavorites(params: {
  candidates: number[];
  assigned: Set<number>;
  excluded: Set<number>;
  eligibleRoles: Set<number>;
  roleByNode: Map<number, number | null | undefined>;
  max: number;
}): number[] {
  const { candidates, assigned, excluded, eligibleRoles, roleByNode, max } = params;
  const picked: number[] = [];
  for (const c of candidates) {
    if (picked.length >= max) break;
    if (assigned.has(c) || excluded.has(c)) continue;
    const role = roleByNode.get(c);
    if (role == null || !eligibleRoles.has(role)) continue;
    picked.push(c);
  }
  return picked;
}

/**
 * Pick up to `max` previously-assigned favorites to re-send. Un-confirmed
 * assignments (last command not ACKed: timed out, rejected, or never tracked)
 * are prioritized over confirmed ones, then oldest-re-sent-first within each
 * group — so a favorite whose ACK never came back gets re-asserted before one
 * the remote already confirmed.
 */
export function selectRefavorites(assignments: DbAutoFavoriteAssignment[], max: number): number[] {
  if (max <= 0) return [];
  const isConfirmed = (a: DbAutoFavoriteAssignment) => a.lastAckStatus === 'confirmed';
  const ordered = [...assignments].sort((a, b) => {
    const ca = isConfirmed(a) ? 1 : 0;
    const cb = isConfirmed(b) ? 1 : 0;
    if (ca !== cb) return ca - cb; // un-confirmed (0) first
    return a.lastAssignedAt - b.lastAssignedAt; // then oldest first
  });
  return ordered.slice(0, max).map((a) => a.favoriteNodeNum);
}

/** Map a favorite ACK result to a short status label stored in the ledger. */
export function ackStatusLabel(ack: FavoriteAckResult): string {
  if (ack.timedOut) return 'timeout';
  if (ack.acked) return 'confirmed';
  return getRoutingErrorName(ack.errorReason ?? -1);
}

// ============================== Scheduler ==============================

class AutoFavoriteManagementScheduler {
  private schedulerInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private inProgress = false;

  initialize(): void {
    this.start();
    logger.info('✅ Auto-favorite management scheduler initialized');
  }

  start(): void {
    if (this.isRunning) {
      logger.warn('⚠️ Auto-favorite management scheduler is already running');
      return;
    }
    this.isRunning = true;
    this.schedulerInterval = setInterval(() => {
      this.tick().catch((error) => {
        logger.error('❌ Error in auto-favorite management scheduler tick:', error);
      });
    }, CHECK_INTERVAL_MS);
    logger.info('▶️ Auto-favorite management scheduler started (checks every minute)');
  }

  stop(): void {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }
    this.isRunning = false;
    logger.info('⏹️ Auto-favorite management scheduler stopped');
  }

  /** Resolve a Meshtastic admin-capable, connected manager for a source. */
  private resolveManager(sourceId: string): MeshtasticAdminManager | null {
    const manager = sourceManagerRegistry.getManager(sourceId);
    if (!manager) return null;
    if (manager.sourceType !== 'meshtastic_tcp') return null;
    const candidate = manager as unknown as MeshtasticAdminManager;
    if (typeof candidate.supportsFavorites !== 'function' || typeof candidate.sendFavoriteNodeAwaitAck !== 'function') {
      return null;
    }
    return candidate;
  }

  /** Tick handler: run every enabled target whose cycle is due. */
  private async tick(): Promise<void> {
    if (this.inProgress) return;
    this.inProgress = true;
    try {
      const targets = await databaseService.autoFavoriteTargets.getEnabledTargets();
      if (targets.length === 0) return;
      const now = Date.now();
      for (const target of targets) {
        if (!isCycleDue(target.lastRunAt, target.intervalHours, now)) continue;
        try {
          await this.runCycleForTarget(target);
        } catch (error) {
          logger.error(`❌ Auto-favorite cycle failed for target ${target.targetNodeNum} (source ${target.sourceId}):`, error);
        }
      }
    } finally {
      this.inProgress = false;
    }
  }

  /**
   * Manually trigger one cycle for a target regardless of its schedule.
   * Returns a result summary even when skipped (for the run-now endpoint).
   */
  async runCycleNow(sourceId: string, targetNodeNum: number): Promise<CycleResult> {
    const target = await databaseService.autoFavoriteTargets.getTarget(sourceId, targetNodeNum);
    if (!target) {
      return { ran: false, reason: 'No auto-favorite config for this target', discoveredNeighbors: 0, newlyFavorited: [], reFavorited: [] };
    }
    return this.runCycleForTarget(target);
  }

  /** Execute one discovery/favorite cycle for a single target. */
  private async runCycleForTarget(target: DbAutoFavoriteTarget): Promise<CycleResult> {
    const { sourceId, targetNodeNum } = target;
    const result: CycleResult = { ran: false, discoveredNeighbors: 0, newlyFavorited: [], reFavorited: [] };

    const manager = this.resolveManager(sourceId);
    if (!manager) {
      result.reason = 'Source is not a connected Meshtastic node';
      return result;
    }
    if (!manager.getStatus().connected) {
      result.reason = 'Source not connected';
      return result;
    }
    if (!manager.supportsFavorites()) {
      result.reason = 'Local firmware does not support favorites (requires >= 2.7.0)';
      return result;
    }

    const now = Date.now();
    const targetNode = await databaseService.nodes.getNode(targetNodeNum, sourceId);
    const channel = targetNode?.channel ?? 0;

    // 1. Ask the target to broadcast NeighborInfo for a future cycle (best effort).
    if (target.useNeighborInfo) {
      try {
        await manager.sendNeighborInfoRequest(targetNodeNum, channel);
        await databaseService.autoFavoriteTargets.touchLastNeighborRequest(sourceId, targetNodeNum, now);
      } catch (error) {
        logger.warn(`⚠️ Auto-favorite: NeighborInfo request to ${targetNodeNum} failed:`, error);
      }
    }

    // 2. Discover candidate neighbors. NeighborInfo first (authoritative adjacency),
    //    then traceroute-derived neighbors. The local (controlling) node is a valid
    //    candidate — if it is a direct neighbor of the target it should be favorited
    //    too, preserving the zero-hop link back to us.
    const candidates: number[] = [];
    const seenCandidate = new Set<number>();
    const pushCandidate = (n: number) => {
      if (isValidNeighbor(n, targetNodeNum) && !seenCandidate.has(n)) {
        seenCandidate.add(n);
        candidates.push(n);
      }
    };

    if (target.useNeighborInfo) {
      const neighbors = await databaseService.neighbors.getNeighborsForNode(targetNodeNum, sourceId);
      for (const n of neighbors) pushCandidate(Number(n.neighborNodeNum));
    }
    if (target.useTraceroutes) {
      const traceroutes = await databaseService.traceroutes.getAllTraceroutes(TRACEROUTE_SCAN_LIMIT, sourceId);
      for (const n of discoverTracerouteNeighbors(traceroutes, targetNodeNum)) pushCandidate(n);
    }
    result.discoveredNeighbors = candidates.length;

    // 3a. Resolve roles for candidate filtering.
    const eligibleRoles = parseEligibleRoles(target.eligibleRoles);
    const roleByNode = new Map<number, number | null | undefined>();
    for (const c of candidates) {
      const node = await databaseService.nodes.getNode(c, sourceId);
      roleByNode.set(c, node?.role ?? null);
    }

    const assignments = await databaseService.autoFavoriteTargets.getAssignments(sourceId, targetNodeNum);
    const assigned = new Set(assignments.map((a) => a.favoriteNodeNum));

    const newFavorites = selectNewFavorites({
      candidates,
      assigned,
      // Only the target itself is excluded — a node cannot favorite itself. The
      // local node is intentionally eligible when it is a discovered neighbor.
      excluded: new Set([targetNodeNum]),
      eligibleRoles,
      roleByNode,
      max: target.maxNewPerCycle,
    });

    // 3b. Favorite newly-discovered eligible neighbors. The command is sent
    //     with want_response, so the remote returns a routing ACK we record.
    for (const fav of newFavorites) {
      try {
        const ack = await manager.sendFavoriteNodeAwaitAck(fav, targetNodeNum);
        const status = ackStatusLabel(ack);
        await databaseService.autoFavoriteTargets.recordAssignment(sourceId, targetNodeNum, fav, 'discovery', now, { status, at: now });
        result.newlyFavorited.push({ nodeNum: fav, ackStatus: status });
        logger.info(`⭐ Auto-favorite: assigned ${fav} on remote target ${targetNodeNum} (source ${sourceId}) — ack=${status}`);
      } catch (error) {
        logger.warn(`⚠️ Auto-favorite: failed to assign ${fav} on target ${targetNodeNum}:`, error);
      }
    }

    // 3c. Re-assert previously assigned favorites (un-confirmed first), recording
    //     each fresh ACK — re-favoriting is how we recover assignments whose
    //     command was dropped or whose ACK never arrived.
    const reFavorites = selectRefavorites(assignments, target.maxRefavoritePerCycle);
    for (const fav of reFavorites) {
      try {
        const ack = await manager.sendFavoriteNodeAwaitAck(fav, targetNodeNum);
        const status = ackStatusLabel(ack);
        await databaseService.autoFavoriteTargets.touchAssignment(sourceId, targetNodeNum, fav, now, { status, at: now });
        result.reFavorited.push({ nodeNum: fav, ackStatus: status });
        logger.info(`🔁 Auto-favorite: re-asserted ${fav} on remote target ${targetNodeNum} (source ${sourceId}) — ack=${status}`);
      } catch (error) {
        logger.warn(`⚠️ Auto-favorite: failed to re-assert ${fav} on target ${targetNodeNum}:`, error);
      }
    }

    await databaseService.autoFavoriteTargets.touchLastRun(sourceId, targetNodeNum, now);
    result.ran = true;
    return result;
  }
}

export const autoFavoriteManagementScheduler = new AutoFavoriteManagementScheduler();
