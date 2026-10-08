/**
 * @vitest-environment jsdom
 *
 * The per-source nav convention (issue #5683):
 *
 *   Device Configuration = `configuration` icon + "Device Configuration"
 *   Settings             = `settings` icon      + "Settings"
 *
 * on every source type that has the page. Each source type builds its own nav,
 * so these tests render all of them against the real English locale and compare
 * what a user sees, then read the nav sources to fail one that spells either
 * entry itself instead of taking it from `sourceNavEntries.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, type RenderResult } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const en = JSON.parse(readFileSync(resolve('public/locales/en.json'), 'utf-8')) as Record<string, string>;

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  const { readFileSync: read } = await import('node:fs');
  const { resolve: res } = await import('node:path');
  const locale = JSON.parse(read(res('public/locales/en.json'), 'utf-8')) as Record<string, string>;
  // English as the app resolves it: the locale file wins, then the inline
  // fallback. A key missing from en.json with no fallback shows up as itself.
  return createReactI18nextMock((key: string, fallback?: unknown) =>
    locale[key] ?? (typeof fallback === 'string' ? fallback : key));
});

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ authStatus: { authenticated: true }, hasPermission: () => true }),
}));
vi.mock('../../contexts/IconStyleContext', () => ({
  useIconStyleOptional: () => 'lucide' as const,
}));
vi.mock('../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
}));

import Sidebar from '../Sidebar';
import { MeshCoreSubToolbar } from '../MeshCore/MeshCoreSubToolbar';
import { ReticulumSubToolbar } from '../Reticulum/ReticulumSubToolbar';
import { SourceNav } from './SourceNav';
import {
  DEVICE_CONFIGURATION_NAV_ENTRY,
  SOURCE_SETTINGS_NAV_ENTRY,
  deviceConfigurationNav,
  sourceSettingsNav,
} from './sourceNavEntries';

const sidebarProps = {
  activeTab: 'nodes' as const,
  setActiveTab: vi.fn(),
  hasPermission: () => true,
  isAdmin: true,
  isAuthenticated: true,
  unreadCounts: {},
  unreadCountsData: null,
  onMessagesClick: vi.fn(),
  onChannelsClick: vi.fn(),
  baseUrl: '',
};

const noop = () => {};

/** One nav per source type, with the id each gives the two shared entries. */
const NAVS: Record<string, { render: () => RenderResult; deviceConfigId: string | null; settingsId: string }> = {
  meshtastic: {
    render: () => render(<Sidebar {...sidebarProps} />),
    deviceConfigId: 'configuration',
    settingsId: 'settings',
  },
  meshcore: {
    render: () => render(
      <MeshCoreSubToolbar view="nodes" onSelect={noop} expanded onToggleExpanded={noop} />),
    deviceConfigId: 'configuration',
    settingsId: 'settings',
  },
  reticulum: {
    render: () => render(
      <ReticulumSubToolbar view="destinations" onSelect={noop} expanded onToggleExpanded={noop} sourceMode="own" />),
    deviceConfigId: 'configuration',
    settingsId: 'settings',
  },
  // An MQTT bridge has no device: its `mqtt-config` entry is a different page
  // (MeshMonitor's own connection and filter settings) and keeps its own label.
  mqtt_bridge: {
    render: () => render(<Sidebar {...sidebarProps} mqttReadOnly />),
    deviceConfigId: null,
    settingsId: 'settings',
  },
  // An MQTT broker source has no device and no bridge page.
  mqtt_broker: {
    render: () => render(<Sidebar {...sidebarProps} hideDeviceConfig />),
    deviceConfigId: null,
    settingsId: 'settings',
  },
};

interface Seen { label: string; shortLabel: string | null; name: string | null; icon: string }

function seen(container: HTMLElement, id: string): Seen | null {
  const button = container.querySelector(`[data-source-nav-item="${id}"]`);
  if (!button) return null;
  return {
    label: button.querySelector('[data-source-nav-label]')?.textContent ?? '',
    shortLabel: button.querySelector('[data-source-nav-short-label]')?.textContent ?? null,
    name: button.getAttribute('aria-label'),
    icon: button.querySelector('[data-source-nav-icon] svg')?.outerHTML ?? '',
  };
}

/** What the shared definition renders through SourceNav: the reference look. */
function reference(entry: { icon: Parameters<typeof SourceNav>[0]['sections'][0]['items'][0]['icon']; label: string; shortLabel?: string }): Seen {
  const { container, unmount } = render(
    <SourceNav sections={[{ items: [{ id: 'ref', onClick: noop, ...entry }] }]} activeId="" collapsed={false} />);
  const result = seen(container, 'ref')!;
  unmount();
  return result;
}

const t = (key: string, fallback: string) => en[key] ?? fallback;

