import type { UiIconName } from '../icons';

/**
 * Shared MeshCore advert-type (role) presentation: the i18n label key and a
 * compact semantic role icon. Used by the node list (map page) and the Direct Messages
 * peer list so the role is shown consistently as an icon to the LEFT of the
 * node name (#3647).
 *
 * MeshCore advert types (firmware): 1=Companion, 2=Repeater, 3=Room Server,
 * 4=Sensor; 0/undefined = unknown.
 */
export const MESHCORE_DEVICE_TYPE_KEYS: Record<number, string> = {
  0: 'meshcore.device_type.unknown',
  1: 'meshcore.device_type.companion',
  2: 'meshcore.device_type.repeater',
  3: 'meshcore.device_type.room_server',
  4: 'meshcore.device_type.sensor',
};

/** English fallbacks for the role label (used as the t() default + title text). */
export const MESHCORE_DEVICE_TYPE_LABELS: Record<number, string> = {
  0: 'Unknown',
  1: 'Companion',
  2: 'Repeater',
  3: 'Room Server',
  4: 'Sensor',
};

/**
 * Compact role icon (emoji) for a MeshCore advert type. Returns an empty string
 * for unknown/unset types so callers can skip rendering rather than showing a
 * meaningless glyph.
 */
export function meshcoreRoleIconName(advType: number | null | undefined): UiIconName | null {
  switch (advType) {
    case 1: return 'companion';
    case 2: return 'repeater';
    case 3: return 'home';
    case 4: return 'sensor';
    default: return null;
  }
}

export function meshcoreRoleLabelKey(advType: number | null | undefined): string {
  return MESHCORE_DEVICE_TYPE_KEYS[advType ?? 0] ?? MESHCORE_DEVICE_TYPE_KEYS[0];
}

export function meshcoreRoleLabel(advType: number | null | undefined): string {
  return MESHCORE_DEVICE_TYPE_LABELS[advType ?? 0] ?? MESHCORE_DEVICE_TYPE_LABELS[0];
}
