/**
 * @vitest-environment jsdom
 *
 * Excluded-module gating across a config reload (#5065).
 *
 * `supportedModules` comes from the connected device, so one device's
 * exclusions must never gate another's sections. A reload whose response
 * carries no `supportedModules` has to clear the previous value rather than
 * keep it, because unknown means "fail open, show everything".
 *
 * Sibling *ConfigSection components are stubbed — this exercises only
 * ConfigurationTab's own wiring.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- hoisted mutable mock state -----------------------------------------
const h = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  showToast: vi.fn(),
  currentConfig: {} as Record<string, unknown>,
}));

// --- mocks ---------------------------------------------------------------
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: h.invalidateQueries,
  }),
}));

vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: h.showToast }) }));

vi.mock('../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 1, sourceName: 'test-source' }),
}));

vi.mock('../services/api', () => ({
  default: {
    getCurrentConfig: vi.fn(() => Promise.resolve(h.currentConfig)),
    getSecurityKeys: vi.fn().mockResolvedValue({}),
    setLoRaConfig: vi.fn().mockResolvedValue({ success: true }),
  },
}));

// Stub every sibling config section as a no-op — only LoRaConfigSection needs
// a real interactive save trigger for this test.
vi.mock('./configuration/NodeIdentitySection', () => ({ default: () => null }));
vi.mock('./configuration/DeviceConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/LoRaConfigSection', () => ({
  default: ({ onSave }: { onSave: () => Promise<void> }) => (
    <button data-testid="lora-save" onClick={() => void onSave()}>Save LoRa</button>
  ),
}));
vi.mock('./configuration/PositionConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/MQTTConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/NeighborInfoSection', () => ({ default: () => null }));
vi.mock('./configuration/NetworkConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/PowerConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/DisplayConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/TelemetryConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/ExternalNotificationConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/StoreForwardConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/RangeTestConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/CannedMessageConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/AudioConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/RemoteHardwareConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/DetectionSensorConfigSection', () => ({ default: () => null }));
// Same shape as the real section: header, then the notice (#5447), then controls.
vi.mock('./configuration/PaxcounterConfigSection', async () => {
  const { default: ModuleAvailabilityNotice } = await vi.importActual<
    typeof import('./configuration/ModuleAvailabilityNotice')
  >('./configuration/ModuleAvailabilityNotice');
  return {
    default: () => (
      <div className="settings-section">
        <h3>Paxcounter</h3>
        <ModuleAvailabilityNotice />
        <div data-testid="paxcounter-controls" />
      </div>
    ),
  };
});
vi.mock('./configuration/StatusMessageConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/TrafficManagementConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/MeshBeaconConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/SerialConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/AmbientLightingConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/SecurityConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/PkiDmDecryptionSection', () => ({ default: () => null }));
vi.mock('./configuration/ChannelsConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/GpioPinSummary', () => ({ default: () => null }));
vi.mock('./configuration/BackupManagementSection', () => ({ default: () => null }));
vi.mock('./configuration/ImportConfigModal', () => ({ ImportConfigModal: () => null }));
vi.mock('./configuration/ExportConfigModal', () => ({ ExportConfigModal: () => null }));
vi.mock('./SectionNav', () => ({ default: () => null }));

import ConfigurationTab from './ConfigurationTab';

const NOTICE = /not included in this device's firmware build/;

beforeEach(() => {
  vi.clearAllMocks();
  h.currentConfig = {};
});

describe('ConfigurationTab — excluded module gating (#5065)', () => {
  it('leaves every section enabled when the device reports no bitmask', async () => {
    render(<ConfigurationTab nodes={[]} channels={[]} />);

    expect(await screen.findByTestId('paxcounter-controls')).toBeInTheDocument();
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it('notices the section the device excluded, without hiding it', async () => {
    h.currentConfig = { supportedModules: { paxcounter: false, mqtt: true } };
    render(<ConfigurationTab nodes={[]} channels={[]} />);

    const notice = await screen.findByText(NOTICE);
    expect(notice).toBeInTheDocument();
    expect(screen.getByTestId('paxcounter-controls')).toBeInTheDocument();

    // The notice sits inside the Paxcounter wrapper, under its own header,
    // not above it where it reads as part of the section above (#5447).
    const pax = document.getElementById('config-paxcounter')!;
    expect(pax.contains(notice)).toBe(true);
    const header = screen.getByRole('heading', { name: 'Paxcounter' });
    expect(
      header.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

});

/*
 * Section spacing. Every section is the only child of its `#config-*` wrapper,
 * so the global `.settings-section:last-child` rule zeroes its bottom margin
 * and sections joined flush. The gap now lives on the wrappers' container.
 * jsdom does not apply stylesheets, so this pins the class hook and the rule.
 */
describe('ConfigurationTab — gap between config sections', () => {
  it('spaces the section wrappers from a class on their container', async () => {
    h.currentConfig = { supportedModules: { paxcounter: false } };
    render(<ConfigurationTab nodes={[]} channels={[]} />);
    await screen.findByText(NOTICE);

    const pax = document.getElementById('config-paxcounter')!;
    const stack = pax.parentElement!;
    expect(stack.classList.contains('settings-content')).toBe(true);
    const extra = Array.from(stack.classList).filter((c) => c !== 'settings-content');
    expect(extra).toHaveLength(1);
    expect(extra[0]).not.toBe('undefined');

    // Every direct child is a section wrapper, so the sibling rule spaces
    // sections and nothing else. The gated wrapper is still one of them.
    const children = Array.from(stack.children);
    expect(children.length).toBeGreaterThan(20);
    for (const child of children) {
      expect(child.id).toMatch(/^config-/);
    }
    expect(pax.querySelector('.settings-section')).not.toBeNull();
  });

  it('adds space only between wrappers, never after the last one', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(dir, 'ConfigurationTab.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\.sectionStack\s*>\s*\*\s*\+\s*\*\s*\{\s*margin-top:\s*2rem;\s*\}/);
    expect(css).not.toMatch(/\.sectionStack[^{]*\{[^}]*margin-bottom/);
  });
});
