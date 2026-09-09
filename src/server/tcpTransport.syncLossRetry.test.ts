/**
 * Fast-retry ramp after a mid-config-sync disconnect (#5122).
 *
 * With #5130/#5138/#5140 in place the reporter's mesh recovers on its own, but
 * slowly: the link dies ~11s into a ~190-node NodeDB dump, MeshMonitor waits
 * the full `MESHTASTIC_RECONNECT_INITIAL_DELAY_MS` (60s by default), and the
 * retry then completes the entire sync in about 2 seconds. Almost the whole
 * ~70s outage is the wait, not the fault.
 *
 * Retrying fast forever would be the wrong trade, because every reconnect makes
 * the node re-dump its whole NodeDB — the exact work that is stalling. So the
 * delay ramps across consecutive mid-sync losses and then hands back to the
 * ordinary backoff.
 *
 * These tests drive `scheduleReconnect` directly and read the delay off the
 * scheduled timer, because the delay IS the behaviour under test — asserting
 * that some reconnect eventually happens would pass just as well before this
 * change.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TcpTransport } from './tcpTransport.js';

describe('TcpTransport — mid-sync fast-retry ramp (#5122)', () => {
  let transport: any;
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

  /** Delays, in ms, of every reconnect scheduled so far. */
  const scheduledDelays = (): number[] =>
    setTimeoutSpy.mock.calls.map((c) => c[1] as number);

  beforeEach(() => {
    vi.useFakeTimers();
    transport = new TcpTransport();
    transport.config = { host: 'node.example', port: 4403 };
    transport.shouldReconnect = true;
    // The default the reporter is running: one minute, flat.
    transport.setReconnectTiming(60_000, 60_000);
    setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits the full backoff when the sync was not the thing that broke', () => {
    // The control. An ordinary disconnect — an unreachable node, a network
    // blip — is not evidence that a quick retry will do any good, so it keeps
    // the configured backoff. Without this, the ramp would turn every startup
    // against a powered-off node into a SYN every three seconds.
    transport.scheduleReconnect();

    expect(scheduledDelays()).toEqual([60_000]);
  });

  it('retries in 3s after the link drops mid-sync', () => {
    // The reported case: ~11s in, link dies, retry finishes the sync in ~2s.
    transport.noteConfigSyncLoss();
    transport.scheduleReconnect();

    expect(scheduledDelays()).toEqual([3_000]);
  });

  it('ramps 3s -> 10s -> 30s across consecutive mid-sync losses', () => {
    // A node that cannot finish its own NodeDB dump should not be asked to
    // start over every three seconds.
    for (let i = 0; i < 3; i++) {
      transport.noteConfigSyncLoss();
      transport.scheduleReconnect();
    }

    expect(scheduledDelays()).toEqual([3_000, 10_000, 30_000]);
  });

  it('hands back to the ordinary backoff once the ramp is spent', () => {
    for (let i = 0; i < 4; i++) {
      transport.noteConfigSyncLoss();
      transport.scheduleReconnect();
    }

    expect(scheduledDelays()).toEqual([3_000, 10_000, 30_000, 60_000]);
  });

  it('resets the ramp when a sync actually completes', () => {
    // The ramp counts CONSECUTIVE failures. A source that recovers on the first
    // fast retry and hits an unrelated mid-sync loss hours later should get the
    // quick attempt again, not resume from whatever rung it left off on.
    transport.noteConfigSyncLoss();
    transport.scheduleReconnect();
    transport.noteConfigSyncLoss();
    transport.scheduleReconnect();
    expect(scheduledDelays()).toEqual([3_000, 10_000]);

    transport.resetConfigSyncLossRetries();

    transport.noteConfigSyncLoss();
    transport.scheduleReconnect();
    expect(scheduledDelays()).toEqual([3_000, 10_000, 3_000]);
  });

  it('carries the ramp across an abandoned sync rather than restarting it', () => {
    // The manager's `clearConfigCapture` (teardown paths where no sync
    // finished) deliberately does NOT call resetConfigSyncLossRetries — only
    // `completeConfigCapture` does. So a source that keeps dying mid-sync
    // continues down the ramp instead of getting a fresh 3s rung each cycle.
    //
    // Worth stating what this does NOT affect: the ramp lives on the transport
    // instance, and a manual disconnect/reconnect builds a new one
    // (`teardownExistingTransport` -> `new TcpTransport()`), so an operator
    // reconnecting by hand always starts from the top rung.
    transport.noteConfigSyncLoss();
    transport.scheduleReconnect();

    // ...sync abandoned without completing; nothing resets the ladder...

    transport.noteConfigSyncLoss();
    transport.scheduleReconnect();

    expect(scheduledDelays()).toEqual([3_000, 10_000]);
  });

  it('does not let one mid-sync loss shorten the NEXT, unrelated disconnect', () => {
    // The flag describes the disconnect that just happened. If it survived into
    // the following reconnect, a single bad sync would quietly put the source on
    // the fast path for good.
    transport.noteConfigSyncLoss();
    transport.scheduleReconnect();
    transport.scheduleReconnect();

    expect(scheduledDelays()).toEqual([3_000, 60_000]);
  });

  it('takes precedence over the startup-grace window', () => {
    // Both can be armed at once on a passive-mode source. The mid-sync signal
    // is the more specific one — it says WHY the link dropped — and its later
    // rungs are deliberately slower than the flat grace delay, so grace must
    // not override them and re-hammer a struggling node.
    transport.setStartupGraceReconnect(120_000, 3_000);

    for (let i = 0; i < 3; i++) {
      transport.noteConfigSyncLoss();
      transport.scheduleReconnect();
    }

    expect(scheduledDelays()).toEqual([3_000, 10_000, 30_000]);
  });

  it('still honours the startup-grace window for other disconnects', () => {
    // ...and the #3122 behaviour it was added for is untouched.
    transport.setStartupGraceReconnect(120_000, 3_000);

    transport.scheduleReconnect();

    expect(scheduledDelays()).toEqual([3_000]);
  });

  it('schedules nothing at all once the transport is destroyed', () => {
    // The #3270 resurrection guard has to win over the new path too.
    transport.destroyed = true;
    transport.noteConfigSyncLoss();
    transport.scheduleReconnect();

    expect(scheduledDelays()).toEqual([]);
  });
});
