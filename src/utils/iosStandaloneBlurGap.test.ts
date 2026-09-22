/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import {
  needsIosStandaloneBlurGap,
  applyIosStandaloneBlurGap,
  IOS_STANDALONE_BLUR_GAP_CLASS,
} from './iosStandaloneBlurGap';

// Captured from an iOS 27 home-screen web app (#5286).
const IOS_27_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1';
// Written out rather than derived from the string above: a `.replace()` that
// stops matching would silently produce a UA that proves nothing.
const IOS_26_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Mobile/15E148 Safari/604.1';
const IOS_28_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/28.0 Mobile/15E148 Safari/604.1';

// Home-screen apps can omit `Version/NN ... Safari/NNN`, leaving only the
// frozen OS token (#5286, rc1 report).
const NO_VERSION_FROZEN_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const NO_VERSION_IOS_17_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

describe('needsIosStandaloneBlurGap (#5286)', () => {
  it('is true for a home-screen app whose UA omits Version/NN behind the frozen OS token', () => {
    expect(needsIosStandaloneBlurGap({ standalone: true, userAgent: NO_VERSION_FROZEN_UA })).toBe(true);
  });

  it('is false for a home-screen app on a pre-freeze iOS that omits Version/NN', () => {
    expect(needsIosStandaloneBlurGap({ standalone: true, userAgent: NO_VERSION_IOS_17_UA })).toBe(false);
  });

  it('is true for a home-screen app whose UA carries neither Version/NN nor an OS token', () => {
    expect(needsIosStandaloneBlurGap({ standalone: true, userAgent: 'Mozilla/5.0 AppleWebKit/605.1.15' })).toBe(true);
  });

  it('is false in a Safari tab even when the UA omits Version/NN', () => {
    expect(needsIosStandaloneBlurGap({ standalone: false, userAgent: NO_VERSION_FROZEN_UA })).toBe(false);
  });

  it('is true for an iOS 27 home-screen app', () => {
    expect(needsIosStandaloneBlurGap({ standalone: true, userAgent: IOS_27_UA })).toBe(true);
  });

  it('is false in a Safari tab on iOS 27', () => {
    expect(needsIosStandaloneBlurGap({ standalone: false, userAgent: IOS_27_UA })).toBe(false);
  });

  it('is true for a later iOS, which keeps the blur until Apple removes it', () => {
    expect(needsIosStandaloneBlurGap({ standalone: true, userAgent: IOS_28_UA })).toBe(true);
  });

  it('is false for an iOS 26 home-screen app, which has no blur', () => {
    expect(needsIosStandaloneBlurGap({ standalone: true, userAgent: IOS_26_UA })).toBe(false);
  });

  it('is false for browsers that do not expose navigator.standalone', () => {
    expect(needsIosStandaloneBlurGap({ userAgent: IOS_27_UA })).toBe(false);
  });
});

describe('applyIosStandaloneBlurGap', () => {
  it('adds the class when needed and removes it otherwise', () => {
    const root = document.createElement('html');
    applyIosStandaloneBlurGap({ standalone: true, userAgent: IOS_27_UA }, root);
    expect(root.classList.contains(IOS_STANDALONE_BLUR_GAP_CLASS)).toBe(true);
    applyIosStandaloneBlurGap({ standalone: false, userAgent: IOS_27_UA }, root);
    expect(root.classList.contains(IOS_STANDALONE_BLUR_GAP_CLASS)).toBe(false);
  });
});
