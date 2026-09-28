/**
 * @vitest-environment jsdom
 *
 * Shared module-availability gate (#5065). The device's
 * DeviceMetadata.excluded_modules bitmask says which module configs a firmware
 * build left out; an unknown bitmask must leave every section alone.
 *
 * The notice must sit under the gated section's own <h3>, not above it, or it
 * reads as a warning about the section above (#5447).
 */
import fs from 'node:fs';
import path from 'node:path';
import type React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ModuleAvailabilityGate from './ModuleAvailabilityGate';
import ModuleAvailabilityNotice from './ModuleAvailabilityNotice';
import RemoteHardwareConfigSection from './RemoteHardwareConfigSection';
import AudioConfigSection from './AudioConfigSection';

vi.mock('../../hooks/useSaveBar', () => ({ useSaveBar: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown, opts?: Record<string, string>) =>
      typeof fallback === 'string'
        ? fallback.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => opts?.[k] ?? '')
        : key,
  }),
}));

/** Minimal stand-in with the same shape as every *ConfigSection. */
const FakeSection: React.FC<{ title: string }> = ({ title }) => (
  <div className="settings-section">
    <h3>{title}</h3>
    <ModuleAvailabilityNotice />
    <button>Save {title}</button>
  </div>
);

const follows = (a: Node, b: Node) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe('ModuleAvailabilityGate (#5065)', () => {
  it('renders the section untouched when the device reports it available', () => {
    render(
      <ModuleAvailabilityGate available={true} moduleName="MQTT">
        <FakeSection title="MQTT" />
      </ModuleAvailabilityGate>
    );
    expect(screen.getByRole('button', { name: 'Save MQTT' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('fails open when the device never reported a bitmask', () => {
    render(
      <ModuleAvailabilityGate moduleName="MQTT">
        <FakeSection title="MQTT" />
      </ModuleAvailabilityGate>
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps the section visible but notices and disables it when excluded', () => {
    const { container } = render(
      <ModuleAvailabilityGate available={false} moduleName="Paxcounter">
        <FakeSection title="Paxcounter" />
      </ModuleAvailabilityGate>
    );
    expect(screen.getByRole('status')).toHaveTextContent('Paxcounter');
    // The controls stay in the DOM — a section that vanishes reads as a bug.
    expect(screen.getByRole('button', { name: 'Save Paxcounter' })).toBeInTheDocument();
    expect(container.querySelector('[class*="gated"]')).not.toBeNull();
  });

  it('renders the notice outside a gate as nothing', () => {
    render(<ModuleAvailabilityNotice />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('ModuleAvailabilityGate notice placement (#5447)', () => {
  it('puts the notice after its own header, not after the section above', () => {
    // The reported case: Audio is compiled in, Remote Hardware is not.
    render(
      <>
        <div id="config-audio">
          <ModuleAvailabilityGate available={true} moduleName="Audio">
            <AudioConfigSection
              codec2Enabled={false} setCodec2Enabled={vi.fn()}
              pttPin={0} setPttPin={vi.fn()}
              bitrate={0} setBitrate={vi.fn()}
              i2sWs={0} setI2sWs={vi.fn()}
              i2sSd={0} setI2sSd={vi.fn()}
              i2sDin={0} setI2sDin={vi.fn()}
              i2sSck={0} setI2sSck={vi.fn()}
              isSaving={false} onSave={vi.fn()}
            />
          </ModuleAvailabilityGate>
        </div>
        <div id="config-remotehardware">
          <ModuleAvailabilityGate available={false} moduleName="Remote Hardware">
            <RemoteHardwareConfigSection
              enabled={false} setEnabled={vi.fn()}
              allowUndefinedPinAccess={false} setAllowUndefinedPinAccess={vi.fn()}
              isSaving={false} onSave={vi.fn()}
            />
          </ModuleAvailabilityGate>
        </div>
      </>
    );

    const notice = screen.getByRole('status');
    const rhSection = document.getElementById('config-remotehardware')!;
    const audioSection = document.getElementById('config-audio')!;
    const rhHeader = rhSection.querySelector('h3')!;

    // The notice lives inside the Remote Hardware wrapper, after its header.
    expect(rhSection.contains(notice)).toBe(true);
    expect(audioSection.contains(notice)).toBe(false);
    expect(follows(rhHeader, notice)).toBe(true);
    // And it is the header's very next element.
    expect(rhHeader.nextElementSibling).toBe(notice);
  });

  it('every gated section in ConfigurationTab renders the notice after its h3', () => {
    // Guard: a gated section that forgets <ModuleAvailabilityNotice /> would
    // grey out with no explanation.
    const tab = fs.readFileSync(path.resolve(__dirname, '../ConfigurationTab.tsx'), 'utf8');
    const gated = [...tab.matchAll(/<ModuleAvailabilityGate[^>]*>\s*<(\w+)/g)].map((m) => m[1]);
    expect(gated.length).toBeGreaterThan(0);
    for (const name of gated) {
      const src = fs.readFileSync(path.resolve(__dirname, `${name}.tsx`), 'utf8');
      expect(src, `${name} must render <ModuleAvailabilityNotice /> after its </h3>`).toMatch(
        /<\/h3>\s*<ModuleAvailabilityNotice\b[^>]*\/>/
      );
    }
  });
});
