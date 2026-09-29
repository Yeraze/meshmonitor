/**
 * A `react-i18next` test mock must hand out ONE `t` function, not a new one per
 * render.
 *
 * Real react-i18next keeps `t` stable, and components list it in `useEffect` /
 * `useCallback` deps. A mock like
 *
 *   vi.mock('react-i18next', () => ({
 *     useTranslation: () => ({ t: (key) => key }),
 *   }));
 *
 * builds a fresh `t` every time `useTranslation()` runs, so a data-loading
 * effect that depends on `t` re-runs on every render and loops. PR #5473 caught
 * one firing 373 requests in 300ms, with assertions racing a flickering
 * "Loading…" state under CI load.
 *
 * Use `createReactI18nextMock()` from `src/test/mockI18n.ts`, or hoist `t` to a
 * constant outside `useTranslation`.
 */

const MOCK_METHODS = new Set(['mock', 'doMock']);

function isI18nMockCall(node) {
  const callee = node.callee;
  if (callee?.type !== 'MemberExpression' || callee.object?.type !== 'Identifier' || callee.object.name !== 'vi') return false;
  const method = callee.property?.type === 'Identifier' ? callee.property.name : null;
  if (!MOCK_METHODS.has(method)) return false;
  const first = node.arguments[0];
  return first?.type === 'Literal' && first.value === 'react-i18next';
}

const isFunction = (node) => node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression';

function propName(prop) {
  if (prop.type !== 'Property' || prop.computed) return null;
  if (prop.key.type === 'Identifier') return prop.key.name;
  if (prop.key.type === 'Literal') return String(prop.key.value);
  return null;
}

/** Object literals a function returns: `() => ({...})` or `return {...}` at its top level. */
function returnedObjects(fn) {
  if (fn.body.type === 'ObjectExpression') return [fn.body];
  if (fn.body.type !== 'BlockStatement') return [];
  return fn.body.body
    .filter((stmt) => stmt.type === 'ReturnStatement' && stmt.argument?.type === 'ObjectExpression')
    .map((stmt) => stmt.argument);
}

/** Every `useTranslation: <fn>` property anywhere inside the factory. */
function findUseTranslationFns(node, found = []) {
  if (!node || typeof node.type !== 'string') return found;
  if (node.type === 'Property' && propName(node) === 'useTranslation' && isFunction(node.value)) {
    found.push(node.value);
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === 'parent') continue;
    if (Array.isArray(child)) child.forEach((c) => findUseTranslationFns(c, found));
    else if (child && typeof child === 'object') findUseTranslationFns(child, found);
  }
  return found;
}

/** The inline `t` function nodes a `react-i18next` mock factory creates per call. */
export function findInlineTFunctions(mockCall) {
  const factory = mockCall.arguments[1];
  if (!isFunction(factory)) return [];
  const hits = [];
  for (const useTranslation of findUseTranslationFns(factory.body)) {
    for (const obj of returnedObjects(useTranslation)) {
      for (const prop of obj.properties) {
        if (propName(prop) === 't' && isFunction(prop.value)) hits.push(prop.value);
      }
    }
  }
  return hits;
}

export const stableI18nMock = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid react-i18next mocks that build a new `t` on every useTranslation() call; real `t` is stable, and an unstable one loops effects that depend on it.',
    },
    schema: [],
    messages: {
      inlineT:
        "This react-i18next mock creates a new `t` on every useTranslation() call. Real `t` is stable; a fresh one re-runs every effect that lists `t` in its deps (PR #5473: 373 requests in 300ms). Use createReactI18nextMock() from src/test/mockI18n.ts, or hoist `t` to a constant.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isI18nMockCall(node)) return;
        for (const fn of findInlineTFunctions(node)) {
          context.report({ node: fn, messageId: 'inlineT' });
        }
      },
    };
  },
};
