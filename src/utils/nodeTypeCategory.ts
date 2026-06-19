/**
 * Node-type categorization shared by the map's role icons, the node-type
 * filter, and the legend (issue #3546). One function decides a node's category
 * so the icon a user sees and the checkbox that hides it can never disagree.
 *
 * MeshCore advert types (firmware): Chat/Companion=1, Repeater=2, Room=3,
 * Sensor=4 (`ADV_TYPE_NAME` in meshcorePacketDecode.ts; `MeshCoreDeviceType`
 * in meshcoreManager.ts). The feature request's "Observer" maps to the real
 * Sensor advert type. Meshtastic nodes have no advert type — their ROUTER role
 * (value 2) is treated as a repeater so infrastructure folds into one category
 * across both protocols; everything else is "standard".
 */

export type NodeTypeCategory =
  | 'repeater'
  | 'roomServer'
  | 'sensor'
  | 'companion'
  | 'standard';

/** Display order for the filter checkboxes and legend (infrastructure first). */
export const NODE_TYPE_CATEGORIES: NodeTypeCategory[] = [
  'repeater',
  'roomServer',
  'sensor',
  'companion',
  'standard',
];

export interface NodeTypeCategoryMeta {
  key: NodeTypeCategory;
  /** i18n key (see public/locales/*.json). */
  labelKey: string;
  /** English fallback so untranslated locales still render. */
  label: string;
}

export const NODE_TYPE_CATEGORY_META: Record<NodeTypeCategory, NodeTypeCategoryMeta> = {
  repeater:   { key: 'repeater',   labelKey: 'map.nodeType.repeater',   label: 'Repeater' },
  roomServer: { key: 'roomServer', labelKey: 'map.nodeType.roomServer', label: 'Room Server' },
  sensor:     { key: 'sensor',     labelKey: 'map.nodeType.sensor',     label: 'Sensor' },
  companion:  { key: 'companion',  labelKey: 'map.nodeType.companion',  label: 'Companion' },
  standard:   { key: 'standard',   labelKey: 'map.nodeType.standard',   label: 'Standard' },
};

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

/**
 * Classify a node into one of the five {@link NodeTypeCategory} buckets. Pure
 * and total — unknown/missing role data falls back to `'standard'`.
 */
export function getNodeTypeCategory(node: CategorizableNode): NodeTypeCategory {
  const isMeshCore = !!node.isMeshCore || typeof node.advType === 'number';
  if (isMeshCore) {
    switch (toRoleNum(node.advType)) {
      case 1: return 'companion';
      case 2: return 'repeater';
      case 3: return 'roomServer';
      case 4: return 'sensor';
      default: return 'standard';
    }
  }
  // Meshtastic: ROUTER (role 2) is infrastructure; mirror the existing
  // `isRouter` test in NodeMarkersLayer so the tower icon stays consistent.
  if (toRoleNum(node.user?.role ?? node.role) === 2) return 'repeater';
  return 'standard';
}

/** A node passes the filter when its category is enabled (default: enabled). */
export function nodePassesTypeFilter(
  node: CategorizableNode,
  enabledByCategory: Partial<Record<NodeTypeCategory, boolean>>,
): boolean {
  return enabledByCategory[getNodeTypeCategory(node)] !== false;
}
