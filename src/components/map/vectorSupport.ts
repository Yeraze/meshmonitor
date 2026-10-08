import { useEffect, useId, useSyncExternalStore } from 'react';

/**
 * Can this browser draw the 2D vector basemap?
 *
 * MapLibre GL 6 needs a WebGL2 context. Without one `new maplibregl.Map()`
 * throws `GPUInitializationError`, and the Leaflet adapter is left half-added:
 * its move/zoom/resize handlers and `onRemove` then call into a GL map that
 * was never made. `BaseMap` reads this module to pick a raster tileset for the
 * render instead, and never touches the user's saved tileset.
 *
 * Two inputs feed the answer:
 *  - a one-off probe (a throwaway canvas), cached for the page's life;
 *  - a runtime flag, set when a real layer failed to build even though the
 *    probe passed (driver blocklist, no contexts left).
 */

let probeResult: boolean | null = null;
let runtimeFailed = false;
/** Test-only override. `null` means "use the real probe". */
let testOverride: boolean | null = null;

const NOTICE_DISMISSED_KEY = 'mm-vector-fallback-notice-dismissed';
let noticeDismissed: boolean | null = null;
/** The one map that shows the notice when several fall back at once. */
let noticeOwner: string | null = null;

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Uncached WebGL2 probe. Never throws. */
export function probeWebGl2(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
    if (!gl) return false;
    // Hand the context back at once: browsers cap live contexts per page.
    try {
      gl.getExtension?.('WEBGL_lose_context')?.loseContext();
    } catch {
      /* best effort */
    }
    return true;
  } catch {
    return false;
  }
}

/** True when a vector (MapLibre GL) basemap can be drawn right now. */
export function isVectorRenderingAvailable(): boolean {
  if (testOverride !== null) return testOverride;
  if (runtimeFailed) return false;
  if (probeResult === null) probeResult = probeWebGl2();
  return probeResult;
}

/**
 * Record that a vector layer failed to build although the probe passed. Every
 * map then falls back to raster until the page reloads.
 */
export function reportVectorRenderingFailure(): void {
  if (runtimeFailed) return;
  runtimeFailed = true;
  emit();
}

/** Reactive form of {@link isVectorRenderingAvailable}. */
export function useVectorRenderingAvailable(): boolean {
  return useSyncExternalStore(subscribe, isVectorRenderingAvailable, () => true);
}

function readNoticeDismissed(): boolean {
  if (noticeDismissed === null) {
    try {
      noticeDismissed = localStorage.getItem(NOTICE_DISMISSED_KEY) === '1';
    } catch {
      noticeDismissed = false;
    }
  }
  return noticeDismissed;
}

function dismissNotice(): void {
  noticeDismissed = true;
  try {
    localStorage.setItem(NOTICE_DISMISSED_KEY, '1');
  } catch {
    /* private mode: the notice stays dismissed for this page only */
  }
  emit();
}

const getNoticeOwner = () => noticeOwner;

/**
 * Should THIS map show the "raster shown in place of vector" notice?
 *
 * The notice appears on one map at a time (the first that fell back), and not
 * at all once the user has closed it; the choice is kept in localStorage.
 */
export function useVectorFallbackNotice(active: boolean): { show: boolean; dismiss: () => void } {
  const id = useId();
  const dismissed = useSyncExternalStore(subscribe, readNoticeDismissed, () => true);
  const owner = useSyncExternalStore(subscribe, getNoticeOwner, () => null);

  // Claim. `owner` is a dep so a waiting map claims the notice when the
  // current owner leaves. No cleanup here: releasing on an `owner` change
  // would hand the notice back the moment it was claimed.
  useEffect(() => {
    if (active && !dismissed && noticeOwner === null) {
      noticeOwner = id;
      emit();
    }
  }, [active, dismissed, id, owner]);

  // Release on unmount, or when this map stops falling back.
  useEffect(() => {
    if (!active || dismissed) return;
    return () => {
      if (noticeOwner === id) {
        noticeOwner = null;
        emit();
      }
    };
  }, [active, dismissed, id]);

  return { show: active && !dismissed && owner === id, dismiss: dismissNotice };
}

/**
 * Test hooks. jsdom has no WebGL, so `src/test/setup.ts` forces "available"
 * before each test: suites that render a vector tileset keep exercising the
 * vector branch. Pass `null` to run the real probe.
 */
export function setVectorRenderingForTests(value: boolean | null): void {
  testOverride = value;
  emit();
}

export function resetVectorSupportForTests(): void {
  probeResult = null;
  runtimeFailed = false;
  noticeDismissed = null;
  noticeOwner = null;
  emit();
}
