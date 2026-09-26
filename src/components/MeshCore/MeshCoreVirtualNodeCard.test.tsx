/**
 * @vitest-environment jsdom
 *
 * MeshCoreVirtualNodeCard (#5380): the read-only Virtual Node status card on
 * the MeshCore Node Info view, home of the MeshCore-only PKI export/import
 * flags that used to sit (unreachable) in the Meshtastic Info tab.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MeshCoreVirtualNodeCard } from './MeshCoreVirtualNodeCard';

const { mockGetVirtualNodeStatus } = vi.hoisted(() => ({ mockGetVirtualNodeStatus: vi.fn() }));

vi.mock('../../services/api', () => ({
  default: { getVirtualNodeStatus: () => mockGetVirtualNodeStatus() },
}));

function renderCard(sourceId: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const wrap = (ui: ReactNode) => <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
  return render(wrap(<MeshCoreVirtualNodeCard sourceId={sourceId} />));
}

const vnSource = (overrides: Record<string, unknown> = {}) => ({
  sourceId: 'mc-a',
  sourceName: 'MC A',
  enabled: true,
  isRunning: true,
  allowAdminCommands: false,
  allowPkiExport: true,
  allowPkiImport: false,
  clientCount: 2,
  clients: [],
  ...overrides,
});

beforeEach(() => {
  mockGetVirtualNodeStatus.mockReset();
});

describe('MeshCoreVirtualNodeCard', () => {
  it('shows PKI export and import as read-only allowed/blocked rows for this source', async () => {
    mockGetVirtualNodeStatus.mockResolvedValue({
      sources: [vnSource({ sourceId: 'other', allowPkiExport: false, allowPkiImport: true }), vnSource()],
    });

    renderCard('mc-a');

    expect(await screen.findByTestId('meshcore-info-virtual-node')).toBeInTheDocument();
    expect(screen.getByText('info.virtual_node_pki_export')).toBeInTheDocument();
    expect(screen.getByText('info.virtual_node_pki_import')).toBeInTheDocument();
    expect(screen.getByTestId('meshcore-vn-pki-export')).toHaveTextContent('info.virtual_node_admin_allowed');
    expect(screen.getByTestId('meshcore-vn-pki-import')).toHaveTextContent('info.virtual_node_admin_blocked');
    expect(screen.getByText('2')).toBeInTheDocument();
    // Read-only: no inputs to toggle the flags here.
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('omits the PKI rows when the server does not report the flags', async () => {
    mockGetVirtualNodeStatus.mockResolvedValue({
      sources: [vnSource({ allowPkiExport: undefined, allowPkiImport: undefined })],
    });

    renderCard('mc-a');

    expect(await screen.findByTestId('meshcore-info-virtual-node')).toBeInTheDocument();
    expect(screen.queryByTestId('meshcore-vn-pki-export')).toBeNull();
    expect(screen.queryByTestId('meshcore-vn-pki-import')).toBeNull();
  });

  it('shows only the disabled status when the virtual node is off', async () => {
    mockGetVirtualNodeStatus.mockResolvedValue({ sources: [vnSource({ enabled: false })] });

    renderCard('mc-a');

    expect(await screen.findByText('common.disabled')).toBeInTheDocument();
    expect(screen.queryByTestId('meshcore-vn-pki-export')).toBeNull();
  });

  it('renders nothing when the source is absent or the status call fails', async () => {
    mockGetVirtualNodeStatus.mockResolvedValue({ sources: [vnSource({ sourceId: 'other' })] });
    const { container, unmount } = renderCard('mc-a');
    await waitFor(() => expect(mockGetVirtualNodeStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    unmount();

    mockGetVirtualNodeStatus.mockRejectedValue(new Error('401'));
    const second = renderCard('mc-a');
    await waitFor(() => expect(mockGetVirtualNodeStatus).toHaveBeenCalledTimes(2));
    expect(second.container).toBeEmptyDOMElement();
  });
});
