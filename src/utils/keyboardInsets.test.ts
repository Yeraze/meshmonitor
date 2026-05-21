/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installKeyboardInsetsObserver, __resetKeyboardInsetsForTests } from './keyboardInsets';

describe('installKeyboardInsetsObserver', () => {
  beforeEach(() => {
    __resetKeyboardInsetsForTests();
    document.documentElement.removeAttribute('style');
  });

  it('sets --keyboard-inset to 0px when visualViewport matches innerHeight', () => {
    (window as any).visualViewport = {
      height: 800,
      offsetTop: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

    installKeyboardInsetsObserver();

    expect(document.documentElement.style.getPropertyValue('--keyboard-inset')).toBe('0px');
  });

  it('writes the delta when the visual viewport is smaller than the layout viewport', () => {
    (window as any).visualViewport = {
      height: 500,
      offsetTop: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

    installKeyboardInsetsObserver();

    expect(document.documentElement.style.getPropertyValue('--keyboard-inset')).toBe('300px');
  });

  it('clamps negative deltas to 0', () => {
    // Some browsers briefly report visualViewport.height > innerHeight during
    // orientation change. Don't let the CSS var go negative.
    (window as any).visualViewport = {
      height: 900,
      offsetTop: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

    installKeyboardInsetsObserver();

    expect(document.documentElement.style.getPropertyValue('--keyboard-inset')).toBe('0px');
  });

  it('subscribes to resize and scroll on the visual viewport', () => {
    const addEventListener = vi.fn();
    (window as any).visualViewport = {
      height: 800,
      offsetTop: 0,
      addEventListener,
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

    installKeyboardInsetsObserver();

    expect(addEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(addEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
  });

  it('only subscribes once across repeated calls', () => {
    const addEventListener = vi.fn();
    (window as any).visualViewport = {
      height: 800,
      offsetTop: 0,
      addEventListener,
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

    installKeyboardInsetsObserver();
    installKeyboardInsetsObserver();
    installKeyboardInsetsObserver();

    // First call registers resize + scroll once each. Second/third are no-ops.
    expect(addEventListener).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when visualViewport is unavailable', () => {
    (window as any).visualViewport = undefined;
    expect(() => installKeyboardInsetsObserver()).not.toThrow();
    expect(document.documentElement.style.getPropertyValue('--keyboard-inset')).toBe('');
  });
});
