/**
 * useGeolocationWatch (#5891 Walkabout P1, spec §2.9).
 *
 * Wraps `navigator.geolocation.watchPosition`. The watch starts only from
 * `start()` (a user tap) so the browser consent prompt has a clear cause.
 * Adds a heartbeat (some browsers fire only on movement), tracks time the page
 * spent hidden (the browser pauses GPS then), and holds a screen wake lock
 * where the browser has one (progressive enhancement).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { WALKABOUT_HEARTBEAT_MS } from '../utils/walkabout.js';
import type { WalkaboutFix } from '../utils/walkaboutSampler.js';

export type GeolocationSupport = 'ok' | 'insecure' | 'unavailable';
export type GeolocationState = 'idle' | 'watching' | 'denied' | 'error';

/** Hidden spans shorter than this are not worth a banner. */
export const MIN_REPORTED_PAUSE_MS = 10_000;

const POSITION_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 };
const HEARTBEAT_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 2_000, timeout: 30_000 };

interface WakeLockSentinelLike {
  release(): Promise<void>;
}
interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

function getWakeLock(): WakeLockLike | null {
  if (typeof navigator === 'undefined') return null;
  return ((navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock) ?? null;
}

export function getGeolocationSupport(): GeolocationSupport {
  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'insecure';
  if (typeof navigator === 'undefined' || !navigator.geolocation) return 'unavailable';
  return 'ok';
}

export interface UseGeolocationWatch {
  support: GeolocationSupport;
  state: GeolocationState;
  /** Latest accuracy in metres (any fix, sent or not). */
  accuracy: number | null;
  /** Length of the last hidden span, once the page is visible again. */
  pausedMs: number | null;
  clearPaused: () => void;
  wakeLockSupported: boolean;
  wakeLockActive: boolean;
  start: () => void;
  stop: () => void;
}

export function useGeolocationWatch(onFix: (fix: WalkaboutFix) => void): UseGeolocationWatch {
  const [support] = useState<GeolocationSupport>(getGeolocationSupport);
  const [state, setState] = useState<GeolocationState>('idle');
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [pausedMs, setPausedMs] = useState<number | null>(null);
  const [wakeLockActive, setWakeLockActive] = useState(false);

  const onFixRef = useRef(onFix);
  onFixRef.current = onFix;
  const watchId = useRef<number | null>(null);
  const beat = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hiddenAt = useRef<number | null>(null);
  const wakeSentinel = useRef<WakeLockSentinelLike | null>(null);
  const watching = useRef(false);

  const requestWakeLock = useCallback(async () => {
    const wl = getWakeLock();
    if (!wl || wakeSentinel.current) return;
    try {
      wakeSentinel.current = await wl.request('screen');
      setWakeLockActive(true);
    } catch {
      setWakeLockActive(false);
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    const s = wakeSentinel.current;
    wakeSentinel.current = null;
    setWakeLockActive(false);
    if (s) void s.release().catch(() => undefined);
  }, []);

  const clearBeat = () => {
    if (beat.current != null) clearTimeout(beat.current);
    beat.current = null;
  };

  const handleError = useCallback((err: GeolocationPositionError) => {
    if (err.code === 1) {
      setState('denied');
      // PERMISSION_DENIED ends the watch.
      if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
      watching.current = false;
      clearBeat();
      releaseWakeLock();
    } else {
      setState('error');
    }
  }, [releaseWakeLock]);

  const armBeat = useCallback(() => {
    clearBeat();
    beat.current = setTimeout(() => {
      if (!watching.current) return;
      navigator.geolocation.getCurrentPosition(handlePosition, handleError, HEARTBEAT_OPTIONS);
      armBeat();
    }, WALKABOUT_HEARTBEAT_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- #5891 handlePosition is stable (ref-backed) and defined below
  }, [handleError]);

  function handlePosition(pos: GeolocationPosition) {
    setState('watching');
    setAccuracy(pos.coords.accuracy);
    armBeat();
    onFixRef.current({
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      timestamp: pos.timestamp,
    });
  }

  const stop = useCallback(() => {
    if (watchId.current != null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchId.current);
    }
    watchId.current = null;
    watching.current = false;
    clearBeat();
    releaseWakeLock();
    setState('idle');
  }, [releaseWakeLock]);

  const start = useCallback(() => {
    if (getGeolocationSupport() !== 'ok' || watching.current) return;
    watching.current = true;
    setState('watching');
    watchId.current = navigator.geolocation.watchPosition(handlePosition, handleError, POSITION_OPTIONS);
    armBeat();
    void requestWakeLock();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- #5891 handlePosition reads only refs and stable setters
  }, [armBeat, handleError, requestWakeLock]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt.current = Date.now();
        return;
      }
      if (hiddenAt.current != null) {
        const span = Date.now() - hiddenAt.current;
        hiddenAt.current = null;
        if (watching.current && span >= MIN_REPORTED_PAUSE_MS) setPausedMs(span);
      }
      if (watching.current) {
        // The browser drops the lock when the page hides; ask again.
        wakeSentinel.current = null;
        void requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [requestWakeLock]);

  // Unmount: stop everything.
  useEffect(() => stop, [stop]);

  return {
    support,
    state,
    accuracy,
    pausedMs,
    clearPaused: () => setPausedMs(null),
    wakeLockSupported: getWakeLock() != null,
    wakeLockActive,
    start,
    stop,
  };
}
