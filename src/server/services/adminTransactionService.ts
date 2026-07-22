/**
 * Admin-command ACK correlation (#3962 Phase 4.2a PR4 §4d).
 *
 * Extracted from MeshtasticManager: sending an admin command (fire-and-forget
 * or await-ack), and resolving a pending waiter from the inbound Routing ACK
 * that `processRoutingErrorMessage` (protobuf dispatch, stays on the manager)
 * receives for it.
 *
 * The correlation map (`pendingAdminAcks`) is written by the two outbound
 * senders here and read by the inbound dispatch path on the *opposite side*
 * of `meshtasticManager.ts`. That inbound side stays on the manager (out of
 * scope per spec §10 — protobuf dispatch), so it reaches back into this
 * service through the injected reference the manager holds
 * (`this.adminTransactionService.hasPending(...)` /
 * `.resolveByRequestId(...)`) instead of touching the map directly. This is
 * the mirror image of the outbound→inbound dependency `nodeDbMaintenanceService`
 * and `autoAnnounceService` have with the manager: there, the *service* calls
 * back into the manager; here, the *manager's* dispatch code calls into the
 * service.
 *
 * `resolveByRequestId` takes `fromNum` in addition to spec §4d's suggested
 * `(requestId, errorReason)` signature — the original `tryResolveAdminAck`
 * needs it to distinguish the destination node's ACK from an intermediate
 * hop's "delivered to mesh" ACK (see its doc comment below). `hasPending` is
 * a new, narrow membership check that lets the manager's dispatch code keep
 * its existing `if (requestId && <pending>) { if (<resolve>) return; }` shape
 * without exposing the map itself.
 *
 * Import-cycle discipline (task42a_spec.md §3): constructor-injected
 * `import type` reference to MeshtasticManager, never a static value import.
 * `isConnected`/`transport`/`localNodeInfo` are `private` on MeshtasticManager;
 * this service reuses the narrow accessors already added for
 * `nodeDbMaintenanceService.ts` (`isTransportReady()`, `getLocalNodeInfo()`,
 * `sendLocalAdminPacket()` — the latter performs the exact same
 * connected+transport guard and `transport.send()` call that both admin
 * senders below need after building their packet) plus one new one added
 * alongside this service: `logOutgoingPacket()` was widened from `private` to
 * (default) public — same pattern as `sendWantConfigId()` — because it is
 * general manager infrastructure (called from many other unmoved sites too),
 * not admin-ack-specific state to bridge narrowly.
 */
import type { MeshtasticManager } from '../meshtasticManager.js';
import protobufService from '../protobufService.js';
import { logger } from '../../utils/logger.js';

