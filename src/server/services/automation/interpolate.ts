/**
 * `{{ path }}` template interpolation (#3653, §5.1/§5.2).
 *
 * Pure helper used by action params: replaces each `{{ path }}` token with the
 * value returned by `lookup(path)`. Unknown/undefined/null paths render as the
 * empty string (never throw — a missing field must not break an automation).
 * The path namespaces (`trigger.*`, `var.*`, system vars) are resolved by the
 * caller's `lookup`, keeping this function context-free.
 */

export type InterpolationValue = string | number | boolean | null | undefined;
export type InterpolationLookup = (path: string) => InterpolationValue;

const TOKEN = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Replace all `{{ path }}` tokens in `template`. */
export function interpolate(template: string, lookup: InterpolationLookup): string {
  if (typeof template !== 'string' || template.indexOf('{{') === -1) return template;
  return template.replace(TOKEN, (_match, rawPath: string) => {
    const path = rawPath.trim();
    if (path.length === 0) return '';
    let value: InterpolationValue;
    try {
      value = lookup(path);
    } catch {
      value = undefined;
    }
    return value == null ? '' : String(value);
  });
}

/** List the distinct paths referenced by `{{ }}` tokens in a template. */
export function extractPaths(template: string): string[] {
  if (typeof template !== 'string') return [];
  const paths = new Set<string>();
  for (const m of template.matchAll(TOKEN)) {
    const p = m[1].trim();
    if (p) paths.add(p);
  }
  return [...paths];
}
