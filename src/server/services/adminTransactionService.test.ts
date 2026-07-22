/**
 * Tests for admin-command ACK correlation (#3962 Phase 4.2a PR4 §4d).
 *
 * `AdminTransactionService` is tested against a minimal fake implementing
 * only the narrow public surface it depends on (mirrors the real
 * MeshtasticManager accessors: `isTransportReady`/`getLocalNodeInfo`/
 * `sendLocalAdminPacket`/`logOutgoingPacket` — the same accessor style used
 * by `nodeDbMaintenanceService.test.ts`).
 *
 * Invariant I5 (task42a_spec.md §5): exact timeout duration, resolve-value
 * semantics (`errorReason` number-or-null), and map cleanup on both the
 * resolve and timeout paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const createAdminPacket = vi.fn();
const createAdminPacketWithId = vi.fn();

vi.mock('../protobufService.js', () => ({
  default: {
    createAdminPacket: (...args: unknown[]) => createAdminPacket(...args),
    createAdminPacketWithId: (...args: unknown[]) => createAdminPacketWithId(...args),
  },
}));

import { AdminTransactionService } from './adminTransactionService.js';

/** Minimal fake implementing only what AdminTransactionService touches. */
function makeFakeManager(overrides: Partial<{
  transportReady: boolean;
  localNodeInfo: { nodeNum: number } | null;
}> = {}) {
  const state = {
    transportReady: overrides.transportReady ?? true,
    localNodeInfo: overrides.localNodeInfo === undefined ? { nodeNum: 111 } : overrides.localNodeInfo,
  };
  return {
    state,
    isTransportReady: vi.fn(() => state.transportReady),
    getLocalNodeInfo: vi.fn(() => state.localNodeInfo),
    sendLocalAdminPacket: vi.fn().mockResolvedValue(undefined),
    logOutgoingPacket: vi.fn().mockResolvedValue(undefined),
  };
}

