/**
 * Node-type categorization shared by the map's role icons, the node-type
 * filter, and the legend (issue #3546, refined for #3610). One function decides
 * a node's category so the icon a user sees and the checkbox that hides it can
 * never disagree.
 *
 * Two protocols, two category families:
 *
 * - **MeshCore** advert types (firmware): Chat/Companion=1, Repeater=2, Room=3,
 *   Sensor=4 (`ADV_TYPE_NAME` in meshcorePacketDecode.ts; `MeshCoreDeviceType`
 *   in meshcoreManager.ts). These map to the `companion`/`repeater`/`roomServer`/
 *   `sensor` categories; anything else is `standard`.
 *
 * - **Meshtastic** device roles (`DEVICE_ROLES` in deviceRole.ts). Pre-#3610 the
 *   filter folded *every* Meshtastic node into either `repeater` (ROUTER) or
 *   `standard`, so a Meshtastic-only instance got three permanently-empty
 *   MeshCore options and no way to tell a TRACKER from a CLIENT. Now each
 *   meaningful role gets its own `mt*` category so the filter is useful.
 *
 * The filter UI and legend compute the *visible* category set from the source
 * types actually connected, so a Meshtastic-only instance never shows
 * MeshCore-only options and vice-versa. The persisted filter still keys on
 * these stable category names; a stale toggle for a category that isn't
 * currently present is simply inert (default visible).
 */

import { DEVICE_ROLES } from './deviceRole';

/** MeshCore advert-type categories (issue #3546). */
export type MeshCoreCategory =
  | 'repeater'
  | 'roomServer'
  | 'sensor'
  | 'companion'
  | 'standard';

/** Meshtastic device-role categories (issue #3610). */
export type MeshtasticCategory =
  | 'mtClient'
  | 'mtClientMute'
  | 'mtRouter'
  | 'mtRouterClient'
  | 'mtRepeater'
  | 'mtTracker'
  | 'mtSensor'
  | 'mtTak'
  | 'mtClientHidden'
  | 'mtLostAndFound'
  | 'mtTakTracker'
  | 'mtRouterLate'
  | 'mtClientBase';

export type NodeTypeCategory = MeshCoreCategory | MeshtasticCategory;

/** Display order for MeshCore categories (infrastructure first). */
export const MESHCORE_CATEGORIES: MeshCoreCategory[] = [
  'repeater',
  'roomServer',
  'sensor',
  'companion',
  'standard',
];

/**
 * Maps a Meshtastic numeric role (see {@link DEVICE_ROLES}) to its category.
 */
export const MESHTASTIC_ROLE_TO_CATEGORY: Record<number, MeshtasticCategory> = {
  0: 'mtClient',
  1: 'mtClientMute',
  2: 'mtRouter',
  3: 'mtRouterClient', // deprecated
  4: 'mtRepeater', // deprecated
  5: 'mtTracker',
  6: 'mtSensor',
  7: 'mtTak',
  8: 'mtClientHidden',
  9: 'mtLostAndFound',
  10: 'mtTakTracker',
  11: 'mtRouterLate',
  12: 'mtClientBase',
};

/** Display order for Meshtastic categories (infrastructure first, then clients). */
export const MESHTASTIC_CATEGORIES: MeshtasticCategory[] = [
  'mtRouter',
  'mtRouterLate',
  'mtRepeater',
  'mtClient',
  'mtClientMute',
  'mtClientHidden',
  'mtClientBase',
  'mtRouterClient',
  'mtTracker',
  'mtSensor',
  'mtTak',
  'mtTakTracker',
  'mtLostAndFound',
];

/**
 * Every category, for code that needs the full universe (config defaults,
 * persisted-state hydration). Order is MeshCore-first then Meshtastic.
 */
export const NODE_TYPE_CATEGORIES: NodeTypeCategory[] = [
  ...MESHCORE_CATEGORIES,
  ...MESHTASTIC_CATEGORIES,
];

