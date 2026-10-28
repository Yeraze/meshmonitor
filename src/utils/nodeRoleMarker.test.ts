import { describe, it, expect } from 'vitest';
import {
  INFRASTRUCTURE_ROLES,
  isInfrastructureRole,
  isInfrastructureMarkerKind,
  isRoleBadgeKind,
  markerRoleBadge,
  ROLE_BADGE_KINDS,
  ROLE_MARKER_LEGEND,
  type MarkerRoleKind,
} from './nodeRoleMarker';
import { INFRASTRUCTURE_ROLES as SERVER_INFRASTRUCTURE_ROLES } from '../server/utils/airtimeCutoff';
import { DeviceRole } from '../constants/index';
import { categoryMarkerKind, markerRoleProps, MESHTASTIC_ROLE_TO_CATEGORY } from './nodeTypeCategory';
import en from '../../public/locales/en.json';

describe('markerRoleBadge (#6008)', () => {
  const expected: Record<number, MarkerRoleKind> = {
    0: 'none', // CLIENT
    1: 'clientMute',
    2: 'router',
    3: 'router', // ROUTER_CLIENT (deprecated)
    4: 'router', // REPEATER (deprecated)
    5: 'tracker',
    6: 'sensor',
    7: 'tak',
    8: 'none', // CLIENT_HIDDEN
    9: 'lostAndFound',
    10: 'tracker', // TAK_TRACKER shares the tracker badge
    11: 'routerLate',
    12: 'clientBase',
  };

  it.each(Object.entries(expected))('role %s -> %s', (role, kind) => {
    expect(markerRoleBadge(Number(role))).toBe(kind);
    // Roles also arrive as numeric strings from some payloads.
    expect(markerRoleBadge(role)).toBe(kind);
  });

  it('covers every DeviceRole value', () => {
    for (const role of Object.values(DeviceRole)) {
      expect(expected[role]).toBeDefined();
    }
  });

  it('returns none for missing or unknown roles', () => {
    expect(markerRoleBadge(undefined)).toBe('none');
    expect(markerRoleBadge(null)).toBe('none');
    expect(markerRoleBadge('')).toBe('none');
    expect(markerRoleBadge('abc')).toBe('none');
    expect(markerRoleBadge(99)).toBe('none');
  });

  it('splits kinds into infrastructure glyphs and corner badges', () => {
    expect(['router', 'routerLate', 'clientBase'].every((k) => isInfrastructureMarkerKind(k as MarkerRoleKind))).toBe(true);
    for (const k of ROLE_BADGE_KINDS) {
      expect(isRoleBadgeKind(k)).toBe(true);
      expect(isInfrastructureMarkerKind(k)).toBe(false);
    }
    expect(isRoleBadgeKind('none')).toBe(false);
  });
});

describe('isInfrastructureRole (#6008)', () => {
  it('is true for exactly ROUTER, ROUTER_CLIENT, REPEATER, ROUTER_LATE and CLIENT_BASE', () => {
    const infra = Array.from({ length: 13 }, (_, r) => r).filter((r) => isInfrastructureRole(r));
    expect(infra).toEqual([2, 3, 4, 11, 12]);
    expect(isInfrastructureRole('12')).toBe(true);
    expect(isInfrastructureRole(undefined)).toBe(false);
  });

  it('agrees with the infrastructure marker kinds', () => {
    for (let r = 0; r <= 12; r++) {
      expect(isInfrastructureRole(r)).toBe(isInfrastructureMarkerKind(markerRoleBadge(r)));
    }
  });

  it('is the same set the server uses for the airtime cutoff', () => {
    expect(SERVER_INFRASTRUCTURE_ROLES).toBe(INFRASTRUCTURE_ROLES);
    expect([...SERVER_INFRASTRUCTURE_ROLES].sort((a, b) => a - b)).toEqual([2, 3, 4, 11, 12]);
  });
});

describe('categoryMarkerKind / markerRoleProps (#6008)', () => {
  it('maps every Meshtastic category to its role kind', () => {
    for (const [role, category] of Object.entries(MESHTASTIC_ROLE_TO_CATEGORY)) {
      expect(categoryMarkerKind(category)).toBe(markerRoleBadge(Number(role)));
    }
  });

  it('returns none for MeshCore categories and missing input', () => {
    expect(categoryMarkerKind('repeater')).toBe('none');
    expect(categoryMarkerKind('sensor')).toBe('none');
    expect(categoryMarkerKind(undefined)).toBe('none');
  });

  it('marks CLIENT_BASE as infrastructure and TRACKER as a badge role', () => {
    expect(markerRoleProps({ user: { role: 12 } })).toEqual({ isRouter: true, roleCategory: 'mtClientBase' });
    expect(markerRoleProps({ role: 5 })).toEqual({ isRouter: false, roleCategory: 'mtTracker' });
    expect(markerRoleProps({ user: { role: '11' } })).toEqual({ isRouter: true, roleCategory: 'mtRouterLate' });
  });

  it('never treats a MeshCore node as Meshtastic infrastructure', () => {
    expect(markerRoleProps({ isMeshCore: true, advType: 2, role: 2 })).toEqual({ isRouter: false, roleCategory: 'repeater' });
  });
});

describe('ROLE_MARKER_LEGEND (#6008)', () => {
  it('lists every non-none kind once, infrastructure first', () => {
    expect(ROLE_MARKER_LEGEND.map((e) => e.kind)).toEqual([
      'router', 'routerLate', 'clientBase', ...ROLE_BADGE_KINDS,
    ]);
  });

  it('has an en.json string for every label and hint, matching the fallback', () => {
    const strings = en as Record<string, string>;
    for (const e of ROLE_MARKER_LEGEND) {
      expect(strings[e.labelKey]).toBe(e.label);
      expect(strings[e.hintKey]).toBe(e.hint);
    }
  });
});
