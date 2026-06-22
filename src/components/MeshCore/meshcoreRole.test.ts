import { describe, it, expect } from 'vitest';
import { meshcoreRoleIcon, meshcoreRoleLabelKey, meshcoreRoleLabel } from './meshcoreRole';

describe('meshcoreRole (#3647)', () => {
  it('maps each known advert type to a compact icon', () => {
    expect(meshcoreRoleIcon(1)).toBe('📱'); // Companion
    expect(meshcoreRoleIcon(2)).toBe('📡'); // Repeater
    expect(meshcoreRoleIcon(3)).toBe('🏠'); // Room Server
    expect(meshcoreRoleIcon(4)).toBe('🌡️'); // Sensor
  });

  it('returns an empty string for unknown/unset types so callers can skip rendering', () => {
    expect(meshcoreRoleIcon(0)).toBe('');
    expect(meshcoreRoleIcon(undefined)).toBe('');
    expect(meshcoreRoleIcon(null)).toBe('');
    expect(meshcoreRoleIcon(99)).toBe('');
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
