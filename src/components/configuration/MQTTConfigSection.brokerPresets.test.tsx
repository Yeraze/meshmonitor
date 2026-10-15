/**
 * @vitest-environment jsdom
 *
 * #5689: the broker preset chooser on the device MQTT config. A preset fills
 * address, TLS and an empty login, touches no other field, and saves nothing.
 */
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));
vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'src-a', sourceName: 'A' }),
}));
const { saveBarRef } = vi.hoisted(() => ({ saveBarRef: { current: null as null | { hasChanges: boolean } } }));
vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: (opts: { hasChanges: boolean }) => {
    saveBarRef.current = opts;
  },
}));
vi.mock('../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [] }),
}));
const { putMock } = vi.hoisted(() => ({ putMock: vi.fn() }));
vi.mock('../../services/api', () => ({ default: { put: putMock } }));
vi.mock('../../init', () => ({ appBasename: '' }));

import MQTTConfigSection from './MQTTConfigSection';

interface Initial {
  address?: string;
  username?: string;
  password?: string;
  tls?: boolean;
}

const onSave = vi.fn(async () => {});
// Fields a preset does not own: any call to these is a bug.
const untouched = {
  setMqttEnabled: vi.fn(),
  setMqttEncryptionEnabled: vi.fn(),
  setMqttJsonEnabled: vi.fn(),
  setMqttRoot: vi.fn(),
  setProxyToClientEnabled: vi.fn(),
  setMapReportingEnabled: vi.fn(),
  setMapPublishIntervalSecs: vi.fn(),
  setMapPositionPrecision: vi.fn(),
  setMapShouldReportLocation: vi.fn(),
};

function Harness({ initial }: { initial: Initial }) {
  const [address, setAddress] = useState(initial.address ?? '');
  const [username, setUsername] = useState(initial.username ?? '');
  const [password, setPassword] = useState(initial.password ?? '');
  const [tls, setTls] = useState(initial.tls ?? false);
  return (
    <MQTTConfigSection
      mqttEnabled
      mqttAddress={address}
      mqttUsername={username}
      mqttPassword={password}
      mqttEncryptionEnabled
      mqttJsonEnabled={false}
      mqttRoot="msh/US/FL"
      tlsEnabled={tls}
      proxyToClientEnabled={false}
      mapReportingEnabled
      mapPublishIntervalSecs={3600}
      mapPositionPrecision={13}
      mapShouldReportLocation
      setMqttAddress={setAddress}
      setMqttUsername={setUsername}
      setMqttPassword={setPassword}
      setTlsEnabled={setTls}
      {...untouched}
      isSaving={false}
      onSave={onSave}
    />
  );
}

/** The shared PresetPicker chips (#5831): the pressed chip, and a click on one. */
const presetChips = (root: ParentNode) => root.querySelector('[data-testid="broker-preset-picker"]') as HTMLElement;
const chosenPreset = (root: ParentNode) =>
  (presetChips(root).querySelector('[aria-pressed="true"]') as HTMLElement | null)?.dataset.presetId;
const pickPreset = (root: ParentNode, id: string) =>
  fireEvent.click(presetChips(root).querySelector(`[data-preset-id="${id}"]`) as HTMLElement);
const field = (id: string) => document.getElementById(id) as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  saveBarRef.current = null;
});

describe('device MQTT config — broker presets (#5689)', () => {
  it.each([
    [{ address: '' }, 'meshtastic_public'],
    [{ address: 'mqtt.meshtastic.org', tls: true }, 'meshtastic_public_tls'],
    [{ address: 'broker.example.org' }, 'custom'],
  ])('opens on the preset the stored values match: %j → %s', (initial, expected) => {
    render(<Harness initial={initial} />);
    expect(chosenPreset(document)).toBe(expected);
  });

  it('fills host, TLS and an empty login, and leaves every other field alone', () => {
    render(<Harness initial={{ address: 'broker.example.org' }} />);
    pickPreset(document, 'meshtastic_public_tls');

    expect(field('mqttAddress').value).toBe('mqtt.meshtastic.org');
    expect(field('tlsEnabled').checked).toBe(true);
    expect(field('mqttUsername').value).toBe('meshdev');
    expect(field('mqttPassword').value).toBe('large4cats');
    expect(chosenPreset(document)).toBe('meshtastic_public_tls');
    expect(field('mqttRoot').value).toBe('msh/US/FL');
    for (const fn of Object.values(untouched)) expect(fn).not.toHaveBeenCalled();
  });

  it('sends and saves nothing on select: the save bar just shows a change', () => {
    render(<Harness initial={{ address: 'broker.example.org' }} />);
    expect(saveBarRef.current?.hasChanges).toBe(false);
    pickPreset(document, 'meshtastic_public');
    expect(onSave).not.toHaveBeenCalled();
    expect(putMock).not.toHaveBeenCalled();
    expect(saveBarRef.current?.hasChanges).toBe(true);
  });

  it('keeps a typed login and says which parts it kept', () => {
    render(<Harness initial={{ address: 'broker.example.org', username: 'me', password: 'secret' }} />);
    pickPreset(document, 'meshtastic_public');
    expect(field('mqttUsername').value).toBe('me');
    expect(field('mqttPassword').value).toBe('secret');
    expect(screen.getByTestId('broker-preset-kept').textContent).toContain('meshdev / large4cats');
  });

  it('Custom… changes no field and stays selected while the values still match a preset', () => {
    render(<Harness initial={{ address: '' }} />);
    pickPreset(document, 'custom');
    expect(chosenPreset(document)).toBe('custom');
    expect(field('mqttAddress').value).toBe('');
    expect(field('mqttUsername').value).toBe('');
    expect(field('tlsEnabled').checked).toBe(false);
  });

  it('Custom… ends once the fields change: put back to a preset (e.g. Dismiss), the preset shows', () => {
    render(<Harness initial={{ address: '' }} />);
    pickPreset(document, 'custom');
    fireEvent.change(field('mqttAddress'), { target: { value: 'my.broker' } });
    expect(chosenPreset(document)).toBe('custom');
    // What the save bar's Dismiss does: the stored values come back.
    fireEvent.change(field('mqttAddress'), { target: { value: '' } });
    expect(chosenPreset(document)).toBe('meshtastic_public');
  });

  it('falls back to Custom… once the user edits the address away from the preset', () => {
    render(<Harness initial={{ address: '' }} />);
    fireEvent.change(field('mqttAddress'), { target: { value: 'my.broker' } });
    expect(chosenPreset(document)).toBe('custom');
  });

  it('shows the discovery links and the public-broker line', () => {
    render(<Harness initial={{}} />);
    const links = screen.getByTestId('broker-preset-discovery').querySelectorAll('a');
    expect(Array.from(links).map((a) => a.getAttribute('href'))).toEqual([
      'https://meshtastic.org/docs/community/local-groups/',
      'https://meshmonitor.org/site-gallery.html',
    ]);
    expect(screen.getByTestId('broker-preset-privacy').textContent).toMatch(/anyone on the internet/);
  });
});
