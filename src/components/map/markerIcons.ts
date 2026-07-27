import L from 'leaflet';
import { isEmoji } from '../../utils/text';
import { categoryGlyphFamily, type NodeTypeCategory } from '../../utils/nodeTypeCategory';

/**
 * Inner SVG markup for a node-type role glyph, drawn inside the 48×48 viewBox
 * over a white background circle (issue #3546). Returns '' for 'standard' so
 * callers fall back to the default pin/circle. `color` is the hop color so the
 * glyph stays consistent with the marker's stroke.
 *
 * Meshtastic role categories (issue #3610) reuse the MeshCore glyph silhouettes
 * via {@link categoryGlyphFamily} (a ROUTER draws as a repeater tower, etc.).
 */
/**
 * The repeater/router tower silhouette (tower + signal waves), shared by the
 * `'repeater'` glyph family and the ROUTER_LATE variant (issue #4295). Drawn in
 * the 48×48 role-glyph viewBox.
 */
function repeaterTowerSvg(color: string): string {
  return `
        <rect x="19" y="32" width="10" height="12" fill="#555" />
        <rect x="21" y="16" width="6" height="16" fill="#555" />
        <rect x="22.5" y="4" width="3" height="12" fill="#555" />
        <circle cx="24" cy="4" r="3" fill="${color}" />
        <path d="M 16 20 C 12 20 8 23 8 26" stroke="${color}" stroke-width="3" fill="none" />
        <path d="M 18 24 C 15 24 12 25 12 26" stroke="${color}" stroke-width="3" fill="none" />
        <path d="M 32 20 C 36 20 40 23 40 26" stroke="${color}" stroke-width="3" fill="none" />
        <path d="M 30 24 C 33 24 36 25 36 26" stroke="${color}" stroke-width="3" fill="none" />`;
}

/**
 * "Unmessageable" corner badge: the lucide `Ban` mark (the same icon the
 * NodesTab list uses for the `blocked` state) drawn on a white disc so it reads
 * over any hop color. Signals a node that reports itself as unable to receive
 * direct messages (issue #4295, deferred from #3684). Muted red keeps the
 * "no" semantic without matching the 6+-hop marker red exactly.
 */
function unmessageableBadgeSvg(size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">`
    + `<circle cx="12" cy="12" r="11" fill="white" fill-opacity="0.95" />`
    + `<circle cx="12" cy="12" r="9" fill="none" stroke="#d64545" stroke-width="2" />`
    + `<path d="M 5.6 5.6 L 18.4 18.4" stroke="#d64545" stroke-width="2" stroke-linecap="round" />`
    + `</svg>`;
}

export function roleGlyphInnerSvg(category: NodeTypeCategory, color: string): string {
  // ROUTER_LATE shares the repeater-tower silhouette (it IS infrastructure) but
  // gets a small clock badge marking its delayed / lower-priority rebroadcast
  // window, so it reads distinctly from a plain ROUTER (issue #4295). The badge
  // sits in the lower-left, clear of the tower base and the right-side waves.
  if (category === 'mtRouterLate') {
    return repeaterTowerSvg(color)
      + `\n        <circle cx="13" cy="34" r="6.5" fill="white" stroke="${color}" stroke-width="2" />`
      + `\n        <path d="M 13 34 L 13 30" stroke="${color}" stroke-width="1.6" stroke-linecap="round" />`
      + `\n        <path d="M 13 34 L 15.6 35.6" stroke="${color}" stroke-width="1.6" stroke-linecap="round" />`;
  }
  switch (categoryGlyphFamily(category)) {
    case 'repeater':
      // Tower with signal waves — the existing router silhouette, overflows
      // the circle so backbone nodes read at a glance.
      return repeaterTowerSvg(color);
    case 'roomServer':
      // Stacked server rack with status LEDs.
      return `
        <rect x="15" y="14" width="18" height="7" rx="1.5" fill="${color}" />
        <rect x="15" y="23" width="18" height="7" rx="1.5" fill="${color}" />
        <circle cx="19" cy="17.5" r="1.4" fill="white" />
        <circle cx="19" cy="26.5" r="1.4" fill="white" />
        <rect x="23" y="16.5" width="7" height="2" rx="1" fill="white" />
        <rect x="23" y="25.5" width="7" height="2" rx="1" fill="white" />`;
    case 'sensor':
      // Broadcasting dot with concentric waves.
      return `
        <circle cx="24" cy="24" r="3" fill="${color}" />
        <path d="M 18 24 A 6 6 0 0 1 30 24" stroke="${color}" stroke-width="2" fill="none" />
        <path d="M 14 24 A 10 10 0 0 1 34 24" stroke="${color}" stroke-width="2" fill="none" />
        <path d="M 30 24 A 6 6 0 0 1 18 24" stroke="${color}" stroke-width="2" fill="none" />
        <path d="M 34 24 A 10 10 0 0 1 14 24" stroke="${color}" stroke-width="2" fill="none" />`;
    case 'companion':
      // Person silhouette (handheld/end-user node).
      return `
        <circle cx="24" cy="18" r="4.5" fill="${color}" />
        <path d="M 15 33 C 15 25 33 25 33 33 Z" fill="${color}" />`;
    default:
      return '';
  }
}

