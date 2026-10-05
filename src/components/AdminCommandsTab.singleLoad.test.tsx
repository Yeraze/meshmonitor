/**
 * @vitest-environment jsdom
 *
 * The per-section Load button in the Admin Commands tab.
 *
 * `statusmessage`, `trafficmanagement` and `meshbeacon` had a case in "Load all
 * configs" and none in the per-section path: the reply was fetched, dropped,
 * and the section still showed the "loaded" tick over default values. A Save
 * from there wrote the defaults over the node's real config.
 *
 * Pinned here: a single Load fills the form with what the node answered, a
 * failed or empty load leaves the section not-loaded, and every Load button the
 * tab draws has an applier behind it.
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
import { ADMIN_LOAD_SECTIONS, CONFIG_APPLIERS, LOAD_CONFIG_TYPES } from './admin-commands/applyLoadedConfig';
import { MESH_BEACON_FLAGS } from './admin-commands/useAdminCommandsState';

const LOCAL_NODE_ID = '!00000064';
const localNode = { nodeNum: 100, user: { id: LOCAL_NODE_ID, longName: 'Local Node', shortName: 'LOC1' } };

/** The DOM id of the collapsible that carries each section's Load button. */
const SECTION_DOM_ID: Record<(typeof ADMIN_LOAD_SECTIONS)[number], string> = {
  device: 'admin-device-config',
  lora: 'admin-lora-config',
  position: 'admin-position-config',
  mqtt: 'admin-mqtt-config',
  security: 'admin-security-config',
  bluetooth: 'admin-bluetooth-config',
  network: 'admin-network-config',
  neighborinfo: 'admin-neighborinfo-config',
  telemetry: 'admin-telemetry-config',
  statusmessage: 'admin-statusmessage-config',
  trafficmanagement: 'admin-trafficmanagement-config',
  meshbeacon: 'admin-meshbeacon-config',
  tak: 'admin-tak-config',
  owner: 'admin-set-owner',
  channels: 'admin-channel-config',
};

/** What `/api/admin/load-config` answers, per configType. A function throws. */
let answers: Record<string, unknown>;

function renderTab() {
  const expanded: Record<string, boolean> = { 'radio-config': true, 'device-config': true, 'module-config': true };
  for (const id of Object.values(SECTION_DOM_ID)) expanded[id] = true;
  localStorage.setItem('adminCommandsExpandedSections', JSON.stringify(expanded));
  render(<AdminCommandsTab nodes={[localNode]} currentNodeId={LOCAL_NODE_ID} channels={[]} />);
}

function section(configType: keyof typeof SECTION_DOM_ID): HTMLElement {
  const el = document.getElementById(SECTION_DOM_ID[configType]);
  expect(el, `${configType} section is rendered`).not.toBeNull();
  return el as HTMLElement;
}

const loadButton = (configType: keyof typeof SECTION_DOM_ID) =>
  within(section(configType)).getByRole('button', { name: 'Load' });

const isMarkedLoaded = (configType: keyof typeof SECTION_DOM_ID) =>
  within(section(configType)).queryByTitle('admin_commands.section_loaded') !== null;
const isMarkedFailed = (configType: keyof typeof SECTION_DOM_ID) =>
  within(section(configType)).queryByTitle('admin_commands.section_load_failed') !== null;

async function load(configType: keyof typeof SECTION_DOM_ID) {
  fireEvent.click(loadButton(configType));
  await waitFor(() => expect(isMarkedLoaded(configType) || isMarkedFailed(configType)).toBe(true));
}

