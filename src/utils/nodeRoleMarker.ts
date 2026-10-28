/**
 * One place that decides how a Meshtastic device role looks on a map (#6008).
 *
 * Every map surface (NodesTab, DashboardMap, Map Analysis, EmbedMap) and the
 * server's infrastructure set read from here, so a role can no longer render
 * as infrastructure on one map and as a plain client on another.
 *
 * Two kinds of mark:
 *
 * - **Infrastructure markers** replace the pin glyph: ROUTER (and the
 *   deprecated ROUTER_CLIENT / REPEATER) draw the router tower, ROUTER_LATE the
 *   tower with a clock, CLIENT_BASE a base station (house with antenna).
 * - **Corner badges** sit on an ordinary marker: TRACKER / TAK_TRACKER, SENSOR,
 *   TAK, LOST_AND_FOUND and CLIENT_MUTE.
 *
 * CLIENT and CLIENT_HIDDEN stay plain. MeshCore advert types are out of scope;
 * they keep their own glyphs in `nodeTypeCategory.ts`.
 *
 * Pure and dependency-light on purpose: the server imports
 * {@link INFRASTRUCTURE_ROLES} from here, so no React, Leaflet or DOM imports.
 */

import { DeviceRole } from '../constants/index.js';

/** What a role adds to its map marker. */
export type MarkerRoleKind =
  | 'router'
  | 'routerLate'
  | 'clientBase'
  | 'tracker'
  | 'lostAndFound'
  | 'sensor'
  | 'tak'
  | 'clientMute'
  | 'none';

/** The kinds drawn as a full infrastructure glyph rather than a corner badge. */
export type InfrastructureMarkerKind = Extract<MarkerRoleKind, 'router' | 'routerLate' | 'clientBase'>;

/** The kinds drawn as a small corner badge. */
export type RoleBadgeKind = Extract<
  MarkerRoleKind,
  'tracker' | 'lostAndFound' | 'sensor' | 'tak' | 'clientMute'
>;

/**
 * Device roles that count as routing infrastructure (Meshtastic
 * Config.DeviceConfig.Role): Router (2), Router Client (3, deprecated),
 * Repeater (4, deprecated), Router Late (11), Client Base (12). Client Base
 * retransmits like Router Late, so it counts too (#4822).
 *
 * The server's airtime cutoff (`src/server/utils/airtimeCutoff.ts`) re-exports
 * this set, so the map and the server cannot disagree.
 */
export const INFRASTRUCTURE_ROLES: ReadonlySet<number> = new Set<number>([
  DeviceRole.ROUTER,
  DeviceRole.ROUTER_CLIENT,
  DeviceRole.REPEATER,
  DeviceRole.ROUTER_LATE,
  DeviceRole.CLIENT_BASE,
]);

const ROLE_TO_KIND: Readonly<Record<number, MarkerRoleKind>> = {
  [DeviceRole.CLIENT]: 'none',
  [DeviceRole.CLIENT_MUTE]: 'clientMute',
  [DeviceRole.ROUTER]: 'router',
  [DeviceRole.ROUTER_CLIENT]: 'router', // deprecated: draw as a router
  [DeviceRole.REPEATER]: 'router', // deprecated: draw as a router
  [DeviceRole.TRACKER]: 'tracker',
  [DeviceRole.SENSOR]: 'sensor',
  [DeviceRole.TAK]: 'tak',
  [DeviceRole.CLIENT_HIDDEN]: 'none',
  [DeviceRole.LOST_AND_FOUND]: 'lostAndFound',
  [DeviceRole.TAK_TRACKER]: 'tracker',
  [DeviceRole.ROUTER_LATE]: 'routerLate',
  [DeviceRole.CLIENT_BASE]: 'clientBase',
};