/**
 * Standalone role-glyph marker: the node-type glyph ({@link roleGlyphInnerSvg})
 * drawn over a white background circle, as a complete `<svg>` string sized to
 * `size`px. Used by maps that render their own markers (e.g. the MeshCore
 * source map) and by the legend swatches, so the glyph stays identical to the
 * one `createNodeIcon`'s official style produces. Returns '' for 'standard'
 * (and unknown categories) so callers fall back to their default marker.
 */
export function roleGlyphMarkerSvg(
  category: NodeTypeCategory,
  color: string,
  size = 24,
): string {
  const inner = roleGlyphInnerSvg(category, color);
  if (!inner) return '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">`
    + `<circle cx="24" cy="24" r="20" fill="white" fill-opacity="0.95" stroke="${color}" stroke-width="2" />`
    + `${inner}</svg>`;
}

/**
 * Get color based on hop count
 * Uses a blue-to-red gradient (through purple/magenta)
 * 0 hops: Green (#22c55e) - Direct connection (local node)
 * 1 hop: Blue (#0000FF)
 * 2 hops: Blue-Purple (#3300CC)
 * 3 hops: Purple (#660099)
 * 4 hops: Red-Purple (#990066)
 * 5 hops: Red-Magenta (#CC0033)
 * 6+ hops: Red (#FF0000)
 * 999 hops: Grey (#9ca3af) - No hop data
 */
export function getHopColor(
  hops: number,
  hopColors?: { local: string; noData: string; max: string; gradient: string[] },
): string {
  const colors = hopColors ?? {
    local: '#22c55e',
    noData: '#9ca3af',
    max: '#FF0000',
    gradient: ['#0000FF', '#3300CC', '#660099', '#990066', '#CC0033', '#FF0000'],
  };

  if (hops === 0) {
    return colors.local;
  } else if (hops === 999) {
    return colors.noData;
  } else if (hops >= 6) {
    return colors.max;
  } else {
    return colors.gradient[hops - 1] || colors.gradient[colors.gradient.length - 1];
  }
}

/** Default MeshCore badge color (mauve), matching the pre-migration
 *  `MeshCoreMap.tsx` `MESHCORE_COLOR` constant. Callers pass `fixedColor`
 *  explicitly; this is only a fallback for callers that omit it. */
const MESHCORE_DEFAULT_COLOR = '#cba6f7';

export interface CreateNodeIconOptions {
  // --- existing (unchanged code paths; Meshtastic parity) ---
  /** used when color kind = hops (default) */
  hops?: number;
  isSelected?: boolean;
  isRouter?: boolean;
  shortName?: string;
  showLabel?: boolean;
  animate?: boolean;
  highlightSelected?: boolean;
  pinStyle?: 'meshmonitor' | 'official';
  /** Role category for a per-type glyph (issue #3546). 'standard'/undefined
   *  keeps the default pin (meshmonitor) or short-name circle (official). */
  roleCategory?: NodeTypeCategory;
  /** When true, overlay a "no direct messages" badge on the marker (issue
   *  #4295). Meshtastic variant only. */
  isUnmessagable?: boolean;
  // --- new (source-tech parameters, Phase 4 #4047) ---
  /** Source-tech variant. Defaults to 'meshtastic' — every existing caller's
   *  code path is unchanged. */
  variant?: 'meshtastic' | 'meshcore';
  /** When set, overrides `getHopColor(hops)` for the 'meshtastic' variant, or
   *  supplies the badge color for the 'meshcore' variant (MeshCore mauve). */
  fixedColor?: string;
  /** 'meshcore' variant only: the always-visible name pill drawn above the
   *  badge. */
  labelName?: string;
}

