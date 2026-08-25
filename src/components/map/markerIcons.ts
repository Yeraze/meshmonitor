import L from 'leaflet';
import { isEmoji } from '../../utils/text.js';
import type { NodeTypeCategory } from '../../utils/nodeTypeCategory.js';
import {
  roleGlyphInnerSvg,
  roleGlyphMarkerSvg,
  getHopColor,
  unmessageableBadgeSvg,
} from '../../utils/roleGlyphSvg.js';
import { meshtasticNodeColor, readableTextColor } from '../../utils/nodeColor.js';

// Relocated to `src/utils/roleGlyphSvg.ts` (Leaflet-free) so off-map surfaces
// (the Node Details traceroute strip) can import the glyph builders without
// pulling Leaflet into their bundle/tests. Re-exported here so every existing
// importer of `markerIcons` (MapLegend, createNodeIcon callers, tests) keeps
// its current import path unchanged.
export { roleGlyphInnerSvg, roleGlyphMarkerSvg, getHopColor, unmessageableBadgeSvg };

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
  /** uint32 node number. When set on the 'official' (Meshtastic) pin style, the
   *  circle is filled with the per-node Meshtastic app color (issue #4880)
   *  instead of white, and the short name switches to a luminance-picked
   *  black/white for contrast. Ignored by the meshmonitor pin style. */
  nodeNum?: number;
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
    nodeNum,
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

    // #4880: fill the circle with the per-node Meshtastic app color (low 24 bits
    // of nodeNum) when a nodeNum is supplied, matching the Android/iOS apps. The
    // short name switches to a luminance-picked black/white so it stays legible
    // on any generated color; the halo takes the opposite tone. Without a nodeNum
    // (or for the emoji-name case) we keep the original white circle + dark text.
    const fillColor = nodeNum != null ? meshtasticNodeColor(nodeNum) : null;
    const textFill = fillColor ? readableTextColor(fillColor) : '#333';
    const textHalo = fillColor ? (textFill === '#ffffff' ? '#000000' : '#ffffff') : '#ffffff';
    const circleFill = fillColor ?? 'white';
    const circleFillOpacity = fillColor ? '1' : '0.95';
    const circleStroke = fillColor ? '#ffffff' : color;

    // Issue #4154: the always-visible short-name text is the entire point of
    // this pin style, so it must render for every role — a role glyph must
    // NOT swap it out (that was the pre-#4154 behavior, and it hid
    // ROUTER/ROUTER_LATE short names behind the repeater-tower glyph).
    // Infrastructure roles are instead differentiated with a small corner
    // badge (below), layered on top the same way emojiOverlay layers over
    // the base circle.
    const markerSvg = emojiName ? `
      <svg width="${circleSize}" height="${circleSize}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
        <circle cx="24" cy="24" r="20" fill="${circleFill}" fill-opacity="${circleFillOpacity}" stroke="${circleStroke}" stroke-width="${strokeWidth}" />
      </svg>
    ` : `
      <svg width="${circleSize}" height="${circleSize}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
        <circle cx="24" cy="24" r="20" fill="${circleFill}" fill-opacity="${circleFillOpacity}" stroke="${circleStroke}" stroke-width="${strokeWidth}" />
        <!-- Halo under the glyph so the short name stays legible over satellite
             imagery even where the backing circle washes out against bright
             terrain (snow/sand/cloud). paint-order draws the stroke first so the
             text fill sits on top of its own outline (#4860). With a node-color
             fill (#4880) both text and halo are luminance-picked for contrast. -->
        <text x="24" y="28" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="${textFill}" stroke="${textHalo}" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${shortName || '?'}</text>
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
