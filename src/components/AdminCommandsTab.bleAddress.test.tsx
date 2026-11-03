/**
 * @vitest-environment jsdom
 *
 * #6157: the Device Metadata panel shows DeviceMetadata.ble_address — the BLE
 * MAC the node advertises — as its own row, but only when the node reports a
 * non-empty value. Firmware that predates the field (or advertises no address)
 * sends an empty string, which must leave the row off entirely. This path also
 * covers remote nodes, whose metadata flows through the same display block.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  showToast: vi.fn(),
  apiPost: vi.fn(),
  apiSendAdminCommand: vi.fn(),
}));

// `t` MUST be a stable reference across renders (see AdminCommandsTab.txDisabled.test.tsx).
vi.mock('react-i18next', () => {
  const t = (_key: string, fallback?: string | Record<string, unknown>) => (typeof fallback === 'string' ? fallback : _key);
  return { useTranslation: () => ({ t }) };
});

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: h.invalidateQueries }),
}));

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
  },
}));

vi.mock('./SectionNav', () => ({ default: () => null }));
vi.mock('./configuration/ImportConfigModal', () => ({ ImportConfigModal: () => null }));
vi.mock('./configuration/ExportConfigModal', () => ({ ExportConfigModal: () => null }));
vi.mock('./admin-commands/ModuleConfigurationSection', () => ({ ModuleConfigurationSection: () => null }));
vi.mock('./admin-commands/AutoFavoriteManagementSection', () => ({ default: () => null }));
vi.mock('./admin-commands/DeviceConfigurationSection', () => ({ DeviceConfigurationSection: () => null }));

import AdminCommandsTab from './AdminCommandsTab';

const LOCAL_NODE_ID = '!00000064';
const localNode = {
  nodeNum: 100,
  user: { id: LOCAL_NODE_ID, longName: 'Local Node', shortName: 'LOC1' },
};

const baseMetadata = {
  firmwareVersion: '2.8.0',
  deviceStateVersion: 0,
  canShutdown: null,
  hasWifi: false,
  hasBluetooth: false,
  hasEthernet: false,
  role: 0,
  positionFlags: 0,
  hwModel: 0,
  hasRemoteHardware: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  h.apiSendAdminCommand.mockResolvedValue({});
});

async function loadMetadata(deviceMetadata: Record<string, unknown>) {
  h.apiPost.mockResolvedValue({ deviceMetadata });
  render(<AdminCommandsTab nodes={[localNode]} currentNodeId={LOCAL_NODE_ID} channels={[]} />);
  fireEvent.click(screen.getByText('Retrieve Device Metadata'));
  await waitFor(() => {
    expect(screen.getByText('Device Metadata')).toBeInTheDocument();
  });
}

describe('AdminCommandsTab — DeviceMetadata.ble_address (#6157)', () => {
  it('renders the BLE address row when the node reports one', async () => {
    await loadMetadata({ ...baseMetadata, bleAddress: 'AA:BB:CC:DD:EE:FF' });
    expect(screen.getByText('BLE Address:')).toBeInTheDocument();
    expect(screen.getByText('AA:BB:CC:DD:EE:FF')).toBeInTheDocument();
  });

  it('hides the BLE address row when the field is an empty string', async () => {
    await loadMetadata({ ...baseMetadata, bleAddress: '' });
    expect(screen.queryByText('BLE Address:')).not.toBeInTheDocument();
  });

  it('hides the BLE address row when the field is absent', async () => {
    await loadMetadata({ ...baseMetadata });
    expect(screen.queryByText('BLE Address:')).not.toBeInTheDocument();
  });
});
