/**
 * useMeshCoreLoginProgress (#5400)
 *
 * A MeshCore remote login can now take 30 s or more (up to three attempts,
 * each waiting max(estTimeout × 2, 10 s) for the reply). This hook runs one
 * login with a fresh `requestId`, polls the server's progress endpoint while
 * the POST is open, and exposes a `cancel()` that stops further attempts.
 *
 * The login POST still carries the final answer; progress is display-only.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MeshCoreActions, MeshCoreLoginProgressSnapshot } from './useMeshCore';

/** How often to ask the server for progress while a login is open. */
export const LOGIN_PROGRESS_POLL_MS = 1000;

export interface MeshCoreLoginProgressState {
  requestId: string;
  phase: MeshCoreLoginProgressSnapshot['phase'];
  attempt: number;
  maxAttempts: number;
  /** Length of the current wait, when the server has reported one. */
  waitMs: number | null;
  /** Client-clock time the current wait ends, for a smooth countdown. */
  waitEndsAt: number | null;
  /** The user pressed Cancel; waiting for the server to confirm. */
  cancelling: boolean;
}

/** Fresh, URL-safe request id (matches the server's 8-64 [A-Za-z0-9_-]). */
export function newLoginRequestId(): string {
  const c = typeof globalThis !== 'undefined' ? (globalThis.crypto as Crypto | undefined) : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  let id = 'login-';
  for (let i = 0; i < 24; i++) id += Math.floor(Math.random() * 36).toString(36);
  return id;
}

type ProgressActions = Pick<MeshCoreActions, 'getLoginProgress' | 'cancelLogin'>;

export interface UseMeshCoreLoginProgress {
  /** Null when no login is running. */
  progress: MeshCoreLoginProgressState | null;
  /**
   * Run `login(requestId)` with live progress. `cancelledByUser` is true when
   * Cancel was pressed during the run: callers must then show "cancelled"
   * whatever `value` says, so a reply that raced the cancel never flips the
   * UI to "logged in".
   */
  run: <T>(login: (requestId: string) => Promise<T>) => Promise<{ value: T; cancelledByUser: boolean }>;
  /** Stop the running login (no-op when none). */
  cancel: () => Promise<void>;
}

export function useMeshCoreLoginProgress(actions: ProgressActions): UseMeshCoreLoginProgress {
  const [progress, setProgress] = useState<MeshCoreLoginProgressState | null>(null);
  // `actions` is rebuilt on every render of useMeshCore; read it through a
  // ref so a running poll never restarts because of that.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const currentIdRef = useRef<string | null>(null);
  // Request id the user asked to cancel. Kept so a cancel pressed before the
  // server had registered the login is re-sent on the next poll.
  const cancelWantedRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(async <T,>(
    login: (requestId: string) => Promise<T>,
  ): Promise<{ value: T; cancelledByUser: boolean }> => {
    const requestId = newLoginRequestId();
    currentIdRef.current = requestId;
    setProgress({
      requestId,
      phase: 'starting',
      attempt: 1,
      maxAttempts: 3,
      waitMs: null,
      waitEndsAt: null,
      cancelling: false,
    });

    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const snap = await actionsRef.current.getLoginProgress(requestId);
        if (!snap || !mountedRef.current || currentIdRef.current !== requestId) return;
        if (cancelWantedRef.current === requestId && !snap.cancelRequested && snap.phase !== 'done') {
          void actionsRef.current.cancelLogin(requestId);
        }
        setProgress((prev) => {
          if (!prev || prev.requestId !== requestId) return prev;
          return {
            ...prev,
            phase: snap.phase,
            attempt: Math.max(1, snap.attempt),
            maxAttempts: snap.maxAttempts,
            waitMs: snap.waitMs,
            waitEndsAt: snap.waitRemainingMs !== null ? Date.now() + snap.waitRemainingMs : null,
            cancelling: prev.cancelling || snap.cancelRequested,
          };
        });
      } catch {
        // Progress is display-only; a failed poll just skips one update.
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => void poll(), LOGIN_PROGRESS_POLL_MS);

    try {
      const value = await login(requestId);
      return { value, cancelledByUser: cancelWantedRef.current === requestId };
    } finally {
      clearInterval(timer);
      if (cancelWantedRef.current === requestId) cancelWantedRef.current = null;
      if (currentIdRef.current === requestId) {
        currentIdRef.current = null;
        if (mountedRef.current) setProgress(null);
      }
    }
  }, []);

  const cancel = useCallback(async () => {
    const requestId = currentIdRef.current;
    if (!requestId) return;
    cancelWantedRef.current = requestId;
    setProgress((prev) => (prev && prev.requestId === requestId ? { ...prev, cancelling: true } : prev));
    try {
      await actionsRef.current.cancelLogin(requestId);
    } catch {
      // Re-sent by the next poll while the login is still open.
    }
  }, []);

  return { progress, run, cancel };
}
