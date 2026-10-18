/**
 * @vitest-environment jsdom
 *
 * #5794: saved broker presets on the device MQTT config. A non-admin is never
 * shown a saved login; picking such a preset fills host, TLS and root topic,
 * and Save passes the preset id so the server fills the login in.
 */
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

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
const { saveBarRef, presetsRef } = vi.hoisted(() => ({
  saveBarRef: { current: null as null | { hasChanges: boolean; onSave: () => Promise<void> } },
  presetsRef: { current: { canManage: false, presets: [] as unknown[] } },
}));
vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: (opts: { hasChanges: boolean; onSave: () => Promise<void> }) => {
    saveBarRef.current = opts;
  },
}));
vi.mock('../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [] }),
}));
vi.mock('../../hooks/useMqttBrokerPresets', () => {
  const action = () => ({ mutateAsync: vi.fn(), isPending: false });
  return {
    useMqttBrokerPresets: () => presetsRef.current,
    useCreateBrokerPreset: action,
    useUpdateBrokerPreset: action,
    useDeleteBrokerPreset: action,
  };
});
vi.mock('../../services/api', () => ({ default: { put: vi.fn() } }));
vi.mock('../../init', () => ({ appBasename: '' }));

import MQTTConfigSection from './MQTTConfigSection';

const SAVED = {
  id: 4,
  name: 'Odd-port broker',
  host: 'broker.example.org',
  port: 1884,
  tls: false,
  rootTopic: 'msh/US/FL',
  hasUsername: true,
  hasPassword: true,
};

const onSave = vi.fn(async (_extra?: { brokerPresetId?: number }) => true);

function Harness({ initialAddress = 'other.example.org' }: { initialAddress?: string }) {
  const [address, setAddress] = useState(initialAddress);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [tls, setTls] = useState(false);
  const [root, setRoot] = useState('msh/US');
  return (
    <MQTTConfigSection
      mqttEnabled
      mqttAddress={address}
      mqttUsername={username}
      mqttPassword={password}
      mqttEncryptionEnabled
      mqttJsonEnabled={false}
      mqttRoot={root}
      tlsEnabled={tls}
      proxyToClientEnabled={false}
      mapReportingEnabled={false}
      mapPublishIntervalSecs={3600}
      mapPositionPrecision={13}
      mapShouldReportLocation={false}
      setMqttEnabled={vi.fn()}
      setMqttAddress={setAddress}
      setMqttUsername={setUsername}
      setMqttPassword={setPassword}
      setMqttEncryptionEnabled={vi.fn()}
      setMqttJsonEnabled={vi.fn()}
      setMqttRoot={setRoot}
      setTlsEnabled={setTls}
      setProxyToClientEnabled={vi.fn()}
      setMapReportingEnabled={vi.fn()}
      setMapPublishIntervalSecs={vi.fn()}
      setMapPositionPrecision={vi.fn()}
      setMapShouldReportLocation={vi.fn()}
      isSaving={false}
      onSave={onSave}
    />
  );
}

const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const pickSaved = () =>
  fireEvent.click(
    screen.getByTestId('broker-preset-saved-picker').querySelector('[data-preset-id="saved:4"]') as HTMLElement,
  );

beforeEach(() => {
  vi.clearAllMocks();
  saveBarRef.current = null;
  presetsRef.current = { canManage: false, presets: [SAVED] };
});

describe('device MQTT config — saved broker presets (#5794)', () => {
  it('fills host:port and root, leaves the hidden login blank, and Save sends the preset id', async () => {
    render(<Harness />);
    pickSaved();
    expect(field('mqttAddress').value).toBe('broker.example.org:1884');
    expect(field('mqttRoot').value).toBe('msh/US/FL');
    expect(field('mqttUsername').value).toBe('');
    expect(field('mqttPassword').value).toBe('');
    expect(screen.getByTestId('broker-preset-kept').textContent).toMatch(/added when you save/);
    // Never names the login.
    expect(document.body.textContent).not.toMatch(/undefined/);

    await act(async () => {
      await saveBarRef.current!.onSave();
    });
    expect(onSave).toHaveBeenCalledWith({ brokerPresetId: 4 });
  });

  it('sends no preset id after the address is edited away from the preset', async () => {
    render(<Harness />);
    pickSaved();
    fireEvent.change(field('mqttAddress'), { target: { value: 'elsewhere.example.org' } });
    await act(async () => {
      await saveBarRef.current!.onSave();
    });
    expect(onSave).toHaveBeenCalledWith(undefined);
  });

  it('hides Save as / Manage from a non-admin and shows them to an admin', () => {
    const { unmount } = render(<Harness />);
    expect(screen.queryByTestId('broker-preset-manage')).toBeNull();
    unmount();
    presetsRef.current = { canManage: true, presets: [{ ...SAVED, username: 'u', password: 'p' }] };
    render(<Harness />);
    expect(screen.getByTestId('broker-preset-manage')).toBeInTheDocument();
    expect(screen.getByTestId('broker-preset-save-as')).not.toBeDisabled();
  });
});
