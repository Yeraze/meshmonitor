/**
 * Per-node color derivation (issue #4880).
 *
 * Two independent coloring schemes plus the monochrome default, exposed through
 * a single {@link nodeColorStyle} entry point so every display surface (Nodes
 * tab, Messages node boxes, channel message bubbles, map popup NodeCard, and the
 * official map pin) colors a node the same way.
 *
 * 1. **meshtastic** — matches the official Meshtastic Android/iOS apps: the node
 *    color is the low 24 bits of the uint32 `nodeNum` taken straight as RGB (i.e.
 *    the last 6 hex digits of the `!xxxxxxxx` node id). Identical across both
 *    apps. The apps then pick a black-or-white foreground from the background's
 *    luminance; we do the same via {@link readableTextColor} so the label stays
 *    legible on any generated color.
 *
 * 2. **importance** — the reporter's request (kokoshell, #4880): vivid for
 *    direct/favorite nodes, progressively faded for more distant hops, in fixed
 *    tiers. Encodes *distance/importance*, not node identity.
 *
 * Presentation-only: no packets, no timers, no mesh impact.
 */

export type NodeListStyle = 'monochrome' | 'meshtastic' | 'importance';

export interface NodeColorInput {
  /** uint32 node number. Required for the meshtastic scheme. */
  nodeNum: number;
  /** Hops away (0 = direct). `undefined`/`999` = unknown. Used by importance. */
  hopsAway?: number;
  /** Whether the node is favorited. Used by importance. */
  isFavorite?: boolean;
}

/**
 * Resolved color overrides for a node card/pin. Any field left `undefined` means
 * "inherit the theme default" — monochrome returns an empty object so callers
 * apply nothing.
 */
export interface NodeColorResult {
  /** Background fill (`#rrggbb`), or undefined to keep the theme surface. */
  background?: string;
  /** Foreground text color chosen for contrast against `background`. */
  text?: string;
}

const HEX6 = /^#?[0-9a-fA-F]{6}$/;

/**
 * The Meshtastic app node color: low 24 bits of the uint32 node number as RGB.
 * `nodeNum` is coerced to unsigned so negative signed-32-bit inputs (PG/MySQL
 * BIGINT round-trips) still map to the correct color.
 */
export function meshtasticNodeColor(nodeNum: number): string {
  const rgb = (nodeNum >>> 0) & 0xffffff;
  return '#' + rgb.toString(16).padStart(6, '0');
}

/** Parse `#rrggbb` (or `rrggbb`) into 0–255 channels. Returns null if malformed. */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  if (!HEX6.test(hex)) return null;
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/**
 * WCAG relative luminance (0–1) of an `#rrggbb` color. Malformed input returns
 * 0 (treated as dark → white text), which is a safe, legible fallback.
 */
export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/**
 * Pick black or white text for maximum readability on a background color. The
 * 0.179 threshold matches the Apple app's `Color.isLight()` (WCAG relative
 * luminance); Android uses a BT.601 luma cutoff that agrees for the vast
 * majority of colors.
 */
export function readableTextColor(background: string): '#000000' | '#ffffff' {
  return relativeLuminance(background) > 0.179 ? '#000000' : '#ffffff';
}

/**
 * Importance tier for a node. Favorites always sort to `favorite` regardless of
 * distance so they stay prominent; otherwise the tier is a fixed hop bucket.
 */
export type ImportanceTier = 'favorite' | 'direct' | 'near' | 'far' | 'unknown';

export function importanceTier(hopsAway: number | undefined, isFavorite: boolean): ImportanceTier {
  if (isFavorite) return 'favorite';
  if (hopsAway == null || hopsAway === 999) return 'unknown';
  if (hopsAway <= 0) return 'direct';
  if (hopsAway <= 2) return 'near';
  return 'far';
}

/**
 * Background color per importance tier — vivid for favorite/direct, muted for
 * distant, matching the reporter's "vivid vs pale/faded" ask. These are
 * data-encoding colors (they mean the same in every theme), consistent with the
 * existing hardcoded `getHopColor` ramp.
 */
const IMPORTANCE_BACKGROUND: Record<ImportanceTier, string> = {
  favorite: '#f5a623', // amber — stands out independent of hop distance
  direct: '#22c55e', // vivid green (same "local" green as getHopColor)
  near: '#3b82f6', // blue — a couple hops out
  far: '#64748b', // muted slate — distant
  unknown: '#94a3b8', // neutral grey — no hop data
};

/**
 * Resolve the color overrides for a node under the given list style. Callers
 * spread the result onto a card/pin: monochrome yields `{}` (no change), the
 * other two yield a `background` + luminance-picked `text`.
 */
export function nodeColorStyle(style: NodeListStyle, input: NodeColorInput): NodeColorResult {
  if (style === 'meshtastic') {
    // No usable node number (e.g. a MeshCore contact, or a popup built without
    // one) → no color, so the surface keeps its theme default rather than
    // rendering the all-zero #000000 fallback.
    if (!Number.isFinite(input.nodeNum)) return {};
    const background = meshtasticNodeColor(input.nodeNum);
    return { background, text: readableTextColor(background) };
  }
  if (style === 'importance') {
    const tier = importanceTier(input.hopsAway, input.isFavorite ?? false);
    const background = IMPORTANCE_BACKGROUND[tier];
    return { background, text: readableTextColor(background) };
  }
  return {};
}
