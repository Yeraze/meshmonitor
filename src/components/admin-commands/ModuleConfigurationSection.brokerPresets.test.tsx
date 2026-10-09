/**
 * @vitest-environment jsdom
 *
 * #5689: the broker preset chooser on remote-admin MQTT config. It edits the
 * form through `onMQTTConfigChange` (address, username, password, tlsEnabled
 * only) and never calls the MQTT save, which is what sends to the node.
 */
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

import { ModuleConfigurationSection } from './ModuleConfigurationSection';

const Section: React.FC<{ id: string; title: string; children: React.ReactNode }> = ({ id, children }) => (
  <div data-testid={id}>{children}</div>
);

interface Mqtt {
  enabled: boolean;
  address: string;
  username: string;
  password: string;
  encryptionEnabled: boolean;
  jsonEnabled: boolean;
  root: string;
  tlsEnabled: boolean;
}

const saveMqtt = vi.fn(async () => {});
const changes: Array<[string, unknown]> = [];

function Harness({ initial }: { initial: Partial<Mqtt> }) {
  const [mqtt, setMqtt] = useState<Mqtt>({
    enabled: true,
    address: '',
    username: '',
    password: '',
    encryptionEnabled: true,
    jsonEnabled: false,
    root: 'msh/US',
    tlsEnabled: false,
    ...initial,
  });
  const noop = vi.fn();
  const noopAsync = vi.fn(async () => {});
  return (
    <ModuleConfigurationSection
      CollapsibleSection={Section}
      mqttEnabled={mqtt.enabled}
      mqttAddress={mqtt.address}
      mqttUsername={mqtt.username}
      mqttPassword={mqtt.password}
      mqttEncryptionEnabled={mqtt.encryptionEnabled}
      mqttJsonEnabled={mqtt.jsonEnabled}
      mqttRoot={mqtt.root}
      mqttTlsEnabled={mqtt.tlsEnabled}
      onMQTTConfigChange={(f, v) => {
        changes.push([f, v]);
        setMqtt((prev) => ({ ...prev, [f]: v }));
      }}
      onSaveMQTTConfig={saveMqtt}
      neighborInfoEnabled={false}
      neighborInfoUpdateInterval={0}
      neighborInfoTransmitOverLora={false}
      onNeighborInfoConfigChange={noop}
      onSaveNeighborInfoConfig={noopAsync}
      telemetryDeviceUpdateInterval={0}
      telemetryDeviceTelemetryEnabled={false}
      telemetryEnvironmentUpdateInterval={0}
      telemetryEnvironmentMeasurementEnabled={false}
      telemetryEnvironmentScreenEnabled={false}
      telemetryEnvironmentDisplayFahrenheit={false}
      telemetryAirQualityEnabled={false}
      telemetryAirQualityInterval={0}
      telemetryPowerMeasurementEnabled={false}
      telemetryPowerUpdateInterval={0}
      telemetryPowerScreenEnabled={false}
      telemetryHealthMeasurementEnabled={false}
      telemetryHealthUpdateInterval={0}
      telemetryHealthScreenEnabled={false}
      onTelemetryConfigChange={noop}
      onSaveTelemetryConfig={noopAsync}
      statusMessageNodeStatus=""
      onStatusMessageConfigChange={noop}
      onSaveStatusMessageConfig={noopAsync}
      statusMessageIsDisabled={false}
      trafficManagementPositionMinIntervalSecs={0}
      trafficManagementNodeinfoDirectResponseMaxHops={0}
      trafficManagementRateLimitWindowSecs={0}
      trafficManagementRateLimitMaxPackets={0}
      trafficManagementUnknownPacketThreshold={0}
      onTrafficManagementConfigChange={noop}
      onSaveTrafficManagementConfig={noopAsync}
      trafficManagementIsDisabled={false}
      meshBeaconListenEnabled={false}
      meshBeaconBroadcastEnabled={false}
      meshBeaconLegacySplit={false}
      meshBeaconBroadcastMessage=""
      meshBeaconBroadcastOfferChannelName=""
      meshBeaconBroadcastOfferChannelPsk=""
      meshBeaconBroadcastOfferRegion={0}
      meshBeaconBroadcastOfferPreset={null}
      meshBeaconBroadcastIntervalSecs={0}
      meshBeaconBroadcastTargets={[]}
      onMeshBeaconConfigChange={noop}
      onMeshBeaconTargetsChange={noop}
      onSaveMeshBeaconConfig={noopAsync}
      meshBeaconIsDisabled={false}
      isExecuting={false}
      selectedNodeNum={999}
      takTeam={0}
      takRole={0}
      onTAKConfigChange={noop}
      onSaveTAKConfig={noopAsync}
      takIsDisabled={false}
    />
  );
}

const mqttSection = () => screen.getByTestId('admin-mqtt-config');
const select = () => mqttSection().querySelector('[data-testid="broker-preset-select"]') as HTMLSelectElement;

beforeEach(() => {
  vi.clearAllMocks();
  changes.length = 0;
});

describe('remote-admin MQTT config — broker presets (#5689)', () => {
  it.each([
    [{ address: '' }, 'meshtastic_public'],
    [{ address: 'mqtt.meshtastic.org', tlsEnabled: true }, 'meshtastic_public_tls'],
    [{ address: '10.0.0.5' }, 'custom'],
  ])('opens on the preset the loaded values match: %j → %s', (initial, expected) => {
    render(<Harness initial={initial} />);
    expect(select().value).toBe(expected);
  });

  it('changes only address, login and TLS, and never sends to the node', () => {
    render(<Harness initial={{ address: '10.0.0.5' }} />);
    fireEvent.change(select(), { target: { value: 'meshtastic_public_tls' } });
    expect(changes.map(([f]) => f).sort()).toEqual(['address', 'password', 'tlsEnabled', 'username']);
    expect(Object.fromEntries(changes)).toEqual({
      address: 'mqtt.meshtastic.org',
      username: 'meshdev',
      password: 'large4cats',
      tlsEnabled: true,
    });
    expect(saveMqtt).not.toHaveBeenCalled();
    expect(select().value).toBe('meshtastic_public_tls');
  });

  it('keeps a loaded login and says so', () => {
    render(<Harness initial={{ address: '10.0.0.5', username: 'ops', password: 'pw' }} />);
    fireEvent.change(select(), { target: { value: 'meshtastic_public' } });
    expect(Object.fromEntries(changes)).toMatchObject({ username: 'ops', password: 'pw' });
    expect(screen.getByTestId('broker-preset-kept')).toBeInTheDocument();
  });

  it('Custom… changes nothing', () => {
    render(<Harness initial={{ address: '' }} />);
    fireEvent.change(select(), { target: { value: 'custom' } });
    expect(changes).toEqual([]);
    expect(select().value).toBe('custom');
  });

  it('has a TLS checkbox that edits tlsEnabled, and labels payload encryption correctly', () => {
    render(<Harness initial={{}} />);
    const tls = screen.getByText('TLS Enabled').closest('label')!.querySelector('input')!;
    fireEvent.click(tls);
    expect(changes).toEqual([['tlsEnabled', true]]);
    expect(screen.queryByText('Use TLS encryption for MQTT connection')).toBeNull();
    expect(screen.getByText('Send encrypted packets to MQTT')).toBeInTheDocument();
  });
});
