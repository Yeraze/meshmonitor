/**
 * Connection-lifecycle state machine for `MeshtasticManager` (#3962 Phase 4.2b).
 *
 * This module is a **pure** reducer: `dispatch(state, event, ctx)` takes the
 * current `ConnState`, an event, and a synchronously-built context snapshot,
 * and returns the next state plus a list of side-effecting `SmAction`s the
 * caller (the manager) must execute. There is no I/O here — no transport
 * calls, no DB, no timers, no logging — which is what makes the transition
 * table in task42b_spec.md §3.2 exhaustively unit-testable with zero mocks.
 *
 * Design notes (task42b_spec.md §0.1/§0.3, read before editing):
 *
 * - The manager does NOT own a reconnect retry loop, backoff, or grace timer
 *   — those live in `TcpTransport`. This machine models the manager's own
 *   surface: the connection lifecycle, the config-capture handshake
 *   (want_config_id → configComplete) and its skip paths (passive-mode fresh
 *   cache, manual-resync recovery), and the connect-race identity guard
 *   (#3247).
 * - `configCaptureComplete` / `isCapturingInitConfig` are **cache-freshness
 *   facts**, not link-state — they are deliberately NOT derived from
 *   `ConnState` on the manager (a passive non-VN disconnect preserves
 *   `configCaptureComplete=true` while the link goes down — #3122, pinned by
 *   `passiveMode.test.ts`). This reducer still models their intended
 *   writes as `SmAction`s (`startConfigCapture` / `completeConfigCapture` /
 *   `clearConfigCapture` / `preserveConfigCapture`) so the manager's action
 *   executor has one authoritative place to look up which action owns those
 *   two fields for a given transition — but the reducer itself never reads
 *   or writes them (no I/O, pure state-in/state-out).
 * - `Probing` is not a resting state — it's the post-reset-cooldown +
 *   TCP-readiness-probe wait *inside* the connect flow, entered only when
 *   `ctx.postResetActive` is true.
 * - Manual resync re-opens `ConfigSync` from `Connected` (`origin: 'manual'`
 *   carried by the caller via context/logging, not a new top-level state).
 * - Passive mode is not a state — it's a context modifier that changes which
 *   transition `TRANSPORT_CONNECTED` produces.
 */

export enum ConnState {
  /** No live handshake; the transport may still be auto-retrying underneath us. */
  Disconnected = 'disconnected',
  /** `doConnectInternal` running: teardown → optional Probing → `transport.connect`. */
  Connecting = 'connecting',
  /** Post-reset cooldown wait + `waitForTcpReady`, only entered when `postResetCooldownUntil > 0`. */
  Probing = 'probing',
  /** Transport connected, `want_config_id` sent, buffering FromRadio until `configComplete`. */
  ConfigSync = 'config_sync',
  /** Handshake complete (or skipped via passive/recovery/fallback); steady state. */
  Connected = 'connected',
  /** Operator-initiated stop; auto-reconnect suppressed until `USER_RECONNECT`. */
  UserDisconnected = 'user_disconnected',
}

export type SmEvent =
  | 'CONNECT_REQUESTED'
  | 'PROBE_DONE'
  | 'TRANSPORT_CONNECTED'
  | 'HANDSHAKE_SEND_FAILED'
  | 'CONFIG_COMPLETE'
  | 'CONFIG_FALLBACK'
  | 'MANUAL_RESYNC_REQUESTED'
  | 'RESYNC_WATCHDOG'
  | 'TRANSPORT_DISCONNECTED'
  | 'USER_DISCONNECT'
  | 'USER_RECONNECT';

/**
 * The four capture-flag actions are the ONLY writers of the manager's
 * `configCaptureComplete` + `isCapturingInitConfig` fields (task42b_spec.md
 * §0.3/§3.2 legend):
 *   - `startConfigCapture`    → {capturing:true,  complete:false} + reset initConfigCache/snapshot
 *   - `completeConfigCapture` → {capturing:false, complete:true}
 *   - `clearConfigCapture`    → {capturing:false, complete:false} + clear initConfigCache
 *   - `preserveConfigCapture` → no-op on both flags (passive non-VN disconnect, #3122)
 */
