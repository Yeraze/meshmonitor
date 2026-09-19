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
const IOS_26_UA = IOS_27_UA.replace('Version/27.0', 'Version/26.4');

describe('needsIosStandaloneBlurGap (#5286)', () => {
  it('is true for an iOS 27 home-screen app', () => {
    expect(needsIosStandaloneBlurGap({ standalone: true, userAgent: IOS_27_UA })).toBe(true);
  });

  it('is false in a Safari tab on iOS 27', () => {
    expect(needsIosStandaloneBlurGap({ standalone: false, userAgent: IOS_27_UA })).toBe(false);
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
