/**
 * @vitest-environment jsdom
 *
 * #6262: `?sourceId=` naming a MeshCore source opens the MeshCore monitor;
 * otherwise the Meshtastic panel.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../components/PacketMonitorPanel', () => ({ default: () => <div data-testid="mt-panel" /> }));
vi.mock('../components/MeshCore/MeshCorePacketMonitorView', () => ({
  MeshCorePacketMonitorView: (p: { sourceId: string; standalone?: boolean }) => (
    <div data-testid="mc-view" data-source={p.sourceId} data-standalone={String(!!p.standalone)} />
  ),
}));
vi.mock('../contexts/AuthContext', () => ({ AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../contexts/SettingsContext', () => ({ SettingsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../contexts/CsrfContext', () => ({ CsrfProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../contexts/WebSocketContext', () => ({ WebSocketProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../contexts/DataContext', () => ({
  DataProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useData: () => ({ setDeviceInfo: vi.fn() }),
}));
vi.mock('../services/api', () => ({
  default: { getCurrentConfig: vi.fn().mockResolvedValue({}), get: vi.fn().mockResolvedValue({ data: [] }) },
}));
vi.mock('../init', () => ({ appBasename: '' }));
vi.mock('../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({
    isLoading: false,
    data: [
      { id: 'mc-1', name: 'MC', type: 'meshcore', enabled: true },
      { id: 'mt-1', name: 'MT', type: 'meshtastic_tcp', enabled: true },
    ],
  }),
}));

import PacketMonitorPage from './PacketMonitorPage';

const renderAt = (url: string) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[url]}><PacketMonitorPage /></MemoryRouter>
    </QueryClientProvider>,
  );

describe('PacketMonitorPage dispatch', () => {
  it('renders the MeshCore monitor for a MeshCore sourceId', async () => {
    renderAt('/packet-monitor?sourceId=mc-1');
    const el = await screen.findByTestId('mc-view');
    expect(el.dataset.source).toBe('mc-1');
    expect(el.dataset.standalone).toBe('true');
  });
  it('renders the Meshtastic panel with no sourceId', async () => {
    renderAt('/packet-monitor');
    expect(await screen.findByTestId('mt-panel')).toBeInTheDocument();
  });
  it('falls back to the Meshtastic panel for a non-MeshCore source', async () => {
    renderAt('/packet-monitor?sourceId=mt-1');
    expect(await screen.findByTestId('mt-panel')).toBeInTheDocument();
  });
});