export type SmAction =
  | { kind: 'teardownPrevTransport' }
  | { kind: 'connectTransport' }
  | { kind: 'disconnectTransport' }
  | { kind: 'sendWantConfig' }
  | { kind: 'startConfigCapture' }
  | { kind: 'completeConfigCapture' }
  | { kind: 'clearConfigCapture' }
  | { kind: 'preserveConfigCapture' }
  | { kind: 'clearDeviceCaches'; keepLocalNodeInfo: boolean }
  | { kind: 'snapshotChannels' }
  | { kind: 'detectChannelMigration' }
  | { kind: 'armFallbackTimer' }
  | { kind: 'cancelFallbackTimer' }
  | { kind: 'setPostResetCooldown' }
  | { kind: 'clearPostResetCooldown' }
  | { kind: 'consumeSuppressNext' }
  | { kind: 'latchSuppressNext' }
  | { kind: 'armResyncWatchdog' }
  | { kind: 'clearManualResync'; reason: 'recovery' | 'configComplete' | 'watchdog' | 'send-failed' }
  | { kind: 'recordLastDisconnect' }
  | { kind: 'stopSchedulers' }
  | { kind: 'runOnConfigCaptureComplete' }
  | { kind: 'notifyConnected' }
  | { kind: 'notifyDisconnected' }
  | { kind: 'emitStatus'; connected: boolean; reason: string };

export interface SmContext {
  /** Source is configured for Passive Mode (#3122). */
  passive: boolean;
  /** A VirtualNodeServer is attached to this source. */
  vnEnabled: boolean;
  /** Passive-mode cached snapshot is still within the freshness window. */
  cachesFresh: boolean;
  /** The one-shot manual-resync-recovery suppress latch is set. */
  suppressNext: boolean;
  /** `postResetCooldownUntil > 0` — a post-reset cooldown/probe is pending. */
  postResetActive: boolean;
  /** `this.transport` is non-null at the moment the event is being handled. */
  transportPresent: boolean;
  /** The transport captured when the in-flight operation started is still `this.transport` (#3247). */
  transportIdentityMatches: boolean;
}

export interface SmResult {
  next: ConnState;
  actions: SmAction[];
}

/** A context with every modifier at its "vanilla" default — spread-override in tests/callers. */
export const defaultSmContext: SmContext = {
  passive: false,
  vnEnabled: false,
  cachesFresh: false,
  suppressNext: false,
  postResetActive: false,
  transportPresent: true,
  transportIdentityMatches: true,
};

/**
 * Pure reducer: `(state, event, ctx) -> { next, actions }`. No I/O — see the
 * module doc comment. Every branch below is keyed to a row of
 * task42b_spec.md §3.2's transition table; the row is quoted in the comment
 * so the two stay auditable against each other.
 */
