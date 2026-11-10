/**
 * The `t()` shape that plain helpers (validators, formatters, model code) take
 * so they can be called with react-i18next's `t` or with a stub in tests.
 *
 * Written as a union of two fixed argument lists, not `(key, options?) => string`:
 * since i18next 27, `TFunction` takes its arguments as a union of fixed tuples,
 * and a signature with an optional second parameter is not assignable from it.
 * Callers holding options that may be `undefined` pass `options ?? {}`.
 */
export type TranslateFn = (
  ...args:
    | [key: string]
    | [key: string, options: Record<string, unknown>]
    | [key: string, defaultValue: string]
) => string;