interface PendingAdminAck {
  dest: number;
  resolve: (errorReason: number | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AdminTransactionService {
  // Pending admin-command ACK waiters, keyed by the sent packet id. Resolved
  // by the manager's `processRoutingErrorMessage` (via `resolveByRequestId`)
  // when the destination node returns its want_response Routing ACK
  // (error_reason) — or on a routing error / timeout.
  // (issue #2608 follow-up: confirm remote favorite assignment.)
  private pendingAdminAcks: Map<number, PendingAdminAck> = new Map();

  constructor(private readonly mgr: MeshtasticManager) {}

  /**
   * Send an admin command to a node (local or remote)
   * The admin message should already be built with session passkey if needed
   * @param adminMessagePayload The encoded admin message (should already include session passkey for remote nodes)
   * @param destinationNodeNum Destination node number (0 or local node num for local, other for remote)
   * @returns Promise that resolves when command is sent
   */
  async sendAdminCommand(adminMessagePayload: Uint8Array, destinationNodeNum: number): Promise<void> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    const localNodeInfo = this.mgr.getLocalNodeInfo();
    if (!localNodeInfo?.nodeNum) {
      throw new Error('Local node information not available');
    }

    const localNodeNum = localNodeInfo.nodeNum;

    try {
      const adminPacket = protobufService.createAdminPacket(
        adminMessagePayload,
        destinationNodeNum,
        localNodeNum
      );

      await this.mgr.sendLocalAdminPacket(adminPacket);
      logger.debug(`✅ Sent admin command to node ${destinationNodeNum}`);

      // Log outgoing admin command to packet monitor (ONLY for remote admin)
      // Skip logging for local admin (destination == localNodeNum)
      if (destinationNodeNum !== localNodeNum) {
        await this.mgr.logOutgoingPacket(
          6, // ADMIN_APP
          destinationNodeNum,
          0, // Admin uses channel 0
          `Remote Admin to !${destinationNodeNum.toString(16).padStart(8, '0')}`,
          { destinationNodeNum, isRemoteAdmin: true }
        );
      }
    } catch (error) {
      logger.error(`❌ Error sending admin command to node ${destinationNodeNum}:`, error);
      throw error;
    }
  }

  /**
   * Membership check for the manager's inbound dispatch path
   * (`processRoutingErrorMessage`) — lets it guard the `resolveByRequestId`
   * call without reaching into the map directly.
   */
  hasPending(requestId: number): boolean {
    return this.pendingAdminAcks.has(requestId);
  }

  /**
   * Resolve a pending admin-ACK waiter from an inbound Routing packet.
   * Returns true if the packet was consumed (so normal routing handling is
   * skipped), false to let it continue.
   *
   * Semantics mirror message delivery: a routing error (errorReason !== 0)
   * settles as failure; an error_reason=NONE ACK from the destination node
   * settles as success; an error_reason=NONE ACK from our own radio means
   * "transmitted to mesh" — consumed, but we keep waiting for the remote's ACK.
   */
  resolveByRequestId(requestId: number, fromNum: number, errorReason: number): boolean {
    const waiter = this.pendingAdminAcks.get(requestId);
    if (!waiter) return false;

    if (errorReason !== 0) {
      this.settleAdminAck(requestId, errorReason);
      return true;
    }
    if (fromNum === waiter.dest) {
      // The destination node processed the admin command and ACKed it.
      this.settleAdminAck(requestId, 0);
      return true;
    }
    // error_reason=NONE from our own radio / an intermediate hop: the
    // "delivered to mesh" ack, not proof the remote processed it. Consume it
    // (admin packets aren't messages) but keep the waiter alive.
    return true;
  }

  /** Settle and clean up a pending admin-ACK waiter. */
  private settleAdminAck(requestId: number, errorReason: number | null): void {
    const waiter = this.pendingAdminAcks.get(requestId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.pendingAdminAcks.delete(requestId);
    waiter.resolve(errorReason);
  }

  /**
   * Send an admin command and wait for the destination node's routing ACK.
   * `acked` is true only on error_reason=NONE from the destination; `errorReason`
   * carries the routing error on rejection (e.g. ADMIN_BAD_SESSION_KEY);
   * `timedOut` is true if no ACK arrived within timeoutMs.
   */
  async sendAdminCommandAwaitAck(
    adminMessagePayload: Uint8Array,
    destinationNodeNum: number,
    timeoutMs: number = 30000
  ): Promise<{ packetId: number; acked: boolean; errorReason: number | null; timedOut: boolean }> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }
    const localNodeInfo = this.mgr.getLocalNodeInfo();
    if (!localNodeInfo?.nodeNum) {
      throw new Error('Local node information not available');
    }
    const localNodeNum = localNodeInfo.nodeNum;

    const { data: adminPacket, packetId } = protobufService.createAdminPacketWithId(
      adminMessagePayload,
      destinationNodeNum,
      localNodeNum
    );

    // Register the waiter BEFORE sending so a fast ACK can't be missed.
    const ackPromise = new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAdminAcks.delete(packetId);
        resolve(null);
      }, timeoutMs);
      this.pendingAdminAcks.set(packetId, { dest: destinationNodeNum, resolve, timer });
    });

    try {
      await this.mgr.sendLocalAdminPacket(adminPacket);
      logger.debug(`✅ Sent admin command (await ack) to node ${destinationNodeNum}, packetId ${packetId}`);
      if (destinationNodeNum !== localNodeNum) {
        await this.mgr.logOutgoingPacket(
          6, // ADMIN_APP
          destinationNodeNum,
          0,
          `Remote Admin to !${destinationNodeNum.toString(16).padStart(8, '0')}`,
          { destinationNodeNum, isRemoteAdmin: true, packetId }
        );
      }
    } catch (error) {
      this.settleAdminAck(packetId, null);
      logger.error(`❌ Error sending admin command to node ${destinationNodeNum}:`, error);
      throw error;
    }

    const errorReason = await ackPromise;
    if (errorReason === null) {
      return { packetId, acked: false, errorReason: null, timedOut: true };
    }
    return { packetId, acked: errorReason === 0, errorReason, timedOut: false };
  }
}
