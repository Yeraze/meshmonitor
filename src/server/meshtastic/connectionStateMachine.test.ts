import { describe, it, expect } from 'vitest';
import { ConnState, dispatch, defaultSmContext, type SmContext } from './connectionStateMachine.js';

/** Build a context by overriding only the fields a test cares about. */
const ctx = (overrides: Partial<SmContext> = {}): SmContext => ({ ...defaultSmContext, ...overrides });

const kinds = (actions: { kind: string }[]) => actions.map((a) => a.kind);

describe('connectionStateMachine dispatch() — pure reducer (task42b_spec.md §3.2)', () => {
  describe('CONNECT_REQUESTED', () => {
    it.each([ConnState.Disconnected, ConnState.UserDisconnected, ConnState.Connected, ConnState.ConfigSync])(
      'from %s goes to Connecting when no post-reset cooldown is active',
      (from) => {
        const { next, actions } = dispatch(from, 'CONNECT_REQUESTED', ctx({ postResetActive: false }));
        expect(next).toBe(ConnState.Connecting);
        expect(kinds(actions)).toContain('teardownPrevTransport');
      }
    );

    it('goes to Probing first when a post-reset cooldown is active', () => {
      const { next, actions } = dispatch(ConnState.Disconnected, 'CONNECT_REQUESTED', ctx({ postResetActive: true }));
      expect(next).toBe(ConnState.Probing);
      expect(kinds(actions)).toContain('teardownPrevTransport');
    });
  });

  describe('PROBE_DONE', () => {
    it('Probing -> Connecting, clears the cooldown and proceeds to transport.connect', () => {
      const { next, actions } = dispatch(ConnState.Probing, 'PROBE_DONE', ctx());
      expect(next).toBe(ConnState.Connecting);
      expect(kinds(actions)).toEqual(['clearPostResetCooldown', 'connectTransport']);
    });
  });

  describe('TRANSPORT_CONNECTED', () => {
    it('bails silently (#3247) when no transport is present at entry — no mutation, no actions', () => {
      const { next, actions } = dispatch(ConnState.Connecting, 'TRANSPORT_CONNECTED', ctx({ transportPresent: false }));
      expect(next).toBe(ConnState.Connecting);
      expect(actions).toEqual([]);
    });

    it('skips the handshake when passive && cachesFresh -> Connected, completes capture, keeps localNodeInfo', () => {
      const { next, actions } = dispatch(
        ConnState.Connecting,
        'TRANSPORT_CONNECTED',
        ctx({ passive: true, cachesFresh: true })
      );
      expect(next).toBe(ConnState.Connected);
      expect(kinds(actions)).toEqual(['completeConfigCapture', 'emitStatus', 'runOnConfigCaptureComplete']);
      expect(kinds(actions)).not.toContain('clearDeviceCaches');
    });

    it('does NOT skip when passive but cache is stale -> ConfigSync (full handshake)', () => {
      const { next, actions } = dispatch(
        ConnState.Connecting,
        'TRANSPORT_CONNECTED',
        ctx({ passive: true, cachesFresh: false })
      );
      expect(next).toBe(ConnState.ConfigSync);
      expect(kinds(actions)).toEqual([
        'clearDeviceCaches',
        'startConfigCapture',
        'snapshotChannels',
        'emitStatus',
        'sendWantConfig',
        'armFallbackTimer',
      ]);
    });

    it('skips via the manual-resync recovery suppress latch -> Connected, consumes the latch exactly once', () => {
      const { next, actions } = dispatch(ConnState.Connecting, 'TRANSPORT_CONNECTED', ctx({ suppressNext: true }));
      expect(next).toBe(ConnState.Connected);
      expect(kinds(actions)).toEqual([
        'consumeSuppressNext',
        'clearManualResync',
        'completeConfigCapture',
        'emitStatus',
        'runOnConfigCaptureComplete',
      ]);
      expect(actions.filter((a) => a.kind === 'consumeSuppressNext')).toHaveLength(1);
      const clearAction = actions.find((a) => a.kind === 'clearManualResync') as { reason: string };
      expect(clearAction.reason).toBe('recovery');
    });

    it('runs the full handshake when neither passive-fresh nor suppress applies (cold connect)', () => {
      const { next, actions } = dispatch(ConnState.Connecting, 'TRANSPORT_CONNECTED', ctx());
      expect(next).toBe(ConnState.ConfigSync);
      expect(kinds(actions)).toContain('startConfigCapture');
      expect(kinds(actions)).toContain('sendWantConfig');
    });
  });

  describe('HANDSHAKE_SEND_FAILED', () => {
    it('bails silently (#3247) when the transport was replaced mid-await — unchanged, no actions', () => {
      const { next, actions } = dispatch(ConnState.ConfigSync, 'HANDSHAKE_SEND_FAILED', ctx({ transportIdentityMatches: false }));
      expect(next).toBe(ConnState.ConfigSync);
      expect(actions).toEqual([]);
    });

    it('treats a genuine same-transport send failure as a post-connect reset -> Disconnected', () => {
      const { next, actions } = dispatch(ConnState.ConfigSync, 'HANDSHAKE_SEND_FAILED', ctx({ transportIdentityMatches: true }));
      expect(next).toBe(ConnState.Disconnected);
      expect(kinds(actions)).toEqual(['setPostResetCooldown', 'disconnectTransport', 'emitStatus']);
    });
  });

  describe('CONFIG_COMPLETE', () => {
    it('ConfigSync -> Connected, completes capture, migrates channels, cancels the fallback timer', () => {
      const { next, actions } = dispatch(ConnState.ConfigSync, 'CONFIG_COMPLETE', ctx());
      expect(next).toBe(ConnState.Connected);
      expect(kinds(actions)).toEqual([
        'completeConfigCapture',
        'detectChannelMigration',
        'clearManualResync',
        'runOnConfigCaptureComplete',
        'cancelFallbackTimer',
      ]);
      const clearAction = actions.find((a) => a.kind === 'clearManualResync') as { reason: string };
      expect(clearAction.reason).toBe('configComplete');
    });
  });

  describe('CONFIG_FALLBACK', () => {
    it('ConfigSync -> Connected via the fallback path, completes capture without channel-migration detection', () => {
      const { next, actions } = dispatch(ConnState.ConfigSync, 'CONFIG_FALLBACK', ctx());
      expect(next).toBe(ConnState.Connected);
      expect(kinds(actions)).toEqual(['completeConfigCapture', 'runOnConfigCaptureComplete']);
      expect(kinds(actions)).not.toContain('detectChannelMigration');
    });
  });

  describe('MANUAL_RESYNC_REQUESTED', () => {
    it('Connected -> ConfigSync, latches suppressNext, starts capture, arms the watchdog, resends want_config', () => {
      const { next, actions } = dispatch(ConnState.Connected, 'MANUAL_RESYNC_REQUESTED', ctx());
      expect(next).toBe(ConnState.ConfigSync);
      expect(kinds(actions)).toEqual(['latchSuppressNext', 'startConfigCapture', 'armResyncWatchdog', 'sendWantConfig']);
      expect(kinds(actions)).not.toContain('clearDeviceCaches');
    });
  });

  describe('RESYNC_WATCHDOG', () => {
    it('leaves state unchanged and only clears the manual-resync in-flight latch', () => {
      const { next, actions } = dispatch(ConnState.ConfigSync, 'RESYNC_WATCHDOG', ctx());
      expect(next).toBe(ConnState.ConfigSync);
      expect(kinds(actions)).toEqual(['clearManualResync']);
      const clearAction = actions[0] as { reason: string };
      expect(clearAction.reason).toBe('watchdog');
    });
  });

  describe('TRANSPORT_DISCONNECTED', () => {
    it.each([ConnState.ConfigSync, ConnState.Connected])('%s -> Disconnected, non-passive clears every cache', (from) => {
      const { next, actions } = dispatch(from, 'TRANSPORT_DISCONNECTED', ctx({ passive: false }));
      expect(next).toBe(ConnState.Disconnected);
      expect(kinds(actions)).toEqual(['recordLastDisconnect', 'clearDeviceCaches', 'clearConfigCapture', 'notifyDisconnected', 'emitStatus']);
    });

    it('passive + VN clears the init-config cache (fresh replay data) but not the rest', () => {
      const { actions } = dispatch(ConnState.Connected, 'TRANSPORT_DISCONNECTED', ctx({ passive: true, vnEnabled: true }));
      expect(kinds(actions)).toEqual(['recordLastDisconnect', 'clearConfigCapture', 'notifyDisconnected', 'emitStatus']);
      expect(kinds(actions)).not.toContain('clearDeviceCaches');
    });

    it('passive + no VN PRESERVES the config-capture cache (#3122 — the pinned combination)', () => {
      const { next, actions } = dispatch(ConnState.Connected, 'TRANSPORT_DISCONNECTED', ctx({ passive: true, vnEnabled: false }));
      expect(next).toBe(ConnState.Disconnected);
      expect(kinds(actions)).toEqual(['recordLastDisconnect', 'preserveConfigCapture', 'notifyDisconnected', 'emitStatus']);
      expect(kinds(actions)).not.toContain('clearConfigCapture');
      expect(kinds(actions)).not.toContain('clearDeviceCaches');
    });
  });

  describe('USER_DISCONNECT', () => {
    it.each([ConnState.Disconnected, ConnState.Connecting, ConnState.Probing, ConnState.ConfigSync, ConnState.Connected])(
      'from %s goes to UserDisconnected and leaves capture flags untouched',
      (from) => {
        const { next, actions } = dispatch(from, 'USER_DISCONNECT', ctx());
        expect(next).toBe(ConnState.UserDisconnected);
        expect(kinds(actions)).toEqual(['notifyDisconnected', 'disconnectTransport', 'stopSchedulers']);
        expect(kinds(actions)).not.toContain('clearConfigCapture');
        expect(kinds(actions)).not.toContain('completeConfigCapture');
        expect(kinds(actions)).not.toContain('preserveConfigCapture');
      }
    );
  });

  describe('USER_RECONNECT', () => {
    it('UserDisconnected -> Connecting and triggers a fresh connect', () => {
      const { next, actions } = dispatch(ConnState.UserDisconnected, 'USER_RECONNECT', ctx());
      expect(next).toBe(ConnState.Connecting);
      expect(kinds(actions)).toEqual(['connectTransport']);
    });
  });

  // ── Edge-case / combination coverage (#3962 Phase 4.2b C3) ──
  // The suite above covers every row of task42b_spec.md §3.2 individually.
  // These tests cover combinations and starting-state independence the
  // per-row tests don't exercise directly, and explicitly document the
  // reducer's "ignores incoming `state`" design for events whose table row
  // lists specific "From" states — the manager enforces those preconditions
  // itself (guards, or the alreadyUserDisconnected non-regression check),
  // not the pure reducer.
  describe('cross-cutting combinations', () => {
    it('TRANSPORT_CONNECTED: passive+fresh AND suppressNext both true still consumes the suppress latch', () => {
      const { next, actions } = dispatch(
        ConnState.Connecting,
        'TRANSPORT_CONNECTED',
        ctx({ passive: true, cachesFresh: true, suppressNext: true })
      );
      expect(next).toBe(ConnState.Connected);
      expect(kinds(actions)).toEqual([
        'consumeSuppressNext',
        'clearManualResync',
        'completeConfigCapture',
        'emitStatus',
        'runOnConfigCaptureComplete',
      ]);
    });

    it.each([ConnState.Disconnected, ConnState.ConfigSync, ConnState.Connected, ConnState.UserDisconnected])(
      'TRANSPORT_CONNECTED is independent of the incoming state (%s) — the skip/full decision is ctx-only',
      (from) => {
        const cold = dispatch(from, 'TRANSPORT_CONNECTED', ctx());
        expect(cold.next).toBe(ConnState.ConfigSync);
        const skip = dispatch(from, 'TRANSPORT_CONNECTED', ctx({ suppressNext: true }));
        expect(skip.next).toBe(ConnState.Connected);
      }
    );

    it.each([ConnState.Connecting, ConnState.Connected, ConnState.Disconnected])(
      'HANDSHAKE_SEND_FAILED (genuine) is independent of the incoming state (%s)',
      (from) => {
        const { next, actions } = dispatch(from, 'HANDSHAKE_SEND_FAILED', ctx({ transportIdentityMatches: true }));
        expect(next).toBe(ConnState.Disconnected);
        expect(kinds(actions)).toEqual(['setPostResetCooldown', 'disconnectTransport', 'emitStatus']);
      }
    );

    it.each([ConnState.Disconnected, ConnState.UserDisconnected, ConnState.Connecting, ConnState.Probing])(
      'TRANSPORT_DISCONNECTED always returns Disconnected regardless of incoming state (%s) — the manager guards UserDisconnected non-regression itself',
      (from) => {
        const { next, actions } = dispatch(from, 'TRANSPORT_DISCONNECTED', ctx({ passive: false }));
        expect(next).toBe(ConnState.Disconnected);
        expect(kinds(actions)).toEqual(['recordLastDisconnect', 'clearDeviceCaches', 'clearConfigCapture', 'notifyDisconnected', 'emitStatus']);
      }
    );

    it('MANUAL_RESYNC_REQUESTED is independent of the incoming state — guards live in the manager, not the reducer', () => {
      const { next, actions } = dispatch(ConnState.Disconnected, 'MANUAL_RESYNC_REQUESTED', ctx());
      expect(next).toBe(ConnState.ConfigSync);
      expect(kinds(actions)).toEqual(['latchSuppressNext', 'startConfigCapture', 'armResyncWatchdog', 'sendWantConfig']);
    });

    it('CONNECT_REQUESTED from Probing/Connecting still resolves purely from ctx.postResetActive', () => {
      const fromConnecting = dispatch(ConnState.Connecting, 'CONNECT_REQUESTED', ctx({ postResetActive: false }));
      expect(fromConnecting.next).toBe(ConnState.Connecting);
      const fromProbing = dispatch(ConnState.Probing, 'CONNECT_REQUESTED', ctx({ postResetActive: true }));
      expect(fromProbing.next).toBe(ConnState.Probing);
    });
  });
});
