// @vitest-environment jsdom
/**
 * #4774 regression: the mobile bottom bar must publish its REAL rendered height
 * so the search modal overlay docks above the actual nav rather than a static
 * 56px estimate. When the nav was taller than the estimate (safe-area inset,
 * large system text, or the expanded state) the overlay (which outranks the nav
 * in z-index) covered the nav's top strip and swallowed its taps: the nav was
 * visible but not clickable until the modal was closed.
 *
 * These cover both halves:
 *   - the publisher (SourceNav sets --source-nav-bar-height to offsetHeight when
 *     it is the bottom bar, and removes it otherwise / on unmount), and
 *   - the consumer (SearchModal.css reads that variable for the overlay bottom).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, cleanup } from '@testing-library/react';
import { SourceNav, type SourceNavSection } from './SourceNav';

const sections: SourceNavSection[] = [
  { items: [{ id: 'nodes', label: 'Nodes', icon: 'nodes', onClick: () => {} }] },
];

const PROP = '--source-nav-bar-height';

/** Capture the ResizeObserver callback so the test can drive a "resize". */
let roCallback: (() => void) | null = null;

function setViewportMatches(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

beforeEach(() => {
  roCallback = null;
  // Minimal ResizeObserver stub: remember the callback, no auto-fire.
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(cb: () => void) {
      roCallback = cb;
    }
    observe() {}
    disconnect() {}
  };
  document.documentElement.style.removeProperty(PROP);
});

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty(PROP);
  delete (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver;
});

describe('SourceNav publishes its measured bottom-bar height (#4774)', () => {
  it('sets --source-nav-bar-height to the real offsetHeight when it is the bottom bar', () => {
    setViewportMatches(true); // below the 768px breakpoint
    const { container } = render(
      <SourceNav sections={sections} activeId="nodes" collapsed mobileVariant="bottom-bar" />,
    );
    const nav = container.querySelector('[data-source-nav]') as HTMLElement;
    expect(nav).toBeTruthy();
    // jsdom does no layout, so force a realistic height that exceeds the 56px
    // static estimate — this is exactly the condition that caused the overlap.
    Object.defineProperty(nav, 'offsetHeight', { configurable: true, value: 72 });

    // A resize (rotation, tab-set change) is what re-measures on a real device.
    roCallback?.();

    expect(document.documentElement.style.getPropertyValue(PROP)).toBe('72px');
  });

  it('does NOT publish when the viewport is above the bottom-bar breakpoint', () => {
    setViewportMatches(false); // desktop / rail layout
    const { container } = render(
      <SourceNav sections={sections} activeId="nodes" collapsed mobileVariant="bottom-bar" />,
    );
    const nav = container.querySelector('[data-source-nav]') as HTMLElement;
    Object.defineProperty(nav, 'offsetHeight', { configurable: true, value: 500 });
    roCallback?.();

    expect(document.documentElement.style.getPropertyValue(PROP)).toBe('');
  });

  it('does NOT publish for the rail variant even on a narrow viewport', () => {
    setViewportMatches(true);
    const { container } = render(
      <SourceNav sections={sections} activeId="nodes" collapsed mobileVariant="rail" />,
    );
    const nav = container.querySelector('[data-source-nav]') as HTMLElement;
    Object.defineProperty(nav, 'offsetHeight', { configurable: true, value: 500 });
    roCallback?.();

    expect(document.documentElement.style.getPropertyValue(PROP)).toBe('');
  });

  it('removes the property on unmount so a stale value cannot linger', () => {
    setViewportMatches(true);
    const { container, unmount } = render(
      <SourceNav sections={sections} activeId="nodes" collapsed mobileVariant="bottom-bar" />,
    );
    const nav = container.querySelector('[data-source-nav]') as HTMLElement;
    Object.defineProperty(nav, 'offsetHeight', { configurable: true, value: 60 });
    roCallback?.();
    expect(document.documentElement.style.getPropertyValue(PROP)).toBe('60px');

    unmount();
    expect(document.documentElement.style.getPropertyValue(PROP)).toBe('');
  });

  it('clears the property when the viewport crosses out of the bottom-bar breakpoint mid-mount', () => {
    // Drive the matchMedia 'change' path directly: a phone rotated to a wide
    // landscape (or a resized window) toggles matches without a ResizeObserver
    // fire, and the published height must be withdrawn.
    let matches = true;
    const changeListeners: Array<() => void> = [];
    const mql = {
      get matches() {
        return matches;
      },
      media: '',
      onchange: null,
      addEventListener: (ev: string, cb: () => void) => {
        if (ev === 'change') changeListeners.push(cb);
      },
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn(() => mql) });

    const { container } = render(
      <SourceNav sections={sections} activeId="nodes" collapsed mobileVariant="bottom-bar" />,
    );
    const nav = container.querySelector('[data-source-nav]') as HTMLElement;
    Object.defineProperty(nav, 'offsetHeight', { configurable: true, value: 64 });
    roCallback?.();
    expect(document.documentElement.style.getPropertyValue(PROP)).toBe('64px');

    // Viewport widens past the breakpoint: matches flips and the mq fires.
    matches = false;
    changeListeners.forEach(cb => cb());
    expect(document.documentElement.style.getPropertyValue(PROP)).toBe('');
  });
});

describe('SearchModal overlay consumes the published nav height (#4774)', () => {
  const css = readFileSync(resolve('src/components/SearchModal/SearchModal.css'), 'utf-8');

  it('the mobile overlay bottom reads --source-nav-bar-height with the static fallback', () => {
    const mobile = css.slice(css.indexOf('@media (max-width: 768px)'));
    const m = mobile.match(/\.search-modal-overlay\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    const bottom = m![1].match(/bottom:\s*([^;]+)/)?.[1].replace(/\s+/g, ' ').trim();
    expect(bottom).toBeDefined();
    // Real measured height first, static estimate only as fallback.
    expect(bottom).toMatch(/var\(\s*--source-nav-bar-height/);
    expect(bottom).toMatch(/--app-nav-bar-height/); // fallback preserved
  });
});
