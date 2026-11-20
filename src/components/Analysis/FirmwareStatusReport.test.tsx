/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../services/api', () => ({ default: api }));

import FirmwareStatusReport from './FirmwareStatusReport';

const row = (over: Record<string, unknown>) => ({
  sourceId: 'a', sourceName: 'Source A', protocol: 'meshtastic', enabled: true, connected: true,
  device: 'Base', hardware: 'HELTEC_V3', role: null, installed: '2.7.15', latest: '2.7.18',
  latestUrl: 'https://x', channel: 'stable', status: 'update_available', reason: null, method: 'ota', ...over,
});

const fleet = (rows: unknown[]) => ({ success: true, data: { rows, checkedAt: { meshtastic: 1, meshcore: 1 } } });

describe('FirmwareStatusReport (#4943)', () => {
  beforeEach(() => {
    api.get.mockReset();
    api.post.mockReset();
  });

  const renderReport = () => render(<MemoryRouter><FirmwareStatusReport /></MemoryRouter>);

  it('lists each radio with its status and links Meshtastic rows to the OTA panel', async () => {
    api.get.mockResolvedValue(fleet([
      row({}),
      row({ sourceId: 'mc', sourceName: 'MC', protocol: 'meshcore', role: 'companion', installed: null, latest: '1.18.0', status: 'unknown', reason: 'disconnected', method: 'manual' }),
    ]));
    renderReport();
    expect(await screen.findByText('Update available')).toBeInTheDocument();
    expect(screen.getByText('Unknown: not connected')).toBeInTheDocument();
    expect(screen.getByText('OTA update').closest('a')?.getAttribute('href')).toBe('/source/a/configuration#config-firmware');
    expect(screen.getByText('Manual (USB / app)')).toBeInTheDocument();
  });

  it('sets a MeshCore source\'s own channel from its row', async () => {
    api.get.mockResolvedValue(fleet([row({ sourceId: 'mc', sourceName: 'MC', protocol: 'meshcore', role: 'repeater', method: 'manual' })]));
    api.post.mockResolvedValue({ success: true });
    renderReport();
    const select = await screen.findByLabelText('Release channel for MC');
    fireEvent.change(select, { target: { value: 'alpha' } });
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/firmware/channel', { channel: 'alpha', sourceId: 'mc' }));
  });

  it('Check for updates refreshes both release lists through the fleet check', async () => {
    api.get.mockResolvedValue(fleet([]));
    api.post.mockResolvedValue(fleet([row({ status: 'up_to_date', installed: '2.7.18' })]));
    renderReport();
    expect(await screen.findByText('No Meshtastic or MeshCore radio sources are set up.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Check for updates'));
    expect(await screen.findByText('Up to date')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/api/firmware/fleet/check');
  });
});