const loadConfigRequests = () =>
  h.apiPost.mock.calls
    .filter(([endpoint]) => endpoint === '/api/admin/load-config')
    .map(([, body]) => (body as { configType: string }).configType);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  answers = {};
  h.apiPost.mockImplementation(async (endpoint: string, body: { configType?: string }) => {
    if (endpoint !== '/api/admin/load-config' || !body?.configType) return {};
    const answer = answers[body.configType];
    if (typeof answer === 'function') return answer();
    return answer === undefined ? {} : { config: answer };
  });
  h.apiSendAdminCommand.mockResolvedValue({ success: true, message: 'ok' });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('AdminCommandsTab per-section Load', () => {
  it('fills the Status Message form with the node\'s value', async () => {
    answers.statusmessage = { nodeStatus: 'On the hill until 6' };
    renderTab();

    await load('statusmessage');

    expect(within(section('statusmessage')).getByDisplayValue('On the hill until 6')).toBeInTheDocument();
    expect(isMarkedLoaded('statusmessage')).toBe(true);
  });

  it('fills the Traffic Management form with the node\'s values', async () => {
    answers.trafficmanagement = {
      positionMinIntervalSecs: 611,
      nodeinfoDirectResponseMaxHops: 3,
      rateLimitWindowSecs: 122,
      rateLimitMaxPackets: 47,
      unknownPacketThreshold: 9,
    };
    renderTab();
    const numbers = () =>
      (within(section('trafficmanagement')).getAllByRole('spinbutton') as HTMLInputElement[]).map(input => input.value);
    expect(numbers()).toEqual(['0', '0', '0', '0', '0']);

    await load('trafficmanagement');

    expect(numbers()).toEqual(['611', '3', '122', '47', '9']);
    expect(isMarkedLoaded('trafficmanagement')).toBe(true);
  });

  it('fills the MeshBeacon form with the node\'s values', async () => {
    answers.meshbeacon = {
      flags: MESH_BEACON_FLAGS.LISTEN_ENABLED | MESH_BEACON_FLAGS.BROADCAST_ENABLED,
      broadcastMessage: 'Welcome to the valley mesh',
      broadcastOfferChannel: { name: 'Valley' },
      broadcastIntervalSecs: 7200,
    };
    renderTab();
    const beacon = () => within(section('meshbeacon'));
    // Broadcast is off by default, so its fields are not drawn yet.
    expect(beacon().queryByDisplayValue('Welcome to the valley mesh')).toBeNull();

    await load('meshbeacon');

    expect(beacon().getByDisplayValue('Welcome to the valley mesh')).toBeInTheDocument();
    expect(beacon().getByDisplayValue('Valley')).toBeInTheDocument();
    expect(beacon().getByDisplayValue('7200')).toBeInTheDocument();
    const checked = (beacon().getAllByRole('checkbox') as HTMLInputElement[]).map(box => box.checked);
    expect(checked.slice(0, 2)).toEqual([true, true]);
    expect(isMarkedLoaded('meshbeacon')).toBe(true);
  });

  it.each(['statusmessage', 'trafficmanagement', 'meshbeacon'] as const)(
    'leaves %s not-loaded when the request fails',
    async (configType) => {
      answers[configType] = () => {
        throw new Error('Admin request refused');
      };
      renderTab();

      await load(configType);

      expect(isMarkedLoaded(configType)).toBe(false);
      expect(isMarkedFailed(configType)).toBe(true);
      expect(h.showToast).toHaveBeenCalledWith('Admin request refused', 'error');
      expect(h.showToast).not.toHaveBeenCalledWith(expect.anything(), 'success');
    },
  );

  it.each(['statusmessage', 'trafficmanagement', 'meshbeacon'] as const)(
    'leaves %s not-loaded when the reply holds no config',
    async (configType) => {
      // `answers` has no entry: the route answers `{}`.
      renderTab();

      await load(configType);

      expect(isMarkedLoaded(configType)).toBe(false);
      expect(isMarkedFailed(configType)).toBe(true);
      expect(h.showToast).not.toHaveBeenCalledWith(expect.anything(), 'success');
    },
  );

  it('keeps the form defaults when a load fails', async () => {
    answers.trafficmanagement = () => {
      throw new Error('Admin request refused');
    };
    renderTab();

    await load('trafficmanagement');

    const numbers = (within(section('trafficmanagement')).getAllByRole('spinbutton') as HTMLInputElement[]).map(input => input.value);
    expect(numbers).toEqual(['0', '0', '0', '0', '0']);
  });

  it('draws one Load button per registered section, each with an applier behind it', async () => {
    for (const configType of LOAD_CONFIG_TYPES) answers[configType] = {};
    renderTab();

    // Every section in the registry has a button...
    for (const configType of ADMIN_LOAD_SECTIONS) expect(loadButton(configType)).toBeInTheDocument();
    // ...and the tab draws no Load button outside the registry.
    const drawn = Array.from(document.querySelectorAll('button')).filter(button => button.textContent === 'Load');
    expect(drawn).toHaveLength(ADMIN_LOAD_SECTIONS.length);

    for (const configType of LOAD_CONFIG_TYPES) {
      await load(configType);
      expect(isMarkedLoaded(configType), `${configType} applied and marked loaded`).toBe(true);
    }
    expect(loadConfigRequests()).toEqual([...LOAD_CONFIG_TYPES]);
    expect(Object.keys(CONFIG_APPLIERS).sort()).toEqual([...LOAD_CONFIG_TYPES].sort());
  });

  // "Load All Config" goes through the same applier. It waits 200 ms between
  // requests, so this one test runs for about three seconds of real time.
  it('fills the same forms from "Load All Config", and counts an empty reply as a failure', async () => {
    for (const configType of LOAD_CONFIG_TYPES) answers[configType] = {};
    answers.statusmessage = { nodeStatus: 'Loaded with the rest' };
    answers.trafficmanagement = { rateLimitWindowSecs: 90 };
    delete answers.meshbeacon; // the route answers `{}`
    renderTab();

    fireEvent.click(screen.getByRole('button', { name: 'Load All Config' }));
    await waitFor(
      () => expect(h.showToast).toHaveBeenCalledWith('admin_commands.configs_partially_loaded', 'warning'),
      { timeout: 20000 },
    );

    expect(loadConfigRequests()).toEqual([...LOAD_CONFIG_TYPES]);
    expect(within(section('statusmessage')).getByDisplayValue('Loaded with the rest')).toBeInTheDocument();
    expect(within(section('trafficmanagement')).getByDisplayValue('90')).toBeInTheDocument();
    expect(isMarkedLoaded('statusmessage')).toBe(true);
    expect(isMarkedLoaded('meshbeacon')).toBe(false);
    expect(isMarkedFailed('meshbeacon')).toBe(true);
  }, 30000);
});
