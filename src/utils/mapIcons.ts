import L from 'leaflet';
import { isEmoji } from './text';

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
}): L.DivIcon {
  const { hops, isSelected, isRouter, shortName, showLabel, animate = false, highlightSelected = false, pinStyle = 'meshmonitor' } = options;
  const color = getHopColor(hops);
  const size = isSelected ? 60 : 48;
  const strokeWidth = isSelected ? 3 : 2;

  // Official Meshtastic style: Circle with always-visible label
  if (pinStyle === 'official') {
    const circleSize = size;
    const emojiName = shortName && isEmoji(shortName);

    // For emoji short names, render as an HTML overlay instead of SVG <text>
    // SVG text elements can't reliably render emoji across browsers
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

  // MeshMonitor style: Pin/tower markers with zoom-based labels
  const markerSvg = isRouter ? `
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