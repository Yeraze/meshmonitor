/**
 * Regression tests for the auto-ping ACK-matching + send-race fixes.
 *
 * These drive the REAL manager methods (handleAutoPingResponse / sendNextAutoPing),
 * unlike meshtasticManager.auto-ping.test.ts which re-implements the logic inline.
 *
 * Bug 1: a want_ack DM yields two Routing packets with the SAME request_id, both
 * error_reason=NONE, differing only by `from` — an implicit transmit ACK from our
 * OWN local node (first) and the real end-to-end ACK from the destination (second).
 * The matcher used to latch the transmit ACK and report a false success.
 *
 * Bug 2: sendNextAutoPing checked `pendingRequestId` then awaited the send before
 * setting it, so a second interval tick during the send could launch a duplicate.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetSettingForSource = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    settings: { getSettingForSource: mockGetSettingForSource, getSetting: vi.fn() },
    telemetry: { insertTelemetry: vi.fn() },
    nodes: { upsertNode: vi.fn().mockResolvedValue(undefined), getAllNodes: vi.fn().mockResolvedValue([]), getNode: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const LOCAL = 0x0a0a0a0a;     // our local node
const REQUESTER = 0x11111111; // the node that asked for pings (= the DM destination)
const RELAY = 0x99999999;     // some intermediate node
const REQ_ID = 4242;          // pending sent packet id

describe('MeshtasticManager - auto-ping ACK matching (request_id + from)', () => {
  let manager: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await import('./meshtasticManager.js');
    manager = module.fallbackManager;
    manager.localNodeInfo = { nodeNum: LOCAL };
    (manager as any).autoPingSessions.clear();
    vi.spyOn(manager as any, 'emitAutoPingUpdate').mockResolvedValue(undefined);
  });

  afterEach(() => {
    (manager as any).autoPingSessions.clear();
    vi.restoreAllMocks();
  });

  function makeSession(over: Record<string, unknown> = {}) {
    const session = {
      requestedBy: REQUESTER, channel: 0, totalPings: 3,
      completedPings: 0, successfulPings: 0, failedPings: 0,
      intervalMs: 30000, timeoutMs: 60000, timer: null, sending: false,
      pendingRequestId: REQ_ID, pendingTimeout: null,
      startTime: Date.now(), lastPingSentAt: Date.now(), results: [] as any[],
      ...over,
    };
    (manager as any).autoPingSessions.set(session.requestedBy, session);
    return session;
  }

  it('ignores the local transmit ACK (from == our node) and keeps the ping pending', () => {
    const s = makeSession();
    // error_reason=NONE from our OWN node = "transmitted to mesh", not delivery.
    manager.handleAutoPingResponse(REQ_ID, LOCAL, 0);
    expect(s.completedPings).toBe(0);
    expect(s.pendingRequestId).toBe(REQ_ID); // still waiting for the real ack
    expect(s.results).toHaveLength(0);
  });

  it('ignores a relay NONE (from an intermediate node, not the destination)', () => {
    const s = makeSession();
    manager.handleAutoPingResponse(REQ_ID, RELAY, 0);
    expect(s.completedPings).toBe(0);
    expect(s.pendingRequestId).toBe(REQ_ID);
  });

  it('records an ACK only on the destination end-to-end ack (from == requester)', () => {
    const s = makeSession();
    manager.handleAutoPingResponse(REQ_ID, REQUESTER, 0);
    expect(s.completedPings).toBe(1);
    expect(s.successfulPings).toBe(1);
    expect(s.failedPings).toBe(0);
    expect(s.pendingRequestId).toBeNull();
    expect(s.results[0].status).toBe('ack');
  });

  it('the transmit ACK then the destination ACK resolves exactly one successful ping', () => {
    const s = makeSession();
    manager.handleAutoPingResponse(REQ_ID, LOCAL, 0);     // self-transmit (ignored)
    manager.handleAutoPingResponse(REQ_ID, REQUESTER, 0); // real ack (counts)
    expect(s.completedPings).toBe(1);
    expect(s.successfulPings).toBe(1);
    expect(s.results).toHaveLength(1);
  });

  it('records a NAK on a non-zero error_reason (e.g. MAX_RETRANSMIT delivery failure)', () => {
    const s = makeSession();
    manager.handleAutoPingResponse(REQ_ID, LOCAL, 34 /* MAX_RETRANSMIT */);
    expect(s.completedPings).toBe(1);
    expect(s.failedPings).toBe(1);
    expect(s.successfulPings).toBe(0);
    expect(s.pendingRequestId).toBeNull();
    expect(s.results[0].status).toBe('nak');
  });

  it('clears the pending ack timeout when a ping resolves', () => {
    const fakeTimer = setTimeout(() => {}, 60000);
    const s = makeSession({ pendingTimeout: fakeTimer });
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    manager.handleAutoPingResponse(REQ_ID, REQUESTER, 0);
    expect(clearSpy).toHaveBeenCalledWith(fakeTimer);
    expect(s.pendingTimeout).toBeNull();
  });

  it('clears the pending ack timeout on a NAK too', () => {
    const fakeTimer = setTimeout(() => {}, 60000);
    const s = makeSession({ pendingTimeout: fakeTimer });
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    manager.handleAutoPingResponse(REQ_ID, LOCAL, 34 /* MAX_RETRANSMIT */);
    expect(clearSpy).toHaveBeenCalledWith(fakeTimer);
    expect(s.pendingTimeout).toBeNull();
    expect(s.results[0].status).toBe('nak');
  });

  it('does not match a different request_id', () => {
    const s = makeSession();
    manager.handleAutoPingResponse(9999, REQUESTER, 0);
    expect(s.completedPings).toBe(0);
    expect(s.pendingRequestId).toBe(REQ_ID);
  });
});

describe('MeshtasticManager - auto-ping send race', () => {
  let manager: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await import('./meshtasticManager.js');
    manager = module.fallbackManager;
    manager.localNodeInfo = { nodeNum: LOCAL };
    (manager as any).autoPingSessions.clear();
    (manager as any).messageQueue = { recordExternalSend: vi.fn(), handleAck: vi.fn() };
    vi.spyOn(manager as any, 'emitAutoPingUpdate').mockResolvedValue(undefined);
  });

  afterEach(() => {
    (manager as any).autoPingSessions.clear();
    vi.restoreAllMocks();
  });

  it('does not launch a duplicate ping when a tick fires during an in-flight send', async () => {
    const session = {
      requestedBy: REQUESTER, channel: 0, totalPings: 3,
      completedPings: 0, successfulPings: 0, failedPings: 0,
      intervalMs: 30000, timeoutMs: 60000, timer: null, sending: false,
      pendingRequestId: null as number | null, pendingTimeout: null as any,
      startTime: Date.now(), lastPingSentAt: 0, results: [] as any[],
    };
    (manager as any).autoPingSessions.set(REQUESTER, session);

    // Make the send hang so a second tick lands mid-send.
    let resolveSend: (id: number) => void = () => {};
    const sendSpy = vi.spyOn(manager, 'sendTextMessage')
      .mockImplementation(() => new Promise<number>((r) => { resolveSend = r; }));

    const p1 = (manager as any).sendNextAutoPing(session); // starts send, sets sending=true
    (manager as any).sendNextAutoPing(session);            // second tick — must be guarded

    expect(sendSpy).toHaveBeenCalledTimes(1);

    resolveSend(REQ_ID);
    await p1;

    expect(session.pendingRequestId).toBe(REQ_ID);
    expect(session.sending).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(1);

    if (session.pendingTimeout) clearTimeout(session.pendingTimeout); // avoid leaking the 60s timer
  });
});