export interface NodeTypeCategoryMeta {
  key: NodeTypeCategory;
  /** i18n key (see public/locales/*.json). */
  labelKey: string;
  /** English fallback so untranslated locales still render. */
  label: string;
  /** Which protocol family this category belongs to. */
  protocol: 'meshcore' | 'meshtastic';
}

export const NODE_TYPE_CATEGORY_META: Record<NodeTypeCategory, NodeTypeCategoryMeta> = {
  // MeshCore
  repeater:   { key: 'repeater',   labelKey: 'map.nodeType.repeater',   label: 'Repeater',    protocol: 'meshcore' },
  roomServer: { key: 'roomServer', labelKey: 'map.nodeType.roomServer', label: 'Room Server', protocol: 'meshcore' },
  sensor:     { key: 'sensor',     labelKey: 'map.nodeType.sensor',     label: 'Sensor',      protocol: 'meshcore' },
  companion:  { key: 'companion',  labelKey: 'map.nodeType.companion',  label: 'Companion',   protocol: 'meshcore' },
  standard:   { key: 'standard',   labelKey: 'map.nodeType.standard',   label: 'Standard',    protocol: 'meshcore' },
  // Meshtastic — labels reuse DEVICE_ROLES names for consistency with the node list.
  mtRouter:       { key: 'mtRouter',       labelKey: 'map.nodeType.mtRouter',       label: DEVICE_ROLES[2],  protocol: 'meshtastic' },
  mtRouterLate:   { key: 'mtRouterLate',   labelKey: 'map.nodeType.mtRouterLate',   label: DEVICE_ROLES[11], protocol: 'meshtastic' },
  mtRepeater:     { key: 'mtRepeater',     labelKey: 'map.nodeType.mtRepeater',     label: DEVICE_ROLES[4],  protocol: 'meshtastic' },
  mtClient:       { key: 'mtClient',       labelKey: 'map.nodeType.mtClient',       label: DEVICE_ROLES[0],  protocol: 'meshtastic' },
  mtClientMute:   { key: 'mtClientMute',   labelKey: 'map.nodeType.mtClientMute',   label: DEVICE_ROLES[1],  protocol: 'meshtastic' },
  mtClientHidden: { key: 'mtClientHidden', labelKey: 'map.nodeType.mtClientHidden', label: DEVICE_ROLES[8],  protocol: 'meshtastic' },
  mtClientBase:   { key: 'mtClientBase',   labelKey: 'map.nodeType.mtClientBase',   label: DEVICE_ROLES[12], protocol: 'meshtastic' },
  mtRouterClient: { key: 'mtRouterClient', labelKey: 'map.nodeType.mtRouterClient', label: DEVICE_ROLES[3],  protocol: 'meshtastic' },
  mtTracker:      { key: 'mtTracker',      labelKey: 'map.nodeType.mtTracker',      label: DEVICE_ROLES[5],  protocol: 'meshtastic' },
  mtSensor:       { key: 'mtSensor',       labelKey: 'map.nodeType.mtSensor',       label: DEVICE_ROLES[6],  protocol: 'meshtastic' },
  mtTak:          { key: 'mtTak',          labelKey: 'map.nodeType.mtTak',          label: DEVICE_ROLES[7],  protocol: 'meshtastic' },
  mtTakTracker:   { key: 'mtTakTracker',   labelKey: 'map.nodeType.mtTakTracker',   label: DEVICE_ROLES[10], protocol: 'meshtastic' },
  mtLostAndFound: { key: 'mtLostAndFound', labelKey: 'map.nodeType.mtLostAndFound', label: DEVICE_ROLES[9],  protocol: 'meshtastic' },
};

/**
 * The glyph "family" a category draws with. Several Meshtastic roles share the
 * MeshCore glyph silhouettes (a ROUTER is drawn as a repeater tower, a SENSOR
 * as a sensor broadcast, etc.) so map icons stay recognizable without inventing
 * a unique glyph per role. `'standard'` = fall back to the default pin.
 */
