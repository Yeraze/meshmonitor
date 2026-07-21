import { describe, it, expect } from 'vitest';
import { meshcoreRoleIconName, meshcoreRoleLabelKey, meshcoreRoleLabel } from './meshcoreRole';

describe('meshcoreRole (#3647)', () => {
  it('maps each known advert type to a compact icon', () => {
    expect(meshcoreRoleIconName(1)).toBe('companion');
    expect(meshcoreRoleIconName(2)).toBe('repeater');
    expect(meshcoreRoleIconName(3)).toBe('home');
    expect(meshcoreRoleIconName(4)).toBe('sensor');
  });

  it('returns an empty string for unknown/unset types so callers can skip rendering', () => {
    expect(meshcoreRoleIconName(0)).toBeNull();
    expect(meshcoreRoleIconName(undefined)).toBeNull();
    expect(meshcoreRoleIconName(null)).toBeNull();
    expect(meshcoreRoleIconName(99)).toBeNull();
  });

  it('provides an i18n key and English fallback label per type', () => {
    expect(meshcoreRoleLabelKey(2)).toBe('meshcore.device_type.repeater');
    expect(meshcoreRoleLabel(2)).toBe('Repeater');
    expect(meshcoreRoleLabel(3)).toBe('Room Server');
    // unknown / unset fall back to the "unknown" entry
    expect(meshcoreRoleLabelKey(undefined)).toBe('meshcore.device_type.unknown');
    expect(meshcoreRoleLabel(undefined)).toBe('Unknown');
  });
});
