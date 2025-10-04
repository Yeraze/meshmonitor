import L from 'leaflet';

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
export function getHopColor(hops: number): string {
  if (hops === 0) {
    return '#22c55e'; // Green for local node (direct connection)
  } else if (hops === 999) {
    return '#9ca3af'; // Grey for no hop data
  } else if (hops >= 6) {
    return '#FF0000'; // Red for 6+ hops
  } else {
    // Linear gradient from blue to red (1-6 hops)
    // Using RGB interpolation: Blue(0,0,255) → Red(255,0,0)
    const colors = [
      '#0000FF', // 1 hop: Blue
      '#3300CC', // 2 hops: Blue-Purple
      '#660099', // 3 hops: Purple
      '#990066', // 4 hops: Red-Purple
      '#CC0033', // 5 hops: Red-Magenta
      '#FF0000'  // 6 hops: Red
    ];
    return colors[hops - 1] || colors[colors.length - 1];
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
}): L.DivIcon {
  const { hops, isSelected, isRouter, shortName, showLabel } = options;
  const color = getHopColor(hops);
  const size = isSelected ? 60 : 48;
  const strokeWidth = isSelected ? 3 : 2;

  // Create SVG for the marker
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
      font-weight: bold;
      font-size: 11px;
      white-space: nowrap;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
      color: #333;
    ">${shortName}</div>
  ` : '';

  const html = `
    <div style="position: relative; width: ${size}px; height: ${size}px;">
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

// Legacy exports for backward compatibility (deprecated)
export const defaultIcon = createNodeIcon({ hops: 3, isSelected: false, isRouter: false, showLabel: false });
export const selectedIcon = createNodeIcon({ hops: 3, isSelected: true, isRouter: false, showLabel: false });
export const routerIcon = createNodeIcon({ hops: 3, isSelected: false, isRouter: true, showLabel: false });
export const selectedRouterIcon = createNodeIcon({ hops: 3, isSelected: true, isRouter: true, showLabel: false });
