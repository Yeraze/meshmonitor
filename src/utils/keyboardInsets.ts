/**
 * useKeyboardInsets — install a single `visualViewport` listener that
 * publishes the on-screen keyboard's pixel height (plus iOS Safari's
 * "InputAccessoryView" bar above it) as a `--keyboard-inset` CSS custom
 * property on `document.documentElement`.
 *
 * Background — issue #2994:
 *   On iOS Safari the keyboard (and its arrows + Done accessory bar)
 *   overlay the layout viewport without changing `window.innerHeight`.
 *   Anything pinned near the bottom of the page — message composer,
 *   modal action rows, login form — ends up under the keyboard.
 *
 *   `window.visualViewport.height` *does* shrink when the keyboard
 *   opens, so the keyboard's effective height is:
 *
 *     keyboardInset = window.innerHeight - visualViewport.height - visualViewport.offsetTop
 *
 *   We expose that delta as a CSS variable so plain CSS (modal bodies,
 *   the messages composer) can lift itself with
 *   `padding-bottom: var(--keyboard-inset, 0px)` without each
 *   component needing its own listener.
 *
 * Cross-browser:
 *   - Browsers without `visualViewport` (very old Safari, some embedded
 *     WebViews) get `--keyboard-inset: 0px` and behave as before.
 *   - On desktop browsers `visualViewport.height === window.innerHeight`
 *     so the value is always 0; no visible effect.
 *   - PWA mode is the same as Safari for this purpose.
 *
 * Idempotent — safe to call from multiple route roots (App + DashboardPage
 * + GlobalSettingsPage are mounted independently and may each call it).
 */

let installed = false;

export function installKeyboardInsetsObserver(): void {
  if (installed) return;
  if (typeof window === 'undefined') return;
  const vv = window.visualViewport;
  if (!vv) return;
  installed = true;

  const root = document.documentElement;

  const update = (): void => {
    // Offset for when the user has scrolled inside the visual viewport
    // (pinch-zoom or keyboard partially pushed offscreen).
    const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    root.style.setProperty('--keyboard-inset', `${Math.round(inset)}px`);
  };

  // Run once so the variable exists even before the keyboard opens —
  // CSS that uses `var(--keyboard-inset, 0px)` works either way, but
  // some callers prefer to read the computed style.
  update();
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
}

/** Test-only: reset the installed flag so `installKeyboardInsetsObserver`
 * can be exercised across multiple vitest cases without re-importing the
 * module. Not part of the public API. */
export function __resetKeyboardInsetsForTests(): void {
  installed = false;
}