/** Parse a role that may arrive as a number or a numeric string. */
export function toRoleNumber(role: number | string | null | undefined): number | null {
  if (typeof role === 'number') return Number.isFinite(role) ? role : null;
  if (typeof role === 'string' && role.trim() !== '') {
    const n = parseInt(role, 10);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

/** True when the role is a Meshtastic infrastructure role. */
export function isInfrastructureRole(role: number | string | null | undefined): boolean {
  const n = toRoleNumber(role);
  return n !== null && INFRASTRUCTURE_ROLES.has(n);
}

/** The marker kind for a Meshtastic role. Unknown or missing roles are `'none'`. */
export function markerRoleBadge(role: number | string | null | undefined): MarkerRoleKind {
  const n = toRoleNumber(role);
  if (n === null) return 'none';
  return ROLE_TO_KIND[n] ?? 'none';
}

/** True for the kinds drawn as a full infrastructure glyph. */
export function isInfrastructureMarkerKind(kind: MarkerRoleKind): kind is InfrastructureMarkerKind {
  return kind === 'router' || kind === 'routerLate' || kind === 'clientBase';
}

/** True for the kinds drawn as a corner badge. */
export function isRoleBadgeKind(kind: MarkerRoleKind): kind is RoleBadgeKind {
  return kind !== 'none' && !isInfrastructureMarkerKind(kind);
}

/** Legend order for the corner badges. */
export const ROLE_BADGE_KINDS: readonly RoleBadgeKind[] = [
  'tracker',
  'lostAndFound',
  'sensor',
  'tak',
  'clientMute',
];

/** Legend text for one marker kind: label plus a one-line hint (row tooltip). */
export interface RoleMarkerLegendEntry {
  kind: Exclude<MarkerRoleKind, 'none'>;
  /** i18n key for the row label (public/locales/en.json). */
  labelKey: string;
  /** English fallback for the label. */
  label: string;
  /** i18n key for the row's tooltip. */
  hintKey: string;
  /** English fallback for the tooltip. */
  hint: string;
}

/**
 * Legend rows for the Meshtastic role markers, infrastructure first, then the
 * corner badges in {@link ROLE_BADGE_KINDS} order. Shared by the map legends so
 * each lists the same marks with the same words.
 */
export const ROLE_MARKER_LEGEND: readonly RoleMarkerLegendEntry[] = [
  { kind: 'router', labelKey: 'map.legend.role.router', label: 'Router', hintKey: 'map.legend.role.routerHint', hint: 'Router tower. Also used for the deprecated Router Client and Repeater roles.' },
  { kind: 'routerLate', labelKey: 'map.legend.role.routerLate', label: 'Router (Late)', hintKey: 'map.legend.role.routerLateHint', hint: 'Router tower with a clock: rebroadcasts after other nodes.' },
  { kind: 'clientBase', labelKey: 'map.legend.role.clientBase', label: 'Client (Base)', hintKey: 'map.legend.role.clientBaseHint', hint: 'Base station: always relays packets to and from its favourite nodes.' },
  { kind: 'tracker', labelKey: 'map.legend.role.tracker', label: 'Tracker / TAK Tracker', hintKey: 'map.legend.role.trackerHint', hint: 'Corner badge: sends its position often. Follow its trail to see where it went.' },
  { kind: 'lostAndFound', labelKey: 'map.legend.role.lostAndFound', label: 'Lost and Found', hintKey: 'map.legend.role.lostAndFoundHint', hint: 'Corner badge: a lost device sending its location so it can be found.' },
  { kind: 'sensor', labelKey: 'map.legend.role.sensor', label: 'Sensor', hintKey: 'map.legend.role.sensorHint', hint: 'Corner badge: sends telemetry first, a source of environment data.' },
  { kind: 'tak', labelKey: 'map.legend.role.tak', label: 'TAK', hintKey: 'map.legend.role.takHint', hint: 'Corner badge: tuned for the ATAK plugin.' },
  { kind: 'clientMute', labelKey: 'map.legend.role.clientMute', label: 'Client (Mute)', hintKey: 'map.legend.role.clientMuteHint', hint: 'Corner badge: does not relay packets for others.' },
];
