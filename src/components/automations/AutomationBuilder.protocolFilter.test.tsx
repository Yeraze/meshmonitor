/**
 * FieldInput — `protocolFilter` on source/channel pickers (#4577 follow-up).
 * A `sourceMulti` / `sendSourceMulti` / `channelMulti` field with
 * `protocolFilter: 'meshtastic' | 'meshcore'` must list ONLY that protocol's
 * options. MeshCore is the explicit side (`type === 'meshcore'` /
 * `protocol === 'meshcore'`); everything else — native Meshtastic AND MQTT
 * bridge/broker sources — counts as Meshtastic. Used by the MT↔MC Bridge
 * template so the "Meshtastic" pickers don't list MeshCore options and
 * vice-versa. No filter set = every option shown (unchanged behavior).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FieldInput, type SourceOption, type UnifiedChannelOption } from './AutomationBuilder';
import type { FieldDef } from './catalog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string | Record<string, unknown>) =>
      typeof defaultValue === 'string' ? defaultValue : key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
  Trans: ({ children }: { children: React.ReactNode }) => children,
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

const sources: SourceOption[] = [
  { id: 'mt-tcp', name: 'Radio TCP', type: 'meshtastic_tcp', enabled: true, txEnabled: true },
  { id: 'mqtt', name: 'MQTT Bridge', type: 'mqtt_bridge', enabled: true, txEnabled: true },
  { id: 'mc', name: 'MeshCore Node', type: 'meshcore', enabled: true, txEnabled: true },
];

const channels: UnifiedChannelOption[] = [
  { name: 'Primary', protocol: 'meshtastic' },
  { name: 'gauntlet', protocol: 'meshtastic' },
  { name: 'Public', protocol: 'meshcore' },
];

function renderField(field: FieldDef) {
  return render(
    <FieldInput
      field={field}
      value={[]}
      onChange={() => {}}
      variables={[]}
      sources={sources}
      channels={channels}
      scripts={[]}
      regions={[]}
      nodes={[]}
      triggerType="trigger.message"
    />,
  );
}

describe('FieldInput protocolFilter — sources', () => {
  it("'meshtastic' shows native + MQTT sources, hides MeshCore", () => {
    renderField({ name: 's', label: 'MT source', kind: 'sourceMulti', protocolFilter: 'meshtastic' });
    expect(screen.getByText('Radio TCP')).toBeTruthy();
    expect(screen.getByText('MQTT Bridge')).toBeTruthy(); // MQTT is Meshtastic-protocol
    expect(screen.queryByText('MeshCore Node')).toBeNull();
  });

  it("'meshcore' shows only MeshCore sources", () => {
    renderField({ name: 's', label: 'MC source', kind: 'sourceMulti', protocolFilter: 'meshcore' });
    expect(screen.getByText('MeshCore Node')).toBeTruthy();
    expect(screen.queryByText('Radio TCP')).toBeNull();
    expect(screen.queryByText('MQTT Bridge')).toBeNull();
  });

  it('no filter shows every source (unchanged behavior)', () => {
    renderField({ name: 's', label: 'Any source', kind: 'sourceMulti' });
    expect(screen.getByText('Radio TCP')).toBeTruthy();
    expect(screen.getByText('MQTT Bridge')).toBeTruthy();
    expect(screen.getByText('MeshCore Node')).toBeTruthy();
  });
});

describe('FieldInput protocolFilter — channels', () => {
  it("'meshtastic' shows only Meshtastic channels", () => {
    renderField({ name: 'c', label: 'MT channel', kind: 'channelMulti', protocolFilter: 'meshtastic' });
    expect(screen.getByText('Primary')).toBeTruthy();
    expect(screen.getByText('gauntlet')).toBeTruthy();
    expect(screen.queryByText('Public')).toBeNull();
  });

  it("'meshcore' shows only MeshCore channels", () => {
    renderField({ name: 'c', label: 'MC channel', kind: 'channelMulti', protocolFilter: 'meshcore' });
    expect(screen.getByText('Public')).toBeTruthy();
    expect(screen.queryByText('Primary')).toBeNull();
    expect(screen.queryByText('gauntlet')).toBeNull();
  });
});
