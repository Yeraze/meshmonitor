import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import {
  GLOBAL_SETTINGS_SECTIONS,
  SOURCE_SETTINGS_SECTIONS,
  adminCommandsNavItems,
  automationNavItems,
  buildConfigSurfaces,
  configurationNavItems,
  notificationsNavItems,
  settingsNavItems,
} from './configSections';

/** Returns the default where one is given, otherwise the key — as i18next does. */
const t = ((key: string, defaultValue?: string) => defaultValue ?? key) as unknown as TFunction;

const baseOptions = {
  isAdmin: true,
  canWriteSettings: true,
  databaseType: 'sqlite' as const,
  firmwareOtaEnabled: true,
};

describe('configSections', () => {
  it('gives every section a unique, deep-linkable id', () => {
    const all = [
      ...settingsNavItems(t, baseOptions),
      ...configurationNavItems(t),
      ...automationNavItems(t),
      ...notificationsNavItems(t),
      ...adminCommandsNavItems(t),
    ];
    const ids = all.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    // SectionNav builds a CSS selector from these, and drops anything that is
    // not a plain slug — a section it drops can never be filtered out.
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never leaves a settings section homeless between the two modes', () => {
    for (const item of settingsNavItems(t, baseOptions)) {
      const placed =
        GLOBAL_SETTINGS_SECTIONS.has(item.id) || SOURCE_SETTINGS_SECTIONS.has(item.id);
      expect(placed, `${item.id} is in neither GLOBAL nor SOURCE`).toBe(true);
    }
  });

  it('splits settings sections by mode without overlap', () => {
    const global = settingsNavItems(t, { ...baseOptions, mode: 'global' }).map((i) => i.id);
    const source = settingsNavItems(t, { ...baseOptions, mode: 'source' }).map((i) => i.id);
    expect(global).toContain('settings-language');
    expect(global).toContain('settings-coverage');
    expect(source).toContain('settings-danger');
    expect(global.filter((id) => source.includes(id))).toEqual([]);
  });

  describe('visibility gates mirror the tab', () => {
    it('hides admin-only sections from a non-admin', () => {
      const ids = settingsNavItems(t, { ...baseOptions, isAdmin: false }).map((i) => i.id);
      expect(ids).not.toContain('settings-remote-admin');
      expect(ids).not.toContain('settings-scripts');
      expect(ids).toContain('settings-language');
    });

    it('hides Database Maintenance on a non-SQLite backend', () => {
      const ids = settingsNavItems(t, { ...baseOptions, databaseType: 'postgres' }).map((i) => i.id);
      expect(ids).not.toContain('settings-maintenance');
    });

    it('hides Firmware Updates when OTA is off', () => {
      const ids = settingsNavItems(t, { ...baseOptions, firmwareOtaEnabled: false }).map((i) => i.id);
      expect(ids).not.toContain('settings-firmware');
    });

    it('hides the settings:write-gated batch jobs without that permission', () => {
      const ids = settingsNavItems(t, { ...baseOptions, canWriteSettings: false }).map((i) => i.id);
      expect(ids).not.toContain('settings-position-estimation');
      expect(ids).not.toContain('settings-mesh-issues');
      expect(ids).not.toContain('settings-coverage');
    });
  });

  describe('buildConfigSurfaces', () => {
    it('omits every per-source surface when there is no source', () => {
      const surfaces = buildConfigSurfaces(t, { ...baseOptions, sourceId: null, canUseAdmin: true });
      expect(surfaces.map((s) => s.key)).toEqual(['global-settings']);
    });

    it('offers the source tabs, in sidebar order, when a source is selected', () => {
      const surfaces = buildConfigSurfaces(t, { ...baseOptions, sourceId: 'abc', canUseAdmin: true });
      expect(surfaces.map((s) => s.key)).toEqual([
        'source-settings',
        'configuration',
        'automation',
        'notifications',
        'admin',
        'global-settings',
      ]);
    });

    it('drops the Admin surface for a user who cannot reach that tab', () => {
      const surfaces = buildConfigSurfaces(t, { ...baseOptions, sourceId: 'abc', canUseAdmin: false });
      expect(surfaces.map((s) => s.key)).not.toContain('admin');
    });

    it('escapes the source id it puts in a path', () => {
      const surfaces = buildConfigSurfaces(t, { ...baseOptions, sourceId: 'a b/c', canUseAdmin: false });
      const configuration = surfaces.find((s) => s.key === 'configuration');
      expect(configuration?.path).toBe('/source/a%20b%2Fc/configuration');
    });
  });
});