describe('AdminTransactionService', () => {
  beforeEach(() => {
    createAdminPacket.mockReset().mockReturnValue(new Uint8Array([1]));
    createAdminPacketWithId.mockReset();
  });

  describe('sendAdminCommand', () => {
    it('throws without building/sending anything when the transport is not ready', async () => {
      const mgr = makeFakeManager({ transportReady: false });
      const svc = new AdminTransactionService(mgr as any);

      await expect(svc.sendAdminCommand(new Uint8Array([1]), 222)).rejects.toThrow('Not connected to Meshtastic node');
      expect(createAdminPacket).not.toHaveBeenCalled();
      expect(mgr.sendLocalAdminPacket).not.toHaveBeenCalled();
    });

    it('throws when local node info is unavailable', async () => {
      const mgr = makeFakeManager({ localNodeInfo: null });
      const svc = new AdminTransactionService(mgr as any);

      await expect(svc.sendAdminCommand(new Uint8Array([1]), 222)).rejects.toThrow('Local node information not available');
    });

    it('builds and sends the packet, logging outgoing traffic only for remote destinations', async () => {
      const mgr = makeFakeManager();
      const svc = new AdminTransactionService(mgr as any);

      await svc.sendAdminCommand(new Uint8Array([9]), 222);
      expect(createAdminPacket).toHaveBeenCalledWith(expect.any(Uint8Array), 222, 111);
      expect(mgr.sendLocalAdminPacket).toHaveBeenCalledWith(expect.any(Uint8Array));
      expect(mgr.logOutgoingPacket).toHaveBeenCalledWith(
        6, 222, 0, expect.any(String), { destinationNodeNum: 222, isRemoteAdmin: true },
      );
    });

    it('skips outgoing-packet logging for local (destination === localNodeNum) admin commands', async () => {
      const mgr = makeFakeManager();
      const svc = new AdminTransactionService(mgr as any);

      await svc.sendAdminCommand(new Uint8Array([9]), 111);
      expect(mgr.logOutgoingPacket).not.toHaveBeenCalled();
    });
  });

  describe('sendAdminCommandAwaitAck — timeout semantics (I5)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('times out after EXACTLY the requested duration and cleans the pending map', async () => {
      createAdminPacketWithId.mockReturnValue({ data: new Uint8Array([1]), packetId: 555 });
      const mgr = makeFakeManager();
      const svc = new AdminTransactionService(mgr as any);

      const promise = svc.sendAdminCommandAwaitAck(new Uint8Array([1]), 222, 5000);

      // Not yet — one tick short of the timeout.
      await vi.advanceTimersByTimeAsync(4999);
      expect(svc.hasPending(555)).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
      const result = await promise;

      expect(result).toEqual({ packetId: 555, acked: false, errorReason: null, timedOut: true });
      // Map cleaned on the timeout path.
      expect(svc.hasPending(555)).toBe(false);
    });

    it('defaults the timeout to 30000ms when not specified', async () => {
      createAdminPacketWithId.mockReturnValue({ data: new Uint8Array([1]), packetId: 556 });
      const mgr = makeFakeManager();
      const svc = new AdminTransactionService(mgr as any);

      const promise = svc.sendAdminCommandAwaitAck(new Uint8Array([1]), 222);
      await vi.advanceTimersByTimeAsync(29999);
      expect(svc.hasPending(556)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      const result = await promise;
      expect(result.timedOut).toBe(true);
    });

    it('registers the waiter BEFORE sending so a synchronous resolve cannot be missed', async () => {
      createAdminPacketWithId.mockReturnValue({ data: new Uint8Array([1]), packetId: 557 });
      const mgr = makeFakeManager();
      const svc = new AdminTransactionService(mgr as any);
      // Resolve the ack the instant sendLocalAdminPacket is invoked, simulating
      // a same-tick inbound ACK racing the send.
      mgr.sendLocalAdminPacket.mockImplementation(async () => {
        expect(svc.hasPending(557)).toBe(true);
        svc.resolveByRequestId(557, 222, 0);
      });

      const result = await svc.sendAdminCommandAwaitAck(new Uint8Array([1]), 222, 5000);
      expect(result).toEqual({ packetId: 557, acked: true, errorReason: 0, timedOut: false });
    });
  });

  describe('resolveByRequestId / hasPending — resolve-value semantics (I5)', () => {
    it('resolves acked=true, errorReason=0 on a NONE ack from the destination node, and cleans the map', async () => {
      createAdminPacketWithId.mockReturnValue({ data: new Uint8Array([1]), packetId: 600 });
      const mgr = makeFakeManager();
      const svc = new AdminTransactionService(mgr as any);

      const promise = svc.sendAdminCommandAwaitAck(new Uint8Array([1]), 222, 5000);
      expect(svc.hasPending(600)).toBe(true);

      const consumed = svc.resolveByRequestId(600, 222, 0);
      expect(consumed).toBe(true);
      expect(svc.hasPending(600)).toBe(false);

      const result = await promise;
      expect(result).toEqual({ packetId: 600, acked: true, errorReason: 0, timedOut: false });
    });

    it('resolves acked=false with the numeric errorReason on a routing error, and cleans the map', async () => {
      createAdminPacketWithId.mockReturnValue({ data: new Uint8Array([1]), packetId: 601 });
      const mgr = makeFakeManager();
      const svc = new AdminTransactionService(mgr as any);

      const promise = svc.sendAdminCommandAwaitAck(new Uint8Array([1]), 222, 5000);
      const consumed = svc.resolveByRequestId(601, 999, 32); // e.g. ADMIN_BAD_SESSION_KEY
      expect(consumed).toBe(true);
      expect(svc.hasPending(601)).toBe(false);

      const result = await promise;
      expect(result).toEqual({ packetId: 601, acked: false, errorReason: 32, timedOut: false });
    });

    it('consumes (returns true) but keeps the waiter alive for a NONE ack from an intermediate hop / our own radio', async () => {
      createAdminPacketWithId.mockReturnValue({ data: new Uint8Array([1]), packetId: 602 });
      const mgr = makeFakeManager();
      const svc = new AdminTransactionService(mgr as any);

      svc.sendAdminCommandAwaitAck(new Uint8Array([1]), 222, 5000);
      // fromNum (333) !== waiter.dest (222): "delivered to mesh", not the
      // destination's ACK — consumed but the waiter must stay pending.
      const consumed = svc.resolveByRequestId(602, 333, 0);
      expect(consumed).toBe(true);
      expect(svc.hasPending(602)).toBe(true);
    });

    it('returns false (not consumed) and is a no-op for an unknown requestId', () => {
      const mgr = makeFakeManager();
      const svc = new AdminTransactionService(mgr as any);
      expect(svc.hasPending(9999)).toBe(false);
      expect(svc.resolveByRequestId(9999, 1, 0)).toBe(false);
    });

    it('double-settle is safe: a second resolve/timeout after the first is a no-op', async () => {
      vi.useFakeTimers();
      createAdminPacketWithId.mockReturnValue({ data: new Uint8Array([1]), packetId: 603 });
      const mgr = makeFakeManager();
      const svc = new AdminTransactionService(mgr as any);

      const promise = svc.sendAdminCommandAwaitAck(new Uint8Array([1]), 222, 5000);
      expect(svc.resolveByRequestId(603, 222, 0)).toBe(true);
      // Second resolve attempt for the same (now-cleaned) requestId: no waiter found.
      expect(svc.resolveByRequestId(603, 222, 0)).toBe(false);

      // Advancing past the original timeout must not throw or double-resolve.
      await vi.advanceTimersByTimeAsync(6000);
      const result = await promise;
      expect(result).toEqual({ packetId: 603, acked: true, errorReason: 0, timedOut: false });
      vi.useRealTimers();
    });
  });

  describe('concurrent acks are keyed independently', () => {
    it('resolving one packetId does not affect another pending waiter', async () => {
      let nextId = 700;
      createAdminPacketWithId.mockImplementation(() => ({ data: new Uint8Array([1]), packetId: nextId++ }));
      const mgr = makeFakeManager();
      const svc = new AdminTransactionService(mgr as any);

      const p1 = svc.sendAdminCommandAwaitAck(new Uint8Array([1]), 222, 5000); // packetId 700
      const p2 = svc.sendAdminCommandAwaitAck(new Uint8Array([1]), 333, 5000); // packetId 701

      expect(svc.hasPending(700)).toBe(true);
      expect(svc.hasPending(701)).toBe(true);

      svc.resolveByRequestId(700, 222, 0);
      expect(svc.hasPending(700)).toBe(false);
      expect(svc.hasPending(701)).toBe(true); // untouched

      svc.resolveByRequestId(701, 333, 7);
      expect(svc.hasPending(701)).toBe(false);

      await expect(p1).resolves.toEqual({ packetId: 700, acked: true, errorReason: 0, timedOut: false });
      await expect(p2).resolves.toEqual({ packetId: 701, acked: false, errorReason: 7, timedOut: false });
    });
  });
});
