/**
 * @vitest-environment jsdom
 *
 * Local Device Configuration > MQTT: a Save sends back what the node holds.
 *
 * Firmware replaces the whole MQTT struct with what Save sends. The local form
 * used to (1) never load or send map_report_settings.should_report_location, so
 * each save withdrew the node's location consent; (2) leave map_report_settings
 * out while map reporting was off, which zeroed the interval and precision; and
 * (3) load a stored precision of 0 as 14. The remote-admin form had the same
 * faults, fixed in #5707 (AdminCommandsTab.mqttRoundTrip.test.tsx).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  showToast: vi.fn(),
  getCurrentConfig: vi.fn(),
  setMQTTConfig: vi.fn(),
}));

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: h.showToast }) }));
vi.mock('../contexts/SourceContext', () => ({ useSource: () => ({ sourceId: 'source-1', sourceName: 'test-source' }) }));
vi.mock('../services/api', () => ({
  default: {
    getCurrentConfig: h.getCurrentConfig,
    getSecurityKeys: vi.fn().mockResolvedValue({}),
    setMQTTConfig: h.setMQTTConfig,
  },
}));

vi.mock('./configuration/NodeIdentitySection', () => ({ default: () => null }));
vi.mock('./configuration/DeviceConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/LoRaConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/PositionConfigSection', () => ({ default: () => null }));
// The section is stubbed to a probe that shows what it was handed and drives
// its setters; its own rendering is covered in MQTTConfigSection.test.tsx.
vi.mock('./configuration/MQTTConfigSection', () => ({
  default: (p: Record<string, unknown> & {
    mapPositionPrecision: number;
    mapShouldReportLocation: boolean;
    setMapShouldReportLocation: (v: boolean) => void;
    setMapReportingEnabled: (v: boolean) => void;
    onSave: () => Promise<void>;
  }) => (
    <div>
      <span data-testid="mqtt-precision">{String(p.mapPositionPrecision)}</span>
      <span data-testid="mqtt-consent">{String(p.mapShouldReportLocation)}</span>
      <button data-testid="mqtt-consent-off" onClick={() => p.setMapShouldReportLocation(false)}>off</button>
      <button data-testid="mqtt-consent-on" onClick={() => p.setMapShouldReportLocation(true)}>on</button>
      <button data-testid="mqtt-map-off" onClick={() => p.setMapReportingEnabled(false)}>map off</button>
      <button data-testid="mqtt-save" onClick={() => void p.onSave()}>Save</button>
    </div>
  ),
}));
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
vi.mock('./configuration/PaxcounterConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/StatusMessageConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/TrafficManagementConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/MeshBeaconConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/TAKConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/SerialConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/AmbientLightingConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/SecurityConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/PkiDmDecryptionSection', () => ({ default: () => null }));
// Firmware update lives on this page since the #5683 follow-up; it needs an
// admin and OTA enabled, which this suite does not grant.
// ConfigurationTab.movedSections.test.tsx covers its placement.
vi.mock('./configuration/FirmwareUpdateSection', () => ({ default: () => null }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ authStatus: { user: { isAdmin: false } }, hasPermission: () => true }),
}));
vi.mock('../hooks/useHealth', () => ({ useHealth: () => ({ data: undefined }) }));
vi.mock('./configuration/ChannelsConfigSection', () => ({ default: () => null }));
vi.mock('./configuration/GpioPinSummary', () => ({ default: () => null }));
vi.mock('./configuration/BackupManagementSection', () => ({ default: () => null }));
vi.mock('./configuration/ImportConfigModal', () => ({ ImportConfigModal: () => null }));
vi.mock('./configuration/ExportConfigModal', () => ({ ExportConfigModal: () => null }));
vi.mock('./SectionNav', () => ({ default: () => null }));

import ConfigurationTab from './ConfigurationTab';

/** Every MQTTConfig field (module_config.proto tags 1-11) set off its default. */
const FULL_MQTT = {
  enabled: true,
  address: 'mqtt.example.org:8883',
  username: 'meshdev',
  password: 'large4cats',
  encryptionEnabled: true,
  jsonEnabled: true,
  tlsEnabled: true,
  root: 'msh/US/FL',
  proxyToClientEnabled: true,
  mapReportingEnabled: true,
  mapReportSettings: { publishIntervalSecs: 7200, positionPrecision: 12, shouldReportLocation: true },
};