/**
 * Create a custom map icon.
 *
 * `variant: 'meshtastic'` (default) is the original hop-colored
 * pin/tower/circle builder — every existing option keeps its exact code path,
 * so Meshtastic callers (which never pass `fixedColor`/`labelName`) render
 * byte-identical output to before Phase 4 (#4047).
 *
 * `variant: 'meshcore'` is MeshCoreMap's former local `makeIcon` body, moved
 * here verbatim: a role-glyph-or-"MC" badge with an always-visible name pill,
 * 24px, center-anchored, no popupAnchor, no hop/selection/animate styling.
 */
export function createNodeIcon(options: CreateNodeIconOptions): L.DivIcon {
  const {
    hops = 999,
    isSelected = false,
    isRouter = false,
    shortName,
    showLabel = false,
    animate = false,
    highlightSelected = false,
    pinStyle = 'meshmonitor',
    roleCategory,
    isUnmessagable = false,
    variant = 'meshtastic',
    fixedColor,
    labelName,
  } = options;

  // --- MeshCore badge (verbatim relocation of MeshCoreMap's `makeIcon`) ---
  // NOTE: the template-literal bodies below intentionally keep the ORIGINAL
  // makeIcon source indentation (not re-indented for this `if` block) so the
  // resulting html string is byte-identical to the pre-#4047 output — the
  // divIcon html is whitespace-sensitive, so re-indenting these lines to
  // match the surrounding code would silently change the rendered markup.
  if (variant === 'meshcore') {
    const category = roleCategory ?? 'standard';
    const color = fixedColor ?? MESHCORE_DEFAULT_COLOR;
    const name = labelName ?? '';
    const glyph = roleGlyphMarkerSvg(category, color, 24);
    const body = glyph
      ? `<div style="width:24px;height:24px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.3));">${glyph}</div>`
      : `
      <div style="
        width: 24px;
        height: 24px;
        background: ${color};
        border: 2px solid white;
        border-radius: 50%;
        box-shadow: 0 2px 4px rgba(0,0,0,0.3);
        display: flex;
        align-items: center;
        justify-content: center;
        color: #1e1e2e;
        font-size: 10px;
        font-weight: bold;
      ">MC</div>`;
    return L.divIcon({
      className: 'meshcore-marker',
      html: `
      ${body}
      <div style="
        position: absolute;
        top: -20px;
        left: 50%;
        transform: translateX(-50%);
        background: ${color}e6;
        color: #1e1e2e;
        padding: 2px 6px;
        border-radius: 3px;
        font-size: 11px;
        white-space: nowrap;
      ">${name}</div>
    `,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
  }

  // --- Meshtastic (default) — unchanged code paths below ---
  const color = fixedColor ?? getHopColor(hops);
  // A non-standard role gets a dedicated glyph; standard falls through to the
  // existing pin/circle rendering.
  const roleInner =
    roleCategory && roleCategory !== 'standard' ? roleGlyphInnerSvg(roleCategory, color) : '';
  const size = isSelected ? 60 : 48;
  const strokeWidth = isSelected ? 3 : 2;

  // Unmessageable overlay (issue #4295): a "no DMs" badge pinned to the
  // top-right corner, clear of the bottom-right role badge that official style
  // draws for infra roles. Same markup for both pin styles.
  const unmessageableBadgeSize = Math.round(size * 0.4);
  const unmessageableBadge = isUnmessagable ? `
      <div style="
        position: absolute;
        top: -2px;
        right: -2px;
        width: ${unmessageableBadgeSize}px;
        height: ${unmessageableBadgeSize}px;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,0.4));
        pointer-events: none;
      ">${unmessageableBadgeSvg(unmessageableBadgeSize)}</div>
    ` : '';

  // Official Meshtastic style: Circle with always-visible label
  if (pinStyle === 'official') {
    const circleSize = size;
    const emojiName = shortName && isEmoji(shortName);

    // Issue #4154: the always-visible short-name text is the entire point of
    // this pin style, so it must render for every role — a role glyph must
    // NOT swap it out (that was the pre-#4154 behavior, and it hid
    // ROUTER/ROUTER_LATE short names behind the repeater-tower glyph).
    // Infrastructure roles are instead differentiated with a small corner
    // badge (below), layered on top the same way emojiOverlay layers over
    // the base circle.
    const markerSvg = emojiName ? `
      <svg width="${circleSize}" height="${circleSize}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
        <circle cx="24" cy="24" r="20" fill="white" fill-opacity="0.95" stroke="${color}" stroke-width="${strokeWidth}" />
      </svg>
    ` : `
      <svg width="${circleSize}" height="${circleSize}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
        <circle cx="24" cy="24" r="20" fill="white" fill-opacity="0.95" stroke="${color}" stroke-width="${strokeWidth}" />
        <text x="24" y="28" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="#333">${shortName || '?'}</text>
      </svg>
    `;

    const emojiOverlay = emojiName ? `
      <div style="
        position: absolute;
        top: 0;
        left: 0;
        width: ${circleSize}px;
        height: ${circleSize}px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
        line-height: 1;
        pointer-events: none;
      ">${shortName}</div>
    ` : '';

    // Small corner badge carrying the role glyph (router tower, sensor,
    // room-server, companion) so infrastructure nodes stay visually
    // distinguishable without ever hiding the short-name text (issue #4154,
    // follow-up to #3546). Reuses roleGlyphMarkerSvg — the same
    // glyph-over-white-circle drawing already used for MeshCore markers and
    // legend swatches — scaled down and pinned to the bottom-right corner.
    const roleBadgeSize = Math.round(circleSize * 0.42);
    const roleBadge = roleInner && roleCategory ? `
      <div style="
        position: absolute;
        bottom: -2px;
        right: -2px;
        width: ${roleBadgeSize}px;
        height: ${roleBadgeSize}px;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,0.4));
        pointer-events: none;
      ">${roleGlyphMarkerSvg(roleCategory, color, roleBadgeSize)}</div>
    ` : '';

    const classes = [
      animate ? 'node-icon-pulse' : '',
      highlightSelected ? 'node-icon-highlight' : ''
    ].filter(Boolean).join(' ');

    const html = `
      <div class="${classes}" style="position: relative; width: ${circleSize}px; height: ${circleSize}px;">
        ${markerSvg}
        ${emojiOverlay}
        ${roleBadge}
        ${unmessageableBadge}
      </div>
    `;

    return L.divIcon({
      html,
      className: 'custom-node-icon',
      iconSize: [circleSize, circleSize],
      iconAnchor: [circleSize / 2, circleSize / 2],
      popupAnchor: [0, -circleSize / 2]
    });
  }

  // MeshMonitor style: Pin/tower markers with zoom-based labels.
  // A role glyph (when present) renders over a white background circle, the
  // same treatment the router tower already uses (issue #3546).
  const markerSvg = roleInner ? `
    <svg width="${size}" height="${size}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
      <circle cx="24" cy="24" r="20" fill="white" fill-opacity="0.95" stroke="${color}" stroke-width="${strokeWidth}" />
      ${roleInner}
    </svg>
  ` : isRouter ? `
    <svg width="${size}" height="${size}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
      <!-- Background circle -->
      <circle cx="24" cy="24" r="20" fill="white" fill-opacity="0.95" stroke="${color}" stroke-width="${strokeWidth}" />
      <!-- Tower base -->
      <rect x="19" y="32" width="10" height="12" fill="#555" />
      <!-- Tower body -->
      <rect x="21" y="16" width="6" height="16" fill="#555" />
      <!-- Top antenna -->
      <rect x="22.5" y="4" width="3" height="12" fill="#555" />
      <circle cx="24" cy="4" r="3" fill="${color}" />
      <!-- Left signal waves -->
      <path d="M 16 20 C 12 20 8 23 8 26" stroke="${color}" stroke-width="3" fill="none" />
      <path d="M 18 24 C 15 24 12 25 12 26" stroke="${color}" stroke-width="3" fill="none" />
      <!-- Right signal waves -->
      <path d="M 32 20 C 36 20 40 23 40 26" stroke="${color}" stroke-width="3" fill="none" />
      <path d="M 30 24 C 33 24 36 25 36 26" stroke="${color}" stroke-width="3" fill="none" />
    </svg>
  ` : `
    <svg width="${size}" height="${size}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
      <!-- Pin shape -->
      <path d="M 24 4 C 16 4 10 10 10 18 C 10 30 24 44 24 44 C 24 44 38 30 38 18 C 38 10 32 4 24 4 Z"
            fill="${color}" stroke="white" stroke-width="${strokeWidth}" />
      <!-- Inner circle -->
      <circle cx="24" cy="18" r="6" fill="white" />
    </svg>
  `;

  const emojiLabel = shortName && isEmoji(shortName);
  const label = showLabel && shortName ? `
    <div style="
      position: absolute;
      top: ${size + 2}px;
      left: 50%;
      transform: translateX(-50%);
      background: white;
      padding: 2px 6px;
      border-radius: 3px;
      border: 1px solid ${color};
      font-weight: ${emojiLabel ? 'normal' : 'bold'};
      font-size: ${emojiLabel ? '16px' : '11px'};
      line-height: ${emojiLabel ? '1' : 'normal'};
      white-space: nowrap;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
      color: #333;
    ">${shortName}</div>
  ` : '';

  const classes = [
    animate ? 'node-icon-pulse' : '',
    highlightSelected ? 'node-icon-highlight' : ''
  ].filter(Boolean).join(' ');

  const html = `
    <div class="${classes}" style="position: relative; width: ${size}px; height: ${size}px;">
      ${markerSvg}
      ${label}
      ${unmessageableBadge}
    </div>
  `;

  return L.divIcon({
    html,
    className: 'custom-node-icon',
    iconSize: [size, size + (showLabel && shortName ? 20 : 0)],
    iconAnchor: [size / 2, size],
    popupAnchor: [0, -size]
  });
}

/**
 * TracerouteWidget's from/to/hop endpoint dots. Relocated verbatim from the
 * widget's local `createNodeIcon(isEndpoint, isFrom, isTo)` (#4047 Phase 4,
 * D3 Option A).
 *
 * These colors are a deliberate endpoint-identity encoding (green = source,
 * blue = destination, gray = intermediate hop) — distinct from, and
 * intentionally NOT matching, the traceroute leg colors (theme
 * tracerouteForward/tracerouteReturn palette). This is not drift to fix; it
 * is a separate semantic (who is the endpoint) from leg direction (which way
 * did the packet travel). Zero pixel change from the pre-Phase-4 widget.
 */
export interface CreateAtakContactIconOptions {
  /** Team marker/swatch color (see `utils/atakTeam.ts` `teamColor`). */
  color: string;
  /** Display callsign; falls back to a generic label when absent. */
  callsign: string | null | undefined;
  /** Dims the marker when the contact has gone stale (no recent PLI). */
  stale: boolean;
}

/**
 * ATAK contact marker (ATAK/CoT Phase 2, issue #3691): a team-colored dot
 * with an always-visible callsign label above it, modeled on the MeshCore
 * badge-plus-name-pill treatment in `createNodeIcon`'s `variant: 'meshcore'`
 * branch. Stale contacts (no fresh PLI within `ATAK_CONTACT_STALE_MS`) render
 * at reduced opacity so they read as "last known position" rather than live.
 */
export function createAtakContactIcon({
  color,
  callsign,
  stale,
}: CreateAtakContactIconOptions): L.DivIcon {
  const label = callsign && callsign.length > 0 ? callsign : 'ATAK';
  const opacity = stale ? 0.5 : 1;
  const html = `
    <div style="opacity: ${opacity};">
      <div style="
        width: 20px;
        height: 20px;
        background: ${color};
        border: 2px solid white;
        border-radius: 50%;
        box-shadow: 0 2px 4px rgba(0,0,0,0.4);
      "></div>
      <div style="
        position: absolute;
        top: -20px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0,0,0,0.75);
        color: white;
        padding: 2px 6px;
        border-radius: 3px;
        font-size: 11px;
        font-weight: bold;
        white-space: nowrap;
      ">${label}</div>
    </div>
  `;
  return L.divIcon({
    html,
    className: 'atak-contact-marker',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    popupAnchor: [0, -10],
  });
}

export function createTracerouteEndpointIcon(role: 'from' | 'to' | 'hop'): L.DivIcon {
  let color = '#888'; // intermediate hop
  if (role === 'from') color = '#4CAF50'; // green for source
  else if (role === 'to') color = '#2196F3'; // blue for destination

  const isEndpoint = role === 'from' || role === 'to';
  const size = isEndpoint ? 12 : 8;

  return L.divIcon({
    html: `<div style="
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border: 2px solid white;
      border-radius: 50%;
      box-shadow: 0 0 4px rgba(0,0,0,0.5);
    "></div>`,
    className: 'traceroute-node-icon',
    iconSize: [size + 4, size + 4],
    iconAnchor: [(size + 4) / 2, (size + 4) / 2],
  });
}
