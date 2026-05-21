import type { FocusEvent } from 'react';

/**
 * scrollInputIntoView — iOS Safari workaround (issue #2994).
 *
 * Attach as `onFocus` to any inline text input or textarea that lives
 * inside a scrollable page (the DM composer, channel composer, etc.).
 * When the iOS keyboard opens it overlays the layout viewport without
 * shrinking it, and Safari's auto-scroll-focused-input behavior
 * frequently leaves the input behind the InputAccessoryView bar.
 *
 * The fix: wait one frame for Safari to open the keyboard (so
 * `visualViewport.height` has shrunk), then `scrollIntoView` so the
 * input lands inside the visible area above the keyboard.
 *
 * A short `setTimeout` is used instead of `requestAnimationFrame`
 * because the keyboard animation is slower than a single frame on
 * older devices — 300ms is the documented iOS keyboard duration.
 *
 * No-op on desktop (the input is already visible).
 */
export function scrollInputIntoView(
  event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
): void {
  const target = event.currentTarget;
  // visualViewport is the proxy for "is this a mobile browser with a keyboard
  // that overlays content?". Desktop browsers don't trigger here, so we
  // avoid an unnecessary scrollIntoView jump on a focused field.
  if (typeof window === 'undefined' || !window.visualViewport) return;
  setTimeout(() => {
    // Re-check the element is still mounted and focused before scrolling.
    if (document.activeElement !== target) return;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 300);
}