function nodeWith(mqtt: Record<string, unknown>) {
  return { deviceConfig: {}, moduleConfig: { mqtt } };
}

async function renderLoaded(mqtt: Record<string, unknown>) {
  h.getCurrentConfig.mockResolvedValue(nodeWith(mqtt));
  render(<ConfigurationTab nodes={[]} channels={[]} />);
  await waitFor(() => expect(h.getCurrentConfig).toHaveBeenCalled());
}

async function save(): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByTestId('mqtt-save'));
  await waitFor(() => expect(h.setMQTTConfig).toHaveBeenCalledTimes(1));
  const [sent, sourceId] = h.setMQTTConfig.mock.calls[0];
  expect(sourceId).toBe('source-1');
  return sent;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.setMQTTConfig.mockResolvedValue({ success: true });
});

describe('ConfigurationTab: local MQTT save round trip', () => {
  it('load then save sends every field back unchanged', async () => {
    await renderLoaded(FULL_MQTT);
    await waitFor(() => expect(screen.getByTestId('mqtt-consent').textContent).toBe('true'));

    expect(await save()).toEqual(FULL_MQTT);
  });

  it('a node with every bool off and every number 0 saves as exactly that', async () => {
    const allOff = {
      enabled: true,
      address: 'mqtt.example.org',
      username: '',
      password: '',
      encryptionEnabled: false,
      jsonEnabled: false,
      tlsEnabled: false,
      root: '',
      proxyToClientEnabled: false,
      mapReportingEnabled: false,
      mapReportSettings: { publishIntervalSecs: 0, positionPrecision: 0, shouldReportLocation: false },
    };
    await renderLoaded(allOff);
    await waitFor(() => expect(screen.getByTestId('mqtt-precision').textContent).toBe('0'));

    expect(await save()).toEqual(allOff);
  });

  it('the Report Location consent loads, and a change to it is sent', async () => {
    await renderLoaded(FULL_MQTT);
    await waitFor(() => expect(screen.getByTestId('mqtt-consent').textContent).toBe('true'));

    fireEvent.click(screen.getByTestId('mqtt-consent-off'));
    await waitFor(() => expect(screen.getByTestId('mqtt-consent').textContent).toBe('false'));

    const sent = await save();
    expect(sent.mapReportSettings).toEqual({ publishIntervalSecs: 7200, positionPrecision: 12, shouldReportLocation: false });
  });

  it('map report settings go out with map reporting off', async () => {
    await renderLoaded(FULL_MQTT);
    await waitFor(() => expect(screen.getByTestId('mqtt-consent').textContent).toBe('true'));

    fireEvent.click(screen.getByTestId('mqtt-map-off'));
    const sent = await save();
    expect(sent.mapReportingEnabled).toBe(false);
    expect(sent.mapReportSettings).toEqual({ publishIntervalSecs: 7200, positionPrecision: 12, shouldReportLocation: true });
  });

  it('a stored precision of 0 loads as 0 and is sent as 0', async () => {
    await renderLoaded({ ...FULL_MQTT, mapReportSettings: { publishIntervalSecs: 7200, positionPrecision: 0, shouldReportLocation: true } });
    await waitFor(() => expect(screen.getByTestId('mqtt-precision').textContent).toBe('0'));

    const sent = await save();
    expect((sent.mapReportSettings as { positionPrecision: number }).positionPrecision).toBe(0);
  });

  it('a node that sent no map report settings saves zeros and no consent', async () => {
    const { mapReportSettings: _omit, ...noSettings } = FULL_MQTT;
    await renderLoaded(noSettings);
    await waitFor(() => expect(screen.getByTestId('mqtt-precision').textContent).toBe('0'));

    const sent = await save();
    expect(sent.mapReportSettings).toEqual({ publishIntervalSecs: 0, positionPrecision: 0, shouldReportLocation: false });
  });
});
