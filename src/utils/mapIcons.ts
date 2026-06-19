import L from 'leaflet';
import { isEmoji } from './text';
import type { NodeTypeCategory } from './nodeTypeCategory';

/**
 * Inner SVG markup for a node-type role glyph, drawn inside the 48×48 viewBox
 * over a white background circle (issue #3546). Returns '' for 'standard' so
 * callers fall back to the default pin/circle. `color` is the hop color so the
 * glyph stays consistent with the marker's stroke.
 */
export function roleGlyphInnerSvg(category: NodeTypeCategory, color: string): string {
  switch (category) {
    case 'repeater':
      // Tower with signal waves — the existing router silhouette, overflows
      // the circle so backbone nodes read at a glance.
      return `
        <rect x="19" y="32" width="10" height="12" fill="#555" />
        <rect x="21" y="16" width="6" height="16" fill="#555" />
        <rect x="22.5" y="4" width="3" height="12" fill="#555" />
        <circle cx="24" cy="4" r="3" fill="${color}" />
        <path d="M 16 20 C 12 20 8 23 8 26" stroke="${color}" stroke-width="3" fill="none" />
        <path d="M 18 24 C 15 24 12 25 12 26" stroke="${color}" stroke-width="3" fill="none" />
        <path d="M 32 20 C 36 20 40 23 40 26" stroke="${color}" stroke-width="3" fill="none" />
        <path d="M 30 24 C 33 24 36 25 36 26" stroke="${color}" stroke-width="3" fill="none" />`;
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

/**
 * Create a custom map icon with hop-based coloring and optional label
 */
export function createNodeIcon(options: {
  hops: number;
  isSelected: boolean;
  isRouter: boolean;
  shortName?: string;
  showLabel: boolean;
  animate?: boolean;
  highlightSelected?: boolean;
  pinStyle?: 'meshmonitor' | 'official';
  /** Role category for a per-type glyph (issue #3546). 'standard'/undefined
   *  keeps the default pin (meshmonitor) or short-name circle (official). */
  roleCategory?: NodeTypeCategory;
}): L.DivIcon {
  const { hops, isSelected, isRouter, shortName, showLabel, animate = false, highlightSelected = false, pinStyle = 'meshmonitor', roleCategory } = options;
  const color = getHopColor(hops);
  // A non-standard role gets a dedicated glyph; standard falls through to the
  // existing pin/circle rendering.
  const roleInner =
    roleCategory && roleCategory !== 'standard' ? roleGlyphInnerSvg(roleCategory, color) : '';
  const size = isSelected ? 60 : 48;
  const strokeWidth = isSelected ? 3 : 2;

  // Official Meshtastic style: Circle with always-visible label
  if (pinStyle === 'official') {
    const circleSize = size;
    const emojiName = shortName && isEmoji(shortName);

    // A role glyph replaces the short-name text so MeshCore node types stay
    // distinguishable in the official circle style too (issue #3546).
    const markerSvg = roleInner ? `
      <svg width="${circleSize}" height="${circleSize}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
        <circle cx="24" cy="24" r="20" fill="white" fill-opacity="0.95" stroke="${color}" stroke-width="${strokeWidth}" />
        ${roleInner}
      </svg>
    ` : emojiName ? `
      <svg width="${circleSize}" height="${circleSize}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
        <circle cx="24" cy="24" r="20" fill="white" fill-opacity="0.95" stroke="${color}" stroke-width="${strokeWidth}" />
      </svg>
    ` : `
      <svg width="${circleSize}" height="${circleSize}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
        <circle cx="24" cy="24" r="20" fill="white" fill-opacity="0.95" stroke="${color}" stroke-width="${strokeWidth}" />
        <text x="24" y="28" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="#333">${shortName || '?'}</text>
      </svg>
    `;

    const emojiOverlay = emojiName && !roleInner ? `
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

    const classes = [
      animate ? 'node-icon-pulse' : '',
      highlightSelected ? 'node-icon-highlight' : ''
    ].filter(Boolean).join(' ');

    const html = `
      <div class="${classes}" style="position: relative; width: ${circleSize}px; height: ${circleSize}px;">
        ${markerSvg}
        ${emojiOverlay}
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