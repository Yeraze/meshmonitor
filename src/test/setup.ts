import { expect, afterEach, afterAll, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';
import { resetVectorSupportForTests, setVectorRenderingForTests } from '../components/map/vectorSupport';
import { waitForBackgroundTasks } from '../utils/backgroundTasks';

// Extends Vitest's expect method with methods from react-testing-library
expect.extend(matchers);

// Let fire-and-forget work (DatabaseService's startup user checks, "new node"
// notifications) settle before Vitest tears this file down. Otherwise its
// dynamic imports and log lines land after teardown, leave an
// `onUserConsoleLog` RPC pending, and fail the run with an
// EnvironmentTeardownError even though every test passed.
afterAll(() => waitForBackgroundTasks());

// Mock react-i18next for tests. `t` returns the key (with {{var}} filled from
// an options object). It keeps one identity across renders, as the real hook
// does; see src/test/mockI18n.ts for why that matters.
vi.mock('react-i18next', async () => {
  const { createReactI18nextMock, keyT } = await import('./mockI18n');
  return createReactI18nextMock(keyT);
});

// jsdom has no WebGL, so the real probe in `vectorSupport.ts` would report
// "no vector maps" and every suite that renders a vector tileset would
// quietly test the raster fallback in its place. Default to "available" so
// those suites keep exercising the vector branch (with their own MapLibre
// mocks). A test of the fallback calls `setVectorRenderingForTests(null)` to
// run the real probe, or `(false)` to force it off.
beforeEach(() => {
  resetVectorSupportForTests();
  setVectorRenderingForTests(true);
});

// Runs a cleanup after each test case (e.g., clearing jsdom)
afterEach(() => {
  cleanup();
});

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value.toString();
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    length: 0,
    key: vi.fn((_index: number) => null),
  };
})();

Object.defineProperty(global, 'localStorage', {
  value: localStorageMock,
});

// Mock window.matchMedia for tests
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(query => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// Mock emoji-picker-react so tests don't depend on the full Unicode dataset.
vi.mock('emoji-picker-react', () => {
  const React = require('react');
  const Picker = ({ onEmojiClick }: { onEmojiClick?: (e: { emoji: string }) => void }) => {
    return React.createElement(
      'div',
      { 'data-testid': 'emoji-picker-mock' },
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'mock-emoji-thumbs-up',
          onClick: () => onEmojiClick?.({ emoji: '👍' }),
        },
        '👍'
      )
    );
  };
  return {
    __esModule: true,
    default: Picker,
    Theme: { LIGHT: 'light', DARK: 'dark', AUTO: 'auto' },
    EmojiStyle: { NATIVE: 'native' },
  };
});