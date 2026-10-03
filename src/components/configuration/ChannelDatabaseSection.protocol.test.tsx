// @vitest-environment jsdom
/**
 * Channel Database page: MeshCore entries beside Meshtastic ones (#5552).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { ChannelDatabaseEntry } from '../../services/api';

const showToastMock = vi.fn();
vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: showToastMock, toasts: [] }),
}));

const getChannelDatabaseEntriesMock = vi.fn();
const createChannelDatabaseEntryMock = vi.fn();
vi.mock('../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../services/api')>('../../services/api');
  return {
    ...actual,
    default: {
      getChannelDatabaseEntries: getChannelDatabaseEntriesMock,
      getRetroactiveDecryptionProgress: vi.fn().mockResolvedValue({ isRunning: false, progress: null }),
      reorderChannelDatabaseEntries: vi.fn(),
      createChannelDatabaseEntry: createChannelDatabaseEntryMock,
      updateChannelDatabaseEntry: vi.fn(),
      deleteChannelDatabaseEntry: vi.fn(),
      triggerRetroactiveDecryption: vi.fn(),
      get: vi.fn().mockResolvedValue([]),
      importMeshcoreChannels: vi.fn(),
    },
  };
});

vi.mock('../../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const base: ChannelDatabaseEntry = {
  id: 1,
  name: 'LongFast',
  pskLength: 16,
  pskPreview: 'AAAAAAAA...',
  description: null,
  isEnabled: true,
  enforceNameValidation: false,
  sortOrder: 0,
  decryptedPacketCount: 0,
  lastDecryptedAt: null,
  createdBy: null,
  createdAt: 0,
  updatedAt: 0,
};

const renderSection = async () => {
  const { default: ChannelDatabaseSection } = await import('./ChannelDatabaseSection');
  return render(<ChannelDatabaseSection isAdmin={true} />);
};

describe('ChannelDatabaseSection protocols (#5552)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getChannelDatabaseEntriesMock.mockResolvedValue({
      data: [
        { ...base, protocol: 'meshtastic' },
        { ...base, id: 2, name: '#general', protocol: 'meshcore', sortOrder: 1 },
      ],
    });
    createChannelDatabaseEntryMock.mockResolvedValue({ success: true, data: null, message: '' });
  });

  it('loads both protocols and labels each entry', async () => {
    await renderSection();
    await waitFor(() => expect(screen.getByText('#general')).toBeTruthy());
    expect(getChannelDatabaseEntriesMock).toHaveBeenCalledWith('all');
    expect(screen.getAllByText('channel_database.protocol_meshtastic')).toHaveLength(1);
    expect(screen.getAllByText('channel_database.protocol_meshcore')).toHaveLength(1);
  });

  it('offers retroactive decrypt on the Meshtastic entry only', async () => {
    await renderSection();
    await waitFor(() => expect(screen.getByText('#general')).toBeTruthy());
    expect(screen.getAllByTitle('channel_database.run_retroactive')).toHaveLength(1);
  });

  it('creates a MeshCore #hashtag channel with no secret, skipping the Meshtastic PSK checks', async () => {
    await renderSection();
    await waitFor(() => expect(screen.getByText('#general')).toBeTruthy());
    fireEvent.click(screen.getByText(/channel_database\.add_channel/));

    fireEvent.change(screen.getByLabelText(/channel_database\.protocol/), { target: { value: 'meshcore' } });
    fireEvent.change(screen.getByLabelText(/channel_database\.channel_name/), { target: { value: '#test' } });
    fireEvent.click(screen.getByText('common.save'));

    await waitFor(() => expect(createChannelDatabaseEntryMock).toHaveBeenCalledTimes(1));
    expect(createChannelDatabaseEntryMock.mock.calls[0][0]).toMatchObject({ name: '#test', psk: '', protocol: 'meshcore' });
  });

  it('refuses a MeshCore secret of the wrong size before calling the server', async () => {
    await renderSection();
    await waitFor(() => expect(screen.getByText('#general')).toBeTruthy());
    fireEvent.click(screen.getByText(/channel_database\.add_channel/));
    fireEvent.change(screen.getByLabelText(/channel_database\.protocol/), { target: { value: 'meshcore' } });
    fireEvent.change(screen.getByLabelText(/channel_database\.channel_name/), { target: { value: 'ops' } });
    fireEvent.change(screen.getByLabelText(/channel_database\.meshcore_secret/), { target: { value: 'AQ==' } });
    fireEvent.click(screen.getByText('common.save'));

    await waitFor(() => expect(showToastMock).toHaveBeenCalled());
    expect(createChannelDatabaseEntryMock).not.toHaveBeenCalled();
  });
});
