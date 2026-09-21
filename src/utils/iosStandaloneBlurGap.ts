/**
 * iOS 27 home-screen web apps draw a system blur over the top ~20px below the
 * safe area, whatever the page paints there, which fogs the header text
 * (#5286). A Safari tab does not. This flags the root element so the
 * `--status-bar-blur-gap` token in App.css pushes the top bars' contents below
 * the blur.
 *
 * Detected in JS because the `(display-mode: standalone)` media query reports
 * false in an iOS 27 home-screen app (measured on-device), while
 * `navigator.standalone` reports true.
 */

export const IOS_STANDALONE_BLUR_GAP_CLASS = 'ios-standalone-blur-gap';

/** First iOS/Safari major version that draws the blur. 26 did not. */
const FIRST_AFFECTED_VERSION = 27;

interface StandaloneNavigator {
  standalone?: boolean;
  userAgent: string;
}

export function needsIosStandaloneBlurGap(nav: StandaloneNavigator): boolean {
  if (nav.standalone !== true) return false;
  // iOS web views report the OS release as Safari's `Version/NN` (the
  // `iPhone OS 18_7` token is frozen and no longer tracks the real version).
  const match = /Version\/(\d+)/.exec(nav.userAgent);
  return match !== null && Number(match[1]) >= FIRST_AFFECTED_VERSION;
}

export function applyIosStandaloneBlurGap(
  nav: StandaloneNavigator = navigator,
  root: HTMLElement = document.documentElement,
): void {
  root.classList.toggle(IOS_STANDALONE_BLUR_GAP_CLASS, needsIosStandaloneBlurGap(nav));
}