export function dispatch(state: ConnState, event: SmEvent, ctx: SmContext): SmResult {
  switch (event) {
    // | CONNECT_REQUESTED | Disconnected / UserDisconnected / Connected / ConfigSync
    // | → Connecting | teardown-prev-transport-if-different (#3270); if postResetActive → Probing first
    case 'CONNECT_REQUESTED': {
      const actions: SmAction[] = [{ kind: 'teardownPrevTransport' }];
      return { next: ctx.postResetActive ? ConnState.Probing : ConnState.Connecting, actions };
    }

    // | PROBE_DONE | Probing → Connecting | clear postResetCooldownUntil; proceed to transport.connect
    case 'PROBE_DONE': {
      return {
        next: ConnState.Connecting,
        actions: [{ kind: 'clearPostResetCooldown' }, { kind: 'connectTransport' }],
      };
    }

    // | TRANSPORT_CONNECTED (no transport at entry) | Connecting → unchanged | silent bail (#3247)
    // | TRANSPORT_CONNECTED (identity ok, skip: passive&&cachesFresh || suppressNext) | Connecting → Connected
    // | TRANSPORT_CONNECTED (identity ok, full) | Connecting → ConfigSync
    case 'TRANSPORT_CONNECTED': {
      if (!ctx.transportPresent) {
        // #3247 silent bail — no state mutation, no flag write, no emit.
        return { next: state, actions: [] };
      }
      const skip = (ctx.passive && ctx.cachesFresh) || ctx.suppressNext;
      if (skip) {
        const actions: SmAction[] = [];
        if (ctx.suppressNext) {
          actions.push({ kind: 'consumeSuppressNext' });
          actions.push({ kind: 'clearManualResync', reason: 'recovery' });
        }
        actions.push({ kind: 'completeConfigCapture' });
        actions.push({ kind: 'emitStatus', connected: true, reason: 'TCP connection established' });
        actions.push({ kind: 'runOnConfigCaptureComplete' });
        return { next: ConnState.Connected, actions };
      }
      return {
        next: ConnState.ConfigSync,
        actions: [
          { kind: 'clearDeviceCaches', keepLocalNodeInfo: false },
          { kind: 'startConfigCapture' },
          { kind: 'snapshotChannels' },
          { kind: 'emitStatus', connected: true, reason: 'TCP connection established' },
          { kind: 'sendWantConfig' },
          { kind: 'armFallbackTimer' },
        ],
      };
    }

    // | HANDSHAKE_SEND_FAILED (transport replaced mid-await) | ConfigSync → unchanged | silent bail (#3247)
    // | HANDSHAKE_SEND_FAILED (transport same, genuine) | ConfigSync → Disconnected
    case 'HANDSHAKE_SEND_FAILED': {
      if (!ctx.transportIdentityMatches) {
        // New connect already in flight — leave state and flags alone.
        return { next: state, actions: [] };
      }
      return {
        next: ConnState.Disconnected,
        actions: [
          { kind: 'setPostResetCooldown' },
          { kind: 'disconnectTransport' },
          { kind: 'emitStatus', connected: false, reason: 'Transport reset immediately after connect' },
        ],
      };
    }

    // | CONFIG_COMPLETE | ConfigSync → Connected | completeConfigCapture; detectAndMigrateChannelChanges;
    // clearManualResyncInFlight('configComplete'); fire callbacks; stagger scheduler starts; cancel fallback timer
    case 'CONFIG_COMPLETE': {
      return {
        next: ConnState.Connected,
        actions: [
          { kind: 'completeConfigCapture' },
          { kind: 'detectChannelMigration' },
          { kind: 'clearManualResync', reason: 'configComplete' },
          { kind: 'runOnConfigCaptureComplete' },
          { kind: 'cancelFallbackTimer' },
        ],
      };
    }

    // | CONFIG_FALLBACK (timer, still !complete && connected) | ConfigSync → Connected
    // | completeConfigCapture + completion actions via fallback path (no channel-migration detection —
    // | the fallback only fires when configComplete never arrived, so there's nothing to detect)
    case 'CONFIG_FALLBACK': {
      return {
        next: ConnState.Connected,
        actions: [{ kind: 'completeConfigCapture' }, { kind: 'runOnConfigCaptureComplete' }],
      };
    }

    // | MANUAL_RESYNC_REQUESTED (guards pass, Connected) | Connected → ConfigSync (origin=manual)
    // | latch suppressNextAutoSync; startConfigCapture; arm resync watchdog; sendWantConfigId.
    // | No localNodeInfo clear — transport stays up.
    case 'MANUAL_RESYNC_REQUESTED': {
      return {
        next: ConnState.ConfigSync,
        actions: [
          { kind: 'latchSuppressNext' },
          { kind: 'startConfigCapture' },
          { kind: 'armResyncWatchdog' },
          { kind: 'sendWantConfig' },
        ],
      };
    }

    // | RESYNC_WATCHDOG | ConfigSync(manual) → ConfigSync | clearManualResyncInFlight('watchdog')
    // (latch self-clears; state + flags unchanged)
    case 'RESYNC_WATCHDOG': {
      return { next: state, actions: [{ kind: 'clearManualResync', reason: 'watchdog' }] };
    }

    // | TRANSPORT_DISCONNECTED (not user, non-passive) | ConfigSync/Connected → Disconnected
    // | TRANSPORT_DISCONNECTED (not user, passive + VN) | ConfigSync/Connected → Disconnected
    // | TRANSPORT_DISCONNECTED (not user, passive + no VN, #3122) | ConfigSync/Connected → Disconnected
    case 'TRANSPORT_DISCONNECTED': {
      const actions: SmAction[] = [{ kind: 'recordLastDisconnect' }];
      if (!ctx.passive) {
        actions.push({ kind: 'clearDeviceCaches', keepLocalNodeInfo: false });
        actions.push({ kind: 'clearConfigCapture' });
      } else if (ctx.vnEnabled) {
        actions.push({ kind: 'clearConfigCapture' });
      } else {
        // #3122 passive, no VN — the pinned "Disconnected + complete:true" combination.
        actions.push({ kind: 'preserveConfigCapture' });
      }
      actions.push({ kind: 'notifyDisconnected' });
      actions.push({ kind: 'emitStatus', connected: false, reason: 'TCP connection lost' });
      return { next: ConnState.Disconnected, actions };
    }

    // | USER_DISCONNECT | any → UserDisconnected | notify; transport.disconnect(); stop all
    // schedulers/timers; capture flags untouched (terminal; matches L1854/L12949 behavior)
    case 'USER_DISCONNECT': {
      return {
        next: ConnState.UserDisconnected,
        actions: [
          { kind: 'notifyDisconnected' },
          { kind: 'disconnectTransport' },
          { kind: 'stopSchedulers' },
        ],
      };
    }

    // | USER_RECONNECT | UserDisconnected → Connecting | clear flag; connect()
    case 'USER_RECONNECT': {
      return { next: ConnState.Connecting, actions: [{ kind: 'connectTransport' }] };
    }

    default: {
      // Exhaustiveness guard — a new SmEvent variant without a case here is a compile error.
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}