describe('per-source nav convention (#5683)', () => {
  it('defines the two entries in English as the maintainer chose them', () => {
    expect(en[DEVICE_CONFIGURATION_NAV_ENTRY.labelKey]).toBe('Device Configuration');
    expect(en[DEVICE_CONFIGURATION_NAV_ENTRY.shortLabelKey]).toBe('Device Config');
    expect(DEVICE_CONFIGURATION_NAV_ENTRY.icon).toBe('configuration');
    expect(en[SOURCE_SETTINGS_NAV_ENTRY.labelKey]).toBe('Settings');
    expect(SOURCE_SETTINGS_NAV_ENTRY.icon).toBe('settings');
    // The inline fallbacks must agree with the locale file, not drift from it.
    expect(DEVICE_CONFIGURATION_NAV_ENTRY.fallback).toBe(en[DEVICE_CONFIGURATION_NAV_ENTRY.labelKey]);
    expect(DEVICE_CONFIGURATION_NAV_ENTRY.shortFallback).toBe(en[DEVICE_CONFIGURATION_NAV_ENTRY.shortLabelKey]);
    expect(SOURCE_SETTINGS_NAV_ENTRY.fallback).toBe(en[SOURCE_SETTINGS_NAV_ENTRY.labelKey]);
  });

  it('gives the two entries different icons', () => {
    expect(reference(deviceConfigurationNav(t)).icon).not.toBe(reference(sourceSettingsNav(t)).icon);
  });

  describe.each(Object.entries(NAVS))('%s nav', (_type, nav) => {
    it('shows Settings with the shared icon and label', () => {
      const want = reference(sourceSettingsNav(t));
      const { container } = nav.render();
      const got = seen(container, nav.settingsId);
      expect(got).not.toBeNull();
      expect(got).toEqual(want);
      expect(got!.label).toBe('Settings');
    });

    if (nav.deviceConfigId) {
      it('shows Device Configuration with the shared icon, label and accessible name', () => {
        const want = reference(deviceConfigurationNav(t));
        const { container } = nav.render();
        const got = seen(container, nav.deviceConfigId!);
        expect(got).not.toBeNull();
        expect(got).toEqual(want);
        expect(got!.label).toBe('Device Configuration');
        // The phone bar shows the short text; assistive tech still gets the full one.
        expect(got!.shortLabel).toBe('Device Config');
        expect(got!.name).toBe('Device Configuration');
      });
    } else {
      it('has no entry called Device Configuration, since it has no device', () => {
        const { container } = nav.render();
        const labels = [...container.querySelectorAll('[data-source-nav-label]')].map((el) => el.textContent);
        expect(labels).not.toContain('Device Configuration');
        expect(container.querySelector('[data-source-nav-item="configuration"]')).toBeNull();
      });
    }

    it('uses each of the two icons for one entry only', () => {
      const { container } = nav.render();
      const icons = [...container.querySelectorAll('[data-source-nav-item] [data-source-nav-icon] svg')]
        .map((svg) => svg.outerHTML);
      for (const entry of [sourceSettingsNav(t), deviceConfigurationNav(t)]) {
        const icon = reference(entry).icon;
        expect(icons.filter((html) => html === icon).length).toBeLessThanOrEqual(1);
      }
    });
  });

  it('leaves the MQTT bridge page under its own label', () => {
    // It holds MeshMonitor's connection and filter settings for the bridge; no
    // device is configured there, so "Device Configuration" would be false.
    const { container } = NAVS.mqtt_bridge.render();
    expect(seen(container, 'mqtt-config')?.label).toBe('Configuration');
  });

  it.each([
    'src/components/MeshCore/MeshCoreSubToolbar.module.css',
    'src/components/Reticulum/ReticulumSubToolbar.module.css',
  ])('%s keeps a rail wide enough for the full label', (file) => {
    // Measured: "Device Configuration" needs 147.3px and a 220px rail left 147.
    const width = readFileSync(resolve(file), 'utf-8').match(/--source-nav-expanded-width:\s*(\d+)px/);
    expect(Number(width?.[1])).toBeGreaterThanOrEqual(240);
  });

  it('labels the collapsed-rail tooltip with the full text', () => {
    const { container } = render(
      <MeshCoreSubToolbar view="nodes" onSelect={noop} expanded={false} onToggleExpanded={noop} />);
    expect(container.querySelector('[data-source-nav-item="configuration"]')?.getAttribute('title'))
      .toBe('Device Configuration');
  });
});

describe('no nav spells the shared entries itself (#5683)', () => {
  const NAV_SOURCES = [
    'src/components/Sidebar.tsx',
    'src/components/MeshCore/MeshCoreSubToolbar.tsx',
    'src/components/Reticulum/ReticulumSubToolbar.tsx',
  ];

  /** Comments dropped, so prose about the convention cannot trip the checks. */
  const code = (file: string) =>
    readFileSync(resolve(file), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it.each(NAV_SOURCES)('%s takes both entries from sourceNavEntries', (file) => {
    // The MQTT bridge page is not one of the shared entries; see NAVS above.
    const source = code(file).split('\n').filter((line) => !line.includes("'mqtt-config'")).join('\n');
    expect(source).toMatch(/from '\.\.?\/(nav\/)?sourceNavEntries'/);
    // A label key or English text for either entry, written in the nav itself.
    expect(source).not.toMatch(/['"](nav|meshcore\.nav|reticulum\.nav)\.(device|configuration|device_configuration|settings)['"]/);
    expect(source).not.toMatch(/['"](Device|Configuration|Device Configuration|Device Config|Settings)['"]/);
    // The `settings` icon belongs to the shared Settings entry alone.
    expect(source).not.toMatch(/icon:\s*'settings'/);
    expect(source).not.toMatch(/navItem\([^)]*'settings'\s*\)/);
  });

  it('uses the configuration icon outside the shared entry only for the MQTT bridge page', () => {
    for (const file of NAV_SOURCES) {
      const literal = code(file).split('\n').filter((line) => /'configuration'\s*[,)}]/.test(line) && /icon|navItem\(/.test(line));
      const allowed = literal.filter((line) => line.includes("'mqtt-config'"));
      // sharedNavItem('configuration', ...) names the tab id, not the icon.
      const offenders = literal.filter((line) => !line.includes("'mqtt-config'") && !line.includes('sharedNavItem('));
      expect(offenders, file).toEqual([]);
      expect(allowed.length).toBe(file.endsWith('Sidebar.tsx') ? 1 : 0);
    }
  });
});
