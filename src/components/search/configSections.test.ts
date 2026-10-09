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
import { matchesQuery, tokenize } from './configSearchMatch';

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

  it('files Sorting under Global Settings, since its keys are global (#5368)', () => {
    // preferredSortField / preferredSortDirection / preferredDashboardSortOption
    // are plain global settings; filing the section per-source (#5182) made it
    // unreachable from /settings.
    const global = settingsNavItems(t, { ...baseOptions, mode: 'global' }).map((i) => i.id);
    const source = settingsNavItems(t, { ...baseOptions, mode: 'source' }).map((i) => i.id);
    expect(global).toContain('settings-sorting');
    expect(source).not.toContain('settings-sorting');
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

    it('lists Firmware Updates under Device Configuration, never under Settings (#5683 follow-up)', () => {
      // It acts on the device. Same gate as before: an admin, with OTA enabled.
      for (const mode of [undefined, 'source', 'global'] as const) {
        expect(settingsNavItems(t, { ...baseOptions, mode }).map((i) => i.id)).not.toContain('settings-firmware');
      }
      expect(configurationNavItems(t, { showFirmware: true }).map((i) => i.id)).toContain('config-firmware');
      expect(configurationNavItems(t, { showFirmware: false }).map((i) => i.id)).not.toContain('config-firmware');
      expect(configurationNavItems(t).map((i) => i.id)).not.toContain('config-firmware');
    });

    it('lists PKI DM decryption under a radio source\'s Settings, for configuration:read', () => {
      const radio = { ...baseOptions, mode: 'source' as const, sourceType: 'meshtastic_tcp', canReadConfiguration: true };
      expect(settingsNavItems(t, radio).map((i) => i.id)).toContain('settings-pki-dm');
      expect(configurationNavItems(t, { showFirmware: true }).map((i) => i.id)).not.toContain('config-pki-dm');
      // The grant its route checks, not the one that opens Settings.
      expect(settingsNavItems(t, { ...radio, canReadConfiguration: false }).map((i) => i.id)).not.toContain('settings-pki-dm');
      // Sources with no radio key, and the global page.
      for (const sourceType of ['mqtt_bridge', 'mqtt_broker', 'meshcore', 'reticulum', null, undefined]) {
        expect(settingsNavItems(t, { ...radio, sourceType }).map((i) => i.id), String(sourceType)).not.toContain('settings-pki-dm');
      }
      expect(settingsNavItems(t, { ...radio, mode: 'global' }).map((i) => i.id)).not.toContain('settings-pki-dm');
    });

    it('lists Reliable PKI under a Meshtastic radio source\'s Settings only (#5691)', () => {
      const radio = { ...baseOptions, mode: 'source' as const, sourceType: 'meshtastic_tcp' };
      expect(settingsNavItems(t, radio).map((i) => i.id)).toContain('settings-reliable-pki');
      for (const sourceType of ['mqtt_bridge', 'mqtt_broker', 'meshcore', 'reticulum', null]) {
        expect(settingsNavItems(t, { ...radio, sourceType }).map((i) => i.id), String(sourceType)).not.toContain('settings-reliable-pki');
      }
      // The global default lives inside Global → Security, not as its own section.
      expect(settingsNavItems(t, { ...radio, mode: 'global' }).map((i) => i.id)).not.toContain('settings-reliable-pki');
      expect(settingsNavItems(t, { ...radio, mode: 'global' }).map((i) => i.id)).toContain('settings-security');
    });

    it('lists the MQTT bridge setup under a bridge\'s Settings, for sources:read', () => {
      const bridge = { ...baseOptions, mode: 'source' as const, sourceType: 'mqtt_bridge', canReadSources: true };
      expect(settingsNavItems(t, bridge).map((i) => i.id)).toContain('settings-mqtt-bridge');
      // First on the page, as it is rendered.
      expect(settingsNavItems(t, bridge)[0].id).toBe('settings-mqtt-bridge');
      expect(settingsNavItems(t, { ...bridge, canReadSources: false }).map((i) => i.id)).not.toContain('settings-mqtt-bridge');
      for (const sourceType of ['mqtt_broker', 'meshtastic_tcp', 'meshcore', null]) {
        expect(settingsNavItems(t, { ...bridge, sourceType }).map((i) => i.id), String(sourceType)).not.toContain('settings-mqtt-bridge');
      }
      expect(settingsNavItems(t, { ...bridge, mode: 'global' }).map((i) => i.id)).not.toContain('settings-mqtt-bridge');
    });

    it('lists the Reticulum retention cap under Global Settings only', () => {
      expect(settingsNavItems(t, { ...baseOptions, mode: 'global' }).map((i) => i.id)).toContain('settings-reticulum');
      expect(settingsNavItems(t, { ...baseOptions, mode: 'source', sourceType: 'reticulum' }).map((i) => i.id))
        .not.toContain('settings-reticulum');
      expect(GLOBAL_SETTINGS_SECTIONS.has('settings-reticulum')).toBe(true);
      expect(SOURCE_SETTINGS_SECTIONS.has('settings-reticulum')).toBe(false);
    });

    it('hides the settings:write-gated batch jobs without that permission', () => {
      const ids = settingsNavItems(t, { ...baseOptions, canWriteSettings: false }).map((i) => i.id);
      expect(ids).not.toContain('settings-position-estimation');
      expect(ids).not.toContain('settings-mesh-issues');
      expect(ids).not.toContain('settings-coverage');
    });

    // #5277 P2 WP3, widened P3 WP4
    it('shows Coverage recording only in source mode, for MQTT-shaped source types, with settings write', () => {
      const mqttSource = { ...baseOptions, mode: 'source' as const, sourceType: 'mqtt_broker' };
      expect(settingsNavItems(t, mqttSource).map((i) => i.id)).toContain('settings-coverage-mqtt');

      const bridgeSource = { ...baseOptions, mode: 'source' as const, sourceType: 'mqtt_bridge' };
      expect(settingsNavItems(t, bridgeSource).map((i) => i.id)).toContain('settings-coverage-mqtt');

      // MeshCore Observer sources (#5277 P3 WP4) also get the section.
      const observerSource = { ...baseOptions, mode: 'source' as const, sourceType: 'meshcore_mqtt' };
      expect(settingsNavItems(t, observerSource).map((i) => i.id)).toContain('settings-coverage-mqtt');

      // Not an MQTT-shaped source type.
      const tcpSource = { ...baseOptions, mode: 'source' as const, sourceType: 'meshtastic_tcp' };
      expect(settingsNavItems(t, tcpSource).map((i) => i.id)).not.toContain('settings-coverage-mqtt');

      // A device-backed MeshCore companion source is not MQTT-shaped either.
      const companionSource = { ...baseOptions, mode: 'source' as const, sourceType: 'meshcore' };
      expect(settingsNavItems(t, companionSource).map((i) => i.id)).not.toContain('settings-coverage-mqtt');

      // Global mode has no single source, even if a sourceType is passed.
      expect(settingsNavItems(t, { ...baseOptions, mode: 'global' as const, sourceType: 'mqtt_broker' })
        .map((i) => i.id)).not.toContain('settings-coverage-mqtt');

      // Gated on settings:write like the other batch-job sections.
      expect(settingsNavItems(t, { ...mqttSource, canWriteSettings: false }).map((i) => i.id))
        .not.toContain('settings-coverage-mqtt');
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

    it('names the two per-source pages as the nav does (#5683)', () => {
      const surfaces = buildConfigSurfaces(t, { ...baseOptions, sourceId: 'abc', canUseAdmin: false });
      expect(surfaces.find((s) => s.key === 'configuration')?.label).toBe('Device Configuration');
      expect(surfaces.find((s) => s.key === 'source-settings')?.label).toBe('Settings');
    });

    it('finds the device page under either word of its old labels (#5683)', () => {
      // The page was "Device" on Meshtastic and "Configuration" elsewhere. The
      // palette folds the page name into every hit's haystack (ConfigSearchModal).
      const surfaces = buildConfigSurfaces(t, { ...baseOptions, sourceId: 'abc', canUseAdmin: false });
      const configuration = surfaces.find((s) => s.key === 'configuration')!;
      expect(configuration.items.length).toBeGreaterThan(0);
      for (const word of ['device', 'configuration', 'device configuration']) {
        for (const item of configuration.items) {
          const haystack = [configuration.label, item.label, (item.keywords ?? []).join(' ')].join(' ');
          expect(matchesQuery(haystack, tokenize(word)), `${word} / ${item.label}`).toBe(true);
        }
      }
    });

    describe('a search for a moved control lands on its new page (#5683 follow-up)', () => {
      const viewer = { ...baseOptions, canUseAdmin: false, canReadSources: true, canReadConfiguration: true };
      /** [surface key, path#id] of every section the query matches, as the palette matches. */
      const hits = (query: string, context: Parameters<typeof buildConfigSurfaces>[1]) =>
        buildConfigSurfaces(t, context).flatMap((surface) =>
          surface.items
            .filter((item) => matchesQuery([item.label, (item.keywords ?? []).join(' ')].join(' '), tokenize(query)))
            .map((item) => `${surface.path}#${item.id}`));

      it('"firmware" on a Meshtastic radio: Device Configuration, not Settings', () => {
        const found = hits('firmware', { ...viewer, sourceId: 'abc', sourceType: 'meshtastic_tcp' });
        expect(found).toContain('/source/abc/configuration#config-firmware');
        expect(found.filter((hit) => hit.startsWith('/source/abc/settings'))).toEqual([]);
      });

      it('"firmware" is not offered to a non-admin', () => {
        const found = hits('firmware updates', { ...viewer, isAdmin: false, sourceId: 'abc', sourceType: 'meshtastic_tcp' });
        expect(found).toEqual([]);
      });

      it('"pki direct message" on a Meshtastic radio: Settings, not Device Configuration', () => {
        const found = hits('pki direct message', { ...viewer, sourceId: 'abc', sourceType: 'meshtastic_tcp' });
        expect(found).toEqual(['/source/abc/settings#settings-pki-dm']);
      });

      it('"bridge" on an MQTT bridge: the Settings section', () => {
        const found = hits('bridge', { ...viewer, sourceId: 'abc', sourceType: 'mqtt_bridge' });
        expect(found).toContain('/source/abc/settings#settings-mqtt-bridge');
      });

      it.each(['upstream', 'forwarding', 'subscribe', 'publish', 'rewrite', 'geo', 'password'])(
        'bridge field word "%s" finds the bridge section',
        (word) => {
          expect(hits(word, { ...viewer, sourceId: 'abc', sourceType: 'mqtt_bridge' }))
            .toContain('/source/abc/settings#settings-mqtt-bridge');
        },
      );

      it('"retention" finds the Reticulum cap on Global Settings, from anywhere', () => {
        expect(hits('destination retention', { ...viewer, sourceId: null })).toEqual(['/settings#settings-reticulum']);
        expect(hits('reticulum', { ...viewer, sourceId: 'abc', sourceType: 'meshtastic_tcp' }))
          .toContain('/settings#settings-reticulum');
      });

      it.each(['mqtt_bridge', 'mqtt_broker'])('a %s source offers no Device Configuration page to land on', (sourceType) => {
        const surfaces = buildConfigSurfaces(t, { ...viewer, sourceId: 'abc', sourceType });
        expect(surfaces.map((s) => s.key)).not.toContain('configuration');
        expect(hits('firmware', { ...viewer, sourceId: 'abc', sourceType })).toEqual([]);
      });

      it('names the install-wide page "Global Settings", from the shared entry', () => {
        const surfaces = buildConfigSurfaces(t, { ...viewer, sourceId: 'abc', sourceType: 'meshtastic_tcp' });
        expect(surfaces.find((s) => s.key === 'global-settings')?.label).toBe('Global Settings');
      });
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
