/**
 * Helpers for the admin-configured "default landing page" setting.
 *
 * The setting accepts one of two shapes:
 *   - A reserved string keyword from {@link RESERVED_LANDING_VALUES}
 *     identifying a built-in cross-source view.
 *   - A source UUID — the per-source dashboard at `/source/<id>/`.
 *
 * Reserved values map to fixed routes via {@link getReservedLandingPath}.
 * `'unified'` is the legacy keyword that means "stay on the unified
 * dashboard at `/`" (no redirect). Issue #3183 adds the cross-source
 * unified pages so they can be picked as the default landing.
 */

export const RESERVED_LANDING_VALUES = [
  'unified',
  'unified-messages',
  'unified-telemetry',
  'map-analysis',
  'reports',
] as const;

export type ReservedLandingValue = (typeof RESERVED_LANDING_VALUES)[number];

/**
 * Routes for each reserved landing value. `'unified'` returns `null`
 * because no redirect is needed — the unified dashboard already lives at
 * `/`. Source-id UUIDs (everything else) are handled separately by the
 * dashboard redirect effect.
 */
const RESERVED_LANDING_PATHS: Record<ReservedLandingValue, string | null> = {
  'unified': null,
  'unified-messages': '/unified/messages',
  'unified-telemetry': '/unified/telemetry',
  'map-analysis': '/analysis',
  'reports': '/reports',
};

export function isReservedLandingValue(value: unknown): value is ReservedLandingValue {
  return typeof value === 'string' && (RESERVED_LANDING_VALUES as readonly string[]).includes(value);
}

/**
 * Returns the redirect target for a reserved landing value, or `null` if
 * the value is `'unified'` (no redirect) or not a reserved value (caller
 * should treat it as a sourceId UUID and redirect to `/source/<id>/`).
 */
export function getReservedLandingPath(value: string | null | undefined): string | null {
  if (!isReservedLandingValue(value)) return null;
  return RESERVED_LANDING_PATHS[value];
}
