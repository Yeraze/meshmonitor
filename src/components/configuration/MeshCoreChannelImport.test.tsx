// @vitest-environment jsdom
/**
 * "Import from MeshCore device" dialog (#5552).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const get = vi.fn();
const importMeshcoreChannels = vi.fn();
vi.mock('../../services/api', () => ({
  default: {
    get: (...a: unknown[]) => get(...a),
    importMeshcoreChannels: (...a: unknown[]) => importMeshcoreChannels(...a),
  },
}));
const showToast = vi.fn();
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, fallback?: string, opts?: Record<string, unknown>) =>
      (fallback ?? _k).replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts?.[name] ?? '')),
  }),
}));

import MeshCoreChannelImport from './MeshCoreChannelImport';

beforeEach(() => {
  get.mockReset();
  importMeshcoreChannels.mockReset();
  showToast.mockReset();
});

describe('MeshCoreChannelImport', () => {
  it('lists only MeshCore device sources and imports from the chosen one', async () => {
    get.mockResolvedValue([
      { id: 'tcp', name: 'Meshtastic', type: 'meshtastic_tcp' },
      { id: 'mc1', name: 'Companion', type: 'meshcore' },
      { id: 'mq', name: 'Feed', type: 'meshcore_mqtt' },
    ]);
    importMeshcoreChannels.mockResolvedValue({
      success: true,
      data: { imported: [{ id: 1, name: 'Public' }], skipped: [{ name: 'dup', reason: 'duplicate' }] },
    });
    const onImported = vi.fn();
    render(<MeshCoreChannelImport onImported={onImported} />);

    // Nothing is fetched or imported until the admin opens the dialog.
    expect(get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Import from MeshCore device' }));

    await screen.findByRole('option', { name: 'Companion' });
    expect(screen.queryByRole('option', { name: 'Meshtastic' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Feed' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(importMeshcoreChannels).toHaveBeenCalledWith('mc1'));
    const result = await screen.findByTestId('meshcore-import-result');
    expect(result).toHaveTextContent('1 added');
    expect(result).toHaveTextContent('1 already stored (same key)');
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it('does not refresh the list when nothing was added, and reports a failure', async () => {
    get.mockResolvedValue([{ id: 'mc1', name: 'Companion', type: 'meshcore' }]);
    importMeshcoreChannels.mockResolvedValueOnce({ success: true, data: { imported: [], skipped: [] } });
    const onImported = vi.fn();
    render(<MeshCoreChannelImport onImported={onImported} />);
    fireEvent.click(screen.getByRole('button', { name: 'Import from MeshCore device' }));
    await screen.findByRole('option', { name: 'Companion' });

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByTestId('meshcore-import-result');
    expect(onImported).not.toHaveBeenCalled();

    importMeshcoreChannels.mockRejectedValueOnce(new Error('Forbidden'));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Forbidden', 'error'));
  });

  it('says so when no MeshCore device source exists', async () => {
    get.mockResolvedValue([{ id: 'tcp', name: 'Meshtastic', type: 'meshtastic_tcp' }]);
    render(<MeshCoreChannelImport onImported={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Import from MeshCore device' }));
    expect(await screen.findByText('No MeshCore device source is configured.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
  });
});
