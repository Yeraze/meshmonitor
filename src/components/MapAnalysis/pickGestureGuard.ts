/**
 * Tells a real "pick this spot" click apart from the tail end of a map
 * gesture (#5959), for the pick-a-point tools (Link Profile, Site Planner).
 *
 * The tools listen for a native capture-phase `click` on the map container.
 * Leaflet suppresses its own `click` after a pan, but the native one still
 * fires when mousedown and mouseup land on the same element, so panning to
 * find point B could drop a stray point. A click counts as a gesture, and is
 * not a pick, when:
 *  - the pointer moved more than PICK_MOVE_TOLERANCE_PX since it went down
 *    (a pan),
 *  - a second pointer touched down during the gesture (a pinch zoom),
 *  - Shift was held (Leaflet's box zoom), or
 *  - Space is held: "navigate only", so the user can click and drag freely.
 */
import { useEffect, useRef } from 'react';
import type { Map as LeafletMap } from 'leaflet';

/** Movement (px) past which a press-and-release is a drag, not a click. */
export const PICK_MOVE_TOLERANCE_PX = 6;

export interface PickGestureGuard {
  /** True when this click ends a gesture and must not place a point. */
  isGesture(e: MouseEvent): boolean;
  /** True while Space is held (navigate-only mode). */
  isNavigating(): boolean;
  dispose(): void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return Boolean(el.closest('input, textarea, select, [contenteditable="true"]'));
}

/**
 * Track pointer and Space-key state for one map container. `onNavigateChange`
 * fires when Space goes down or up, so the caller can swap the cursor.
 */
export function attachPickGestureGuard(
  container: HTMLElement,
  onNavigateChange?: (navigating: boolean) => void,
): PickGestureGuard {
  const pointers = new Set<number>();
  let startX = 0;
  let startY = 0;
  let moved = 0;
  let multiTouch = false;
  let spaceHeld = false;

  const pointerId = (e: Event) => (e as PointerEvent).pointerId ?? 1;

  const onDown = (e: Event) => {
    const me = e as MouseEvent;
    if (pointers.size === 0) {
      startX = me.clientX;
      startY = me.clientY;
      moved = 0;
      multiTouch = false;
    }
    pointers.add(pointerId(e));
    if (pointers.size > 1) multiTouch = true;
  };
  const onMove = (e: Event) => {
    if (pointers.size === 0) return;
    const me = e as MouseEvent;
    moved = Math.max(moved, Math.hypot(me.clientX - startX, me.clientY - startY));
  };
  const onUp = (e: Event) => {
    pointers.delete(pointerId(e));
  };

  const setSpace = (held: boolean) => {
    if (spaceHeld === held) return;
    spaceHeld = held;
    onNavigateChange?.(held);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code !== 'Space' && e.key !== ' ') return;
    if (isTypingTarget(e.target)) return;
    // Space would otherwise scroll the page or press a focused button.
    e.preventDefault();
    setSpace(true);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code !== 'Space' && e.key !== ' ') return;
    setSpace(false);
  };
  const onBlur = () => setSpace(false);

  container.addEventListener('pointerdown', onDown, true);
  container.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onUp, true);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  return {
    isGesture: (e: MouseEvent) =>
      spaceHeld || e.shiftKey || multiTouch || moved > PICK_MOVE_TOLERANCE_PX,
    isNavigating: () => spaceHeld,
    dispose: () => {
      container.removeEventListener('pointerdown', onDown, true);
      container.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      if (spaceHeld) onNavigateChange?.(false);
    },
  };
}

/**
 * The guard for `map` while `enabled`, plus the pick cursor: a crosshair, or a
 * grab hand while Space is held. Restores the previous cursor on cleanup.
 */
export function usePickGestureGuard(map: LeafletMap, enabled: boolean) {
  const guardRef = useRef<PickGestureGuard | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const container = map.getContainer();
    const prev = container.style.cursor;
    container.style.cursor = 'crosshair';
    const guard = attachPickGestureGuard(container, (navigating) => {
      container.style.cursor = navigating ? 'grab' : 'crosshair';
    });
    guardRef.current = guard;
    return () => {
      guard.dispose();
      guardRef.current = null;
      container.style.cursor = prev;
    };
  }, [enabled, map]);
  return guardRef;
}
