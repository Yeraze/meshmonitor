/**
 * @vitest-environment jsdom
 *
 * Remote-admin MQTT Save sends the whole MQTTConfig, and firmware replaces the
 * node's struct with it. The form used to load and send only the broker fields,
 * so every save turned client proxy, map reporting and the map report settings
 * off on the node, and a Save before any Load wrote defaults over all of it.
 *
 * Pinned here: Load → Save sends back every field the node reported; the new
 * toggles and map report inputs edit what is sent; Save is blocked until this
 * node's MQTT config is loaded.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const h = vi.hoisted(() => ({
  showToast: vi.fn(),
  apiPost: vi.fn(),
  apiSendAdminCommand: vi.fn(),
}));

// `t` must keep one identity across renders (see AdminCommandsTab.txDisabled.test.tsx).
vi.mock('react-i18next', () => {
  const t = (key: string, fallback?: string | Record<string, unknown>) => (typeof fallback === 'string' ? fallback : key);
  return { useTranslation: () => ({ t }) };
});
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: h.showToast }) }));
vi.mock('../hooks/useResolvedSourceId', () => ({ useResolvedSourceId: () => 'source-1' }));
vi.mock('../hooks/useTxStatus', () => ({ useTxStatus: () => ({ isTxDisabled: false }) }));
vi.mock('../services/api', () => ({
  default: {
    setBaseUrl: vi.fn(),
    post: h.apiPost,
    sendAdminCommand: h.apiSendAdminCommand,
    exportChannel: vi.fn(),
    importChannel: vi.fn(),
    getAllChannels: vi.fn().mockResolvedValue([]),
    ensureSessionPasskey: vi.fn().mockResolvedValue({ success: true, hasPasskey: true, remainingSeconds: 300 }),
  },
}));
vi.mock('./SectionNav', () => ({ default: () => null }));
vi.mock('./configuration/ImportConfigModal', () => ({ ImportConfigModal: () => null }));
vi.mock('./configuration/ExportConfigModal', () => ({ ExportConfigModal: () => null }));
vi.mock('./admin-commands/AutoFavoriteManagementSection', () => ({ default: () => null }));

import AdminCommandsTab from './AdminCommandsTab';

const LOCAL_NODE_ID = '!00000064';
const localNode = { nodeNum: 100, user: { id: LOCAL_NODE_ID, longName: 'Local Node', shortName: 'LOC1' } };
const remoteNode = { nodeNum: 200, user: { id: '!000000c8', longName: 'Remote Node', shortName: 'REM1' } };
const otherNode = { nodeNum: 300, user: { id: '!0000012c', longName: 'Other Node', shortName: 'OTH1' } };

/** Every MQTTConfig field (module_config.proto tags 1-11), none at its default. */
const NODE_MQTT = {
  enabled: true,
  address: 'broker.example.org',
  username: 'ops',
  password: 'pw',
  encryptionEnabled: false,
  jsonEnabled: true,
  tlsEnabled: true,
  root: 'msh/EU',
  proxyToClientEnabled: true,
  mapReportingEnabled: true,
  mapReportSettings: { publishIntervalSecs: 7200, positionPrecision: 13, shouldReportLocation: true },
};

let mqttAnswer: Record<string, unknown>;

function renderOnRemoteNode() {
  const expanded = { 'module-config': true, 'admin-mqtt-config': true };
  localStorage.setItem('adminCommandsExpandedSections', JSON.stringify(expanded));
  render(<AdminCommandsTab nodes={[localNode, remoteNode, otherNode]} currentNodeId={LOCAL_NODE_ID} channels={[]} />);
  pickNode('Remote Node');
}

/** The node search box's placeholder is the selected node's name. */
function pickNode(longName: string, current = 'Local Node') {
  const search = screen.getByPlaceholderText(current);
  fireEvent.focus(search);
  // After a pick the box holds that node's name, which filters the list.
  fireEvent.change(search, { target: { value: longName } });
  fireEvent.click(screen.getByText(longName));
}

const mqttSection = () => document.getElementById('admin-mqtt-config') as HTMLElement;
const saveButton = () => within(mqttSection()).getByRole('button', { name: 'admin_commands.save_mqtt_config' });

