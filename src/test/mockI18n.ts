/**
 * Shared, identity-stable `react-i18next` mock for Vitest.
 *
 * WHY THIS EXISTS
 * Real react-i18next hands every render the SAME `t` function. Components lean
 * on that: they list `t` in `useEffect` / `useCallback` deps. A mock written as
 *
 *   vi.mock('react-i18next', () => ({
 *     useTranslation: () => ({ t: (key) => key }),   // new `t` per call!
 *   }));
 *
 * builds a fresh `t` on every render, so any effect that depends on `t` re-runs
 * on every render. When that effect loads data and sets state, it loops: PR
 * #5473 caught one firing 373 config requests in 300ms, with assertions racing
 * a "Loading…" state that flickered in and out under CI load.
 *
 * Every `t` below is a module-level constant, and `createReactI18nextMock`
 * builds one `useTranslation()` result per mock and returns it on every call.
 *
 * USAGE (vi.mock factories are hoisted, so import the helper inside):
 *
 *   vi.mock('react-i18next', async () => {
 *     const { createReactI18nextMock } = await import('../../test/mockI18n');
 *     return createReactI18nextMock();            // mockT: fallback + {{vars}}
 *   });
 *
 * A test that needs different text can pass its own `t`, which the factory
 * creates once, so it stays stable too:
 *
 *   return createReactI18nextMock((key: string) => `<${key}>`);
 *
 * The ESLint rule `meshmonitor-ui/stable-i18n-mock`
 * (`scripts/eslint-rules/stable-i18n-mock.mjs`, enforced by `npm run lint:ci`)
 * rejects a `react-i18next` mock that builds `t` inline inside `useTranslation`.
 */
import { vi } from 'vitest';
import type { ReactNode } from 'react';

type Vars = Record<string, unknown>;

/**
 * Any `t` a test might supply. Parameters are `never` so that narrower local
 * signatures such as `(key: string, fallback?: string) => string` still fit.
 */
export type MockTFunction = (key: string, ...args: never[]) => unknown;

function interpolate(text: string, vars: Vars | undefined): string {
  if (!vars) return text;
  return text.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

/**
 * Default `t`: returns the fallback text a component passes, else the key.
 *
 * Accepts both i18next call shapes:
 *   t(key, 'Fallback {{n}}', { n: 1 })          → 'Fallback 1'
 *   t(key, { defaultValue: 'Fallback {{n}}', n }) → 'Fallback 1'
 *   t(key) / t(key, { n: 1 })                    → key
 * `{{name}}` placeholders fill from the options object; a placeholder with no
 * matching option stays as written.
 */
export const mockT = (key: string, arg2?: string | Vars, arg3?: Vars): string => {
  const vars = typeof arg2 === 'object' && arg2 !== null ? arg2 : arg3;
  const fallback =
    typeof arg2 === 'string'
      ? arg2
      : typeof vars?.defaultValue === 'string'
        ? vars.defaultValue
        : undefined;
  return interpolate(fallback ?? key, vars);
};

/**
 * Key-only `t` used by the global mock in `src/test/setup.ts`: returns the key,
 * filling `{{name}}` from an options object (keys rarely carry placeholders).
 */
export const keyT = (key: string, options?: unknown): string =>
  typeof options === 'object' && options !== null ? interpolate(key, options as Vars) : key;

/** Shared `i18n` instance stub. */
export const mockI18n = {
  language: 'en',
  changeLanguage: vi.fn(),
};

/**
 * Build a `react-i18next` module mock whose `useTranslation()` returns the
 * same object, and so the same `t`, on every call.
 *
 * @param t      the `t` to hand out; defaults to {@link mockT}.
 * @param extra  exports to add or override (e.g. a custom `Trans`).
 */
export function createReactI18nextMock(
  t: MockTFunction = mockT,
  extra: Record<string, unknown> = {},
) {
  const translation = { t, i18n: mockI18n, ready: true };
  return {
    useTranslation: () => translation,
    Trans: ({ children }: { children?: ReactNode }) => children,
    initReactI18next: { type: '3rdParty', init: vi.fn() },
    ...extra,
  };
}
