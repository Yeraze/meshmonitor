/**
 * useMeshCoreNeighboursFetch (#5413)
 *
 * Runs one paged neighbour fetch and keeps the UI alive while it does. A
 * repeater answers at most 10 neighbours per request and every page waits the
 * shared 60 s mesh-TX floor, so reading a 50-entry table takes minutes. The
 * start call returns at once; this hook then polls the server's progress
 * endpoint every second, exposing the page, the table size, the neighbours
 * gathered so far, and a countdown to the next page, plus `cancel()`.
 *
 * Mirrors useMeshCoreLoginProgress (#5400): client-chosen request id, polling,
 * and a cancel that the next poll re-sends if the first try failed.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { newLoginRequestId } from './useMeshCoreLoginProgress';
import type {
  MeshCoreNeighboursFetchActions,
  MeshCoreNeighboursFetchSnapshot,
} from './meshcoreNeighboursFetchApi';

/** How often to ask the server for progress while a fetch runs. */
export const NEIGHBOURS_FETCH_POLL_MS = 1000;

/**
 * Give up watching after this many polls in a row find nothing (server
 * restarted, entry expired), so the button never stays locked.
 */
export const NEIGHBOURS_FETCH_MAX_MISSES = 15;

export interface MeshCoreNeighboursFetchState extends MeshCoreNeighboursFetchSnapshot {
  /** Client-clock time the current wait ends, for a smooth countdown. */
  waitEndsAt: number | null;
  /** The user pressed Cancel; waiting for the server to stop. */
  cancelling: boolean;
}

export interface UseMeshCoreNeighboursFetch {
  /** Live or final state of the last fetch; null before the first. */
  fetch: MeshCoreNeighboursFetchState | null;
  /** True while a fetch is running (not yet `done`). */
  running: boolean;
  /** Why the last start failed (e.g. another fetch runs on this source). */
  startError: { message: string; txDisabled: boolean } | null;
  /** Start a fetch for `publicKey`, or re-attach to the caller's own running one. */
  start: (publicKey: string) => Promise<void>;
  /** Stop further pages (no-op when none is running). */
  cancel: () => Promise<void>;
  /** Stop watching and forget the result (the server fetch keeps going). */
  reset: () => void;
}

function toState(snap: MeshCoreNeighboursFetchSnapshot, prev: MeshCoreNeighboursFetchState | null): MeshCoreNeighboursFetchState {
  return {
    ...snap,
    waitEndsAt: snap.waitRemainingMs !== null ? Date.now() + snap.waitRemainingMs : null,
    cancelling: snap.phase !== 'done' && ((prev?.requestId === snap.requestId && prev.cancelling) || snap.cancelRequested),
  };
}

function startingState(requestId: string, publicKey: string): MeshCoreNeighboursFetchState {
  return {
    requestId,
    publicKey,
    phase: 'starting',
    page: 0,
    plannedPages: 0,
    maxPages: 0,
    total: null,
    pagesFetched: 0,
    neighbours: [],
    waitMs: null,
    waitRemainingMs: null,
    cancelRequested: false,
    outcome: null,
    stored: null,
    written: null,
    error: null,
    waitEndsAt: null,
    cancelling: false,
  };
}

export function useMeshCoreNeighboursFetch(actions: MeshCoreNeighboursFetchActions): UseMeshCoreNeighboursFetch {
  const [fetchState, setFetchState] = useState<MeshCoreNeighboursFetchState | null>(null);
  const [startError, setStartError] = useState<{ message: string; txDisabled: boolean } | null>(null);
  // Callers may rebuild `actions` every render; read it through a ref so a
  // running poll never restarts because of that.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const currentRef = useRef<{ requestId: string; publicKey: string } | null>(null);
  const cancelWantedRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);
  // `start` must not stack a second fetch while one is live. The flag lives
  // in state, so read it through a ref kept in step with each render.
  const runningRef = useRef(false);
  runningRef.current = fetchState !== null && fetchState.phase !== 'done';

  const stopPolling = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
  }, [stopPolling]);

  const watch = useCallback((requestId: string, publicKey: string) => {
    stopPolling();
    currentRef.current = { requestId, publicKey };
    let polling = false;
    let misses = 0;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const snap = await actionsRef.current.getNeighboursFetchProgress(publicKey, requestId);
        if (!mountedRef.current || currentRef.current?.requestId !== requestId) return;
        if (!snap) {
          // Usually transient; the next poll tries again. Many in a row means
          // the server no longer knows this fetch: stop and unlock the UI.
          misses++;
          if (misses >= NEIGHBOURS_FETCH_MAX_MISSES) {
            stopPolling();
            setFetchState((prev) => (prev && prev.requestId === requestId && prev.phase !== 'done'
              ? { ...prev, phase: 'done', outcome: 'failed', error: 'Lost track of the fetch', waitEndsAt: null, cancelling: false }
              : prev));
          }
          return;
        }
        misses = 0;
        if (cancelWantedRef.current === requestId && !snap.cancelRequested && snap.phase !== 'done') {
          void actionsRef.current.cancelNeighboursFetch(publicKey, requestId);
        }
        setFetchState((prev) => toState(snap, prev));
        if (snap.phase === 'done') {
          stopPolling();
          if (cancelWantedRef.current === requestId) cancelWantedRef.current = null;
        }
      } catch {
        // Progress is display-only; a failed poll just skips one update.
      } finally {
        polling = false;
      }
    };
    timerRef.current = setInterval(() => void poll(), NEIGHBOURS_FETCH_POLL_MS);
    void poll();
  }, [stopPolling]);

  const start = useCallback(async (publicKey: string) => {
    if (runningRef.current) return;
    const requestId = newLoginRequestId();
    setStartError(null);
    setFetchState(startingState(requestId, publicKey));
    currentRef.current = { requestId, publicKey };
    const res = await actionsRef.current.startNeighboursFetch(publicKey, requestId);
    if (!mountedRef.current || currentRef.current?.requestId !== requestId) return;
    if (res.ok) {
      watch(requestId, publicKey);
      return;
    }
    // Our own fetch for this node is already running (e.g. the panel was
    // re-opened, or the other button started it): follow that one.
    if (
      res.code === 'NEIGHBOURS_FETCH_IN_PROGRESS' &&
      res.activeRequestId &&
      res.activePublicKey?.toLowerCase() === publicKey.toLowerCase()
    ) {
      setFetchState(startingState(res.activeRequestId, publicKey));
      watch(res.activeRequestId, publicKey);
      return;
    }
    currentRef.current = null;
    setFetchState(null);
    setStartError({ message: res.error, txDisabled: !!res.txDisabled });
  }, [watch]);

  const cancel = useCallback(async () => {
    const cur = currentRef.current;
    if (!cur) return;
    cancelWantedRef.current = cur.requestId;
    setFetchState((prev) => (prev && prev.requestId === cur.requestId && prev.phase !== 'done' ? { ...prev, cancelling: true } : prev));
    try {
      await actionsRef.current.cancelNeighboursFetch(cur.publicKey, cur.requestId);
    } catch {
      // Re-sent by the next poll while the fetch is still running.
    }
  }, []);

  const reset = useCallback(() => {
    stopPolling();
    currentRef.current = null;
    cancelWantedRef.current = null;
    setFetchState(null);
    setStartError(null);
  }, [stopPolling]);

  return {
    fetch: fetchState,
    running: fetchState !== null && fetchState.phase !== 'done',
    startError,
    start,
    cancel,
    reset,
  };
}
