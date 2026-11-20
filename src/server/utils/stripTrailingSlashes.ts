/**
 * Linear-time trailing-slash strip. Replaces `.replace(/\/+$/, '')`, which
 * CodeQL flags as polynomial-ReDoS on user-controlled input
 * (js/polynomial-redos). Shared by the mqtt_bridge topic rewriter and the
 * source-route validator so the two always normalize prefixes the same way.
 */
export function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x2f) end--;
  return end === s.length ? s : s.slice(0, end);
}