export function categoryGlyphFamily(category: NodeTypeCategory): MeshCoreCategory {
  switch (category) {
    case 'repeater':
    case 'roomServer':
    case 'sensor':
    case 'companion':
    case 'standard':
      return category;
    case 'mtRouter':
    case 'mtRouterLate':
    case 'mtRepeater':
      return 'repeater';
    case 'mtSensor':
      return 'sensor';
    case 'mtClient':
    case 'mtClientMute':
    case 'mtClientHidden':
    case 'mtClientBase':
    case 'mtRouterClient':
    case 'mtTracker':
    case 'mtTak':
    case 'mtTakTracker':
    case 'mtLostAndFound':
      return 'standard';
    default:
      return 'standard';
  }
}

/** The subset of a node record needed to determine its category. */
export interface CategorizableNode {
  /** Truthy for MeshCore nodes (server sets `isMeshCore: true`). */
  isMeshCore?: unknown;
  /** MeshCore advert type (1=Companion, 2=Repeater, 3=Room, 4=Sensor). */
  advType?: number | null;
  /** Meshtastic role lives under `user.role`; sometimes mirrored top-level. */
  user?: { role?: string | number | null } | null;
  role?: number | string | null;
}

function toRoleNum(value: number | string | null | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = parseInt(value, 10);
    return Number.isNaN(n) ? NaN : n;
  }
  return NaN;
}

/** True when a node carries MeshCore identity (advType present / isMeshCore). */
export function isMeshCoreNode(node: CategorizableNode): boolean {
  return !!node.isMeshCore || typeof node.advType === 'number';
}

/**
 * Classify a node into one {@link NodeTypeCategory} bucket. Pure and total —
 * MeshCore nodes map by advType, Meshtastic nodes map by device role, and
 * unknown/missing data falls back to `'standard'` (MeshCore) or `'mtClient'`
 * (Meshtastic, the default role).
 */
export function getNodeTypeCategory(node: CategorizableNode): NodeTypeCategory {
  if (isMeshCoreNode(node)) {
    switch (toRoleNum(node.advType)) {
      case 1: return 'companion';
      case 2: return 'repeater';
      case 3: return 'roomServer';
      case 4: return 'sensor';
      default: return 'standard';
    }
  }
  // Meshtastic: map each role to its own category so the filter is meaningful
  // on a Meshtastic-only instance (issue #3610). Missing/garbage role => the
  // default CLIENT bucket rather than an unrelated MeshCore "standard".
  const roleNum = toRoleNum(node.user?.role ?? node.role);
  return MESHTASTIC_ROLE_TO_CATEGORY[roleNum] ?? 'mtClient';
}

/** A node passes the filter when its category is enabled (default: enabled). */
export function nodePassesTypeFilter(
  node: CategorizableNode,
  enabledByCategory: Partial<Record<NodeTypeCategory, boolean>>,
): boolean {
  return enabledByCategory[getNodeTypeCategory(node)] !== false;
}

/**
 * Compute the ordered set of categories the filter/legend should expose, given
 * the protocol families that are actually connected. A Meshtastic-only instance
 * gets only Meshtastic role categories; MeshCore-only gets the MeshCore
 * categories; both connected unions them (MeshCore first, then Meshtastic).
 *
 * `'standard'` (the MeshCore catch-all) is only meaningful for MeshCore, so it
 * rides along with the MeshCore set.
 */
export function categoriesForProtocols(opts: {
  meshcore: boolean;
  meshtastic: boolean;
}): NodeTypeCategory[] {
  const { meshcore, meshtastic } = opts;
  // When nothing is known yet, show everything rather than an empty filter.
  if (!meshcore && !meshtastic) return NODE_TYPE_CATEGORIES;
  const out: NodeTypeCategory[] = [];
  if (meshcore) out.push(...MESHCORE_CATEGORIES);
  if (meshtastic) out.push(...MESHTASTIC_CATEGORIES);
  return out;
}

/** Classify a source `type` string into its protocol family. */
export function sourceTypeProtocol(type: string | undefined | null): 'meshcore' | 'meshtastic' {
  return type === 'meshcore' ? 'meshcore' : 'meshtastic';
}
