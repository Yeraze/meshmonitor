/**
 * @vitest-environment jsdom
 *
 * UnifiedPacketMonitorPage — MeshCore filters and protocol-aware charts (#6262).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import UnifiedPacketMonitorPage from './UnifiedPacketMonitorPage';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

let sources: Array<{ id: string; name: string; type?: string }> = [];
const lastFilters: unknown[] = [];
vi.mock('../hooks/useUnifiedPackets', () => ({
  useUnifiedPackets: (o: { filters: unknown }) => {
    lastFilters.push(o.filters);
    return { packets: [], sources, loading: false, loadingMore: false, hasMore: false, rateLimitError: false, loadMore: vi.fn(), refresh: vi.fn() };
  },
}));

const chartProps: Array<{ chartId: string; data: Array<{ name: string; color: string }> }> = [];
vi.mock('../components/PacketStatsChart', () => ({
  DISTRIBUTION_COLORS: ['#c0', '#c1', '#c2'],
  default: (p: { chartId: string; data: Array<{ name: string; color: string }> }) => {
    chartProps.push(p);
    return <div data-testid={p.chartId} />;
  },
}));
vi.mock('../services/packetApi', () => ({
  getPacketStats: vi.fn().mockResolvedValue({ enabled: true }),
  getUnifiedPacketDistribution: vi.fn().mockResolvedValue({
    bySource: [],
    byDevice: [
      { from_node: 0, from_node_id: null, from_node_longName: 'Hilltop', publicKey: 'ab'.repeat(32), count: 3, protocol: 'meshcore' },
    ],
    byType: [
      { portnum: 1, portnum_name: 'TEXT_MESSAGE', count: 5, protocol: 'meshtastic' },
      { portnum: 4, portnum_name: 'MeshCore ADVERT', count: 2, protocol: 'meshcore' },
    ],
    total: 7,
    enabled: true,
  }),
}));
vi.mock('../services/api', () => ({ default: { post: vi.fn() } }));
vi.mock('../components/CrossSource/CrossSourcePacketTag', () => ({ default: () => null }));

function renderPage() {
  localStorage.setItem('unifiedPacketMonitor.showFilters', 'true');
  return render(<MemoryRouter><UnifiedPacketMonitorPage /></MemoryRouter>);
}

describe('UnifiedPacketMonitorPage MeshCore filters (#6262)', () => {
  beforeEach(() => {
    localStorage.clear();
    lastFilters.length = 0;
    chartProps.length = 0;
  });

  it('hides the MeshCore selects without a MeshCore source', () => {
    sources = [{ id: 'a', name: 'Mesh A', type: 'meshtastic_tcp' }];
    renderPage();
    expect(screen.queryByLabelText('MeshCore payload type')).toBeNull();
    expect(screen.queryByLabelText('MeshCore route type')).toBeNull();
  });

  it('shows them with a MeshCore source and passes the filters through', async () => {
    sources = [{ id: 'a', name: 'Mesh A', type: 'meshtastic_tcp' }, { id: 'b', name: 'MC', type: 'meshcore' }];
    renderPage();
    const payload = screen.getByLabelText('MeshCore payload type');
    await userEvent.selectOptions(payload, '4');
    await waitFor(() => expect(lastFilters[lastFilters.length - 1]).toEqual(expect.objectContaining({ payload_type: 4 })));
    await userEvent.selectOptions(screen.getByLabelText('MeshCore route type'), '1');
    await waitFor(() => expect(lastFilters[lastFilters.length - 1]).toEqual(expect.objectContaining({ payload_type: 4, route_type: 1 })));
  });

  it('shows the conflict hint when MeshCore and Meshtastic type filters are both set', async () => {
    sources = [{ id: 'b', name: 'MC', type: 'meshcore' }];
    renderPage();
    await userEvent.selectOptions(screen.getByLabelText('MeshCore payload type'), '4');
    expect(screen.queryByRole('status')).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Meshtastic type'), '1');
    expect(screen.getByRole('status').textContent).toMatch(/match nothing/);
  });

  it('colours MeshCore distribution entries from DISTRIBUTION_COLORS and names by key prefix fallback', async () => {
    sources = [{ id: 'b', name: 'MC', type: 'meshcore' }];
    renderPage();
    await waitFor(() => {
      const t = chartProps.filter((c) => c.chartId === 'unified-by-type').pop();
      expect(t?.data.length).toBe(2);
    });
    const byType = chartProps.filter((c) => c.chartId === 'unified-by-type').pop()!;
    expect(byType.data[1]).toEqual(expect.objectContaining({ name: 'MeshCore ADVERT', color: '#c1' }));
    expect(byType.data[0].color).not.toBe('#c0');
    const byDevice = chartProps.filter((c) => c.chartId === 'unified-by-device').pop()!;
    expect(byDevice.data[0].name).toBe('Hilltop');
  });
});
