/**
 * Shared advanced node filter (#6259). One predicate for Meshtastic and
 * MeshCore node lists. The order and semantics match the former
 * `useSourceView.passesAdvancedFilters` exactly.
 */
import type { DeviceInfo } from '../types/device.js';
import type { NodeFilters, SecurityFilter } from '../types/ui.js';
import { isAgedOutAircraft } from '../components/map/agedOutAircraft.js';

export const DEFAULT_NODE_FILTERS: NodeFilters = {
  filterMode: 'show',
  showMqtt: false,
  showTelemetry: false,
  showEnvironment: false,
  powerSource: 'both',
  showPosition: false,
  minHops: 0,
  maxHops: 10,
  showPKI: false,
  showRemoteAdmin: false,
  showUnknown: false,
  showIgnored: false,
  showFavorites: false,
  showFavoriteLocked: false,
  showHiddenFromMap: false,
  deviceRoles: [],
  channels: [],
};

/** Fill gaps in a saved/legacy value so every field is present and valid. */
export function normalizeNodeFilters(raw: unknown): NodeFilters {
  const parsed = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Partial<NodeFilters>) : {};
  const merged: NodeFilters = { ...DEFAULT_NODE_FILTERS, ...parsed };
  if (merged.filterMode !== 'show' && merged.filterMode !== 'hide') merged.filterMode = 'show';
  if (!Array.isArray(merged.deviceRoles)) merged.deviceRoles = [];
  if (!Array.isArray(merged.channels)) merged.channels = [];
  return merged;
}

export interface NodeFilterSubject {
  viaMqtt?: boolean;
  hasTelemetry?: boolean;
  hasEnvironment?: boolean;
  /** undefined skips the power filter. */
  batteryLevel?: number | null;
  hasPosition: boolean;
  /** null/undefined skips the hops filter. */
  hops?: number | null;
  hasPKI?: boolean;
  hasRemoteAdmin?: boolean;
  isUnknown: boolean;
  isIgnored: boolean;
  isAgedOutAircraft?: boolean;
  isFavorite: boolean;
  favoriteLocked?: boolean;
  hiddenFromMap?: boolean;
  role: number;
  channel: number;
  /** Shared Security filter (P7a #6254). Unset = not flagged. */
  securityFlagged?: boolean;
}

/** Meshtastic key-security flags, as set on a node by the key scanner. */
export interface KeySecurityFlags {
  keyIsLowEntropy?: boolean | null;
  duplicateKeyDetected?: boolean | null;
  keySecurityIssueDetails?: string | null;
}

/** True when a Meshtastic node carries any key-security flag. */
export function isSecurityFlagged(n: KeySecurityFlags): boolean {
  return !!(n.keyIsLowEntropy || n.duplicateKeyDetected || n.keySecurityIssueDetails);
}

/** Apply the Security filter to a flagged state ('all' passes everything). */
export function passesSecurityFilter(flagged: boolean, filter: SecurityFilter | undefined): boolean {
  if (filter === 'flaggedOnly') return flagged;
  if (filter === 'hideFlagged') return !flagged;
  return true;
}

export function passesNodeFilters(
  s: NodeFilterSubject,
  f: NodeFilters,
  opts: { allowAgedOut?: boolean; securityFilter?: SecurityFilter } = {},
): boolean {
  const isShowMode = f.filterMode === 'show';
  // Show mode drops non-matches; hide mode drops matches.
  const fails = (matches: boolean) => (isShowMode ? !matches : matches);

  if (f.showMqtt && fails(!!s.viaMqtt)) return false;
  if (f.showTelemetry && fails(!!s.hasTelemetry)) return false;
  if (f.showEnvironment && fails(!!s.hasEnvironment)) return false;

  if (f.powerSource !== 'both' && s.batteryLevel !== undefined) {
    const isPowered = s.batteryLevel === 101;
    if (f.powerSource === 'powered' && !isPowered) return false;
    if (f.powerSource === 'battery' && isPowered) return false;
  }

  if (f.showPosition && fails(!!s.hasPosition)) return false;

  // Hops filter (always applies regardless of mode)
  if (s.hops != null) {
    if (s.hops < f.minHops || s.hops > f.maxHops) return false;
  }

  if (f.showPKI && fails(!!s.hasPKI)) return false;
  if (f.showRemoteAdmin && fails(!!s.hasRemoteAdmin)) return false;
  if (f.showUnknown && fails(s.isUnknown)) return false;

  // Ignored nodes hide by default. `allowAgedOut` lets an aged-out aircraft
  // through for the map-only "Show aged-out" list (#5364/#5365).
  if (!f.showIgnored && s.isIgnored && !(opts.allowAgedOut && s.isAgedOutAircraft)) return false;

  if (f.showFavorites && fails(s.isFavorite)) return false;
  if (f.showFavoriteLocked && fails(!!s.favoriteLocked)) return false;
  // #5952
  if (f.showHiddenFromMap && fails(!!s.hiddenFromMap)) return false;

  if (f.deviceRoles.length > 0 && fails(f.deviceRoles.includes(s.role))) return false;
  if (f.channels.length > 0 && fails(f.channels.includes(s.channel))) return false;

  if (!passesSecurityFilter(!!s.securityFlagged, opts.securityFilter)) return false;

  return true;
}

export function toMeshtasticFilterSubject(
  node: DeviceInfo,
  sets: {
    nodesWithTelemetry: Set<string>;
    nodesWithWeather: Set<string>;
    nodesWithPKC: Set<string>;
  },
): NodeFilterSubject {
  const nodeId = node.user?.id;
  const hasLongName = node.user?.longName && node.user.longName.trim() !== '';
  const hasShortName = node.user?.shortName && node.user.shortName.trim() !== '';
  return {
    viaMqtt: !!node.viaMqtt,
    hasTelemetry: !!(nodeId && sets.nodesWithTelemetry.has(nodeId)),
    hasEnvironment: !!(nodeId && sets.nodesWithWeather.has(nodeId)),
    batteryLevel: node.deviceMetrics?.batteryLevel,
    hasPosition: !!(node.position && node.position.latitude != null && node.position.longitude != null),
    hops: node.hopsAway,
    hasPKI: !!(nodeId && sets.nodesWithPKC.has(nodeId)),
    hasRemoteAdmin: !!node.hasRemoteAdmin,
    isUnknown: !hasLongName && !hasShortName,
    isIgnored: !!node.isIgnored,
    isAgedOutAircraft: isAgedOutAircraft(node),
    isFavorite: !!node.isFavorite,
    favoriteLocked: !!node.favoriteLocked,
    hiddenFromMap: !!node.hideFromMap,
    role: typeof node.user?.role === 'number' ? node.user.role : parseInt(node.user?.role || '0'),
    channel: node.channel ?? -1,
  };
}