async function loadMqtt() {
  fireEvent.click(within(mqttSection()).getByRole('button', { name: 'Load' }));
  await waitFor(() => expect(within(mqttSection()).queryByTitle('admin_commands.section_loaded')).not.toBeNull());
}

const mqttSaves = () =>
  h.apiSendAdminCommand.mock.calls
    .map(([body]) => body as { command: string; nodeNum: number; config: Record<string, unknown> })
    .filter(body => body.command === 'setMQTTConfig');

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mqttAnswer = NODE_MQTT;
  h.apiPost.mockImplementation(async (endpoint: string, body: { configType?: string }) => {
    if (endpoint === '/api/admin/load-config' && body?.configType === 'mqtt') return { config: mqttAnswer };
    return {};
  });
  h.apiSendAdminCommand.mockResolvedValue({ success: true, message: 'ok' });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('AdminCommandsTab remote MQTT save', () => {
  it('Load → Save sends back every field the node reported', async () => {
    renderOnRemoteNode();
    await loadMqtt();

    fireEvent.click(saveButton());

    await waitFor(() => expect(mqttSaves()).toHaveLength(1));
    expect(mqttSaves()[0].nodeNum).toBe(200);
    expect(mqttSaves()[0].config).toEqual(NODE_MQTT);
  });

  it('keeps map report settings while map reporting is off', async () => {
    mqttAnswer = { ...NODE_MQTT, mapReportingEnabled: false };
    renderOnRemoteNode();
    await loadMqtt();

    fireEvent.click(saveButton());

    await waitFor(() => expect(mqttSaves()).toHaveLength(1));
    expect(mqttSaves()[0].config).toEqual(mqttAnswer);
  });

  it('shows client proxy, map reporting and map report settings with the loaded values, and saves edits', async () => {
    renderOnRemoteNode();
    await loadMqtt();
    const section = within(mqttSection());
    const proxy = section.getByTestId('admin-mqtt-proxy-to-client') as HTMLInputElement;
    const mapReporting = section.getByTestId('admin-mqtt-map-reporting') as HTMLInputElement;
    const reportLocation = section.getByTestId('admin-mqtt-map-report-location') as HTMLInputElement;
    expect(proxy.checked).toBe(true);
    expect(mapReporting.checked).toBe(true);
    expect(reportLocation.checked).toBe(true);
    expect((document.getElementById('adminMqttMapPublishIntervalSecs') as HTMLInputElement).value).toBe('7200');
    expect((document.getElementById('adminMqttMapPositionPrecision') as HTMLInputElement).value).toBe('13');

    fireEvent.click(proxy);
    fireEvent.click(reportLocation);
    fireEvent.change(document.getElementById('adminMqttMapPositionPrecision') as HTMLInputElement, { target: { value: '16' } });
    fireEvent.click(mapReporting);
    // Map report settings hide with map reporting off, but are still sent.
    expect(document.getElementById('adminMqttMapPositionPrecision')).toBeNull();
    fireEvent.click(saveButton());

    await waitFor(() => expect(mqttSaves()).toHaveLength(1));
    expect(mqttSaves()[0].config).toEqual({
      ...NODE_MQTT,
      proxyToClientEnabled: false,
      mapReportingEnabled: false,
      mapReportSettings: { publishIntervalSecs: 7200, positionPrecision: 16, shouldReportLocation: false },
    });
  });

  it('blocks Save until this node\'s MQTT config is loaded', async () => {
    renderOnRemoteNode();

    expect(saveButton()).toBeDisabled();
    expect(within(mqttSection()).getByText(/Load this node’s MQTT configuration first/)).toBeInTheDocument();
    fireEvent.click(saveButton());
    expect(mqttSaves()).toHaveLength(0);

    await loadMqtt();
    expect(saveButton()).not.toBeDisabled();
    expect(within(mqttSection()).queryByText(/Load this node’s MQTT configuration first/)).toBeNull();
  });

  it('blocks Save again after switching to another node, so one node\'s MQTT config never lands on another', async () => {
    renderOnRemoteNode();
    await loadMqtt();
    expect(saveButton()).not.toBeDisabled();

    pickNode('Other Node', 'Remote Node');

    await waitFor(() => expect(saveButton()).toBeDisabled());
    fireEvent.click(saveButton());
    expect(mqttSaves()).toHaveLength(0);
  });
});
