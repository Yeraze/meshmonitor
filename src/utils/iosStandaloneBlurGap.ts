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

/** iOS 26 froze the UA's `iPhone OS NN_N` token at 18, so 18+ may be any later release. */
const FROZEN_OS_TOKEN_VERSION = 18;

export function needsIosStandaloneBlurGap(nav: StandaloneNavigator): boolean {
  if (nav.standalone !== true) return false;
  // iOS web views report the OS release as Safari's `Version/NN` (the
  // `iPhone OS 18_7` token is frozen and no longer tracks the real version).
  const version = /Version\/(\d+)/.exec(nav.userAgent);
  if (version !== null) return Number(version[1]) >= FIRST_AFFECTED_VERSION;
  // Some home-screen apps drop the `Version/NN Safari/NNN` tokens (#5286: the
  // gap still missed on a reporter's iOS 27 app). Without them the release is
  // unknown, so assume the blur unless the OS token proves a pre-freeze iOS:
  // 20px of extra padding costs less than fogged header text.
  const os = /OS (\d+)_/.exec(nav.userAgent);
  return os === null || Number(os[1]) >= FROZEN_OS_TOKEN_VERSION;
}

export function applyIosStandaloneBlurGap(
  nav: StandaloneNavigator = navigator,
  root: HTMLElement = document.documentElement,
): void {
  root.classList.toggle(IOS_STANDALONE_BLUR_GAP_CLASS, needsIosStandaloneBlurGap(nav));
}
