/**
 * @vitest-environment jsdom
 *
 * Live Mesh Activity widget (#5557): empty state when the packet log is off,
 * the "data covers since" line, the all-transports toggle, row click, the
 * window selector and column sorting.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  }),
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => null } },
}));

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  const t = (key: string, opts?: Record<string, unknown>) =>
    opts ? `${key}:${JSON.stringify(opts)}` : key;
  return createReactI18nextMock(t);
});

vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({ timeFormat: '24', iconStyle: 'lucide' }),
}));

const sourceState: { sourceId: string | null } = { sourceId: 'src-a' };
vi.mock('../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: sourceState.sourceId, sourceName: 'A' }),
}));

const getNodeActivity = vi.fn();
vi.mock('../services/packetApi', () => ({
  getNodeActivity: (...args: unknown[]) => getNodeActivity(...args),
}));

import LiveMeshActivityWidget from './LiveMeshActivityWidget';

const NOW = Date.now();
const node = (over: Record<string, unknown>) => ({
  nodeNum: 1,
  nodeId: '!00000001',
  shortName: 'ONE',
  longName: 'Node One',
  packets: 1,
  extraReceptions: 0,
  lastSnr: 5,
  avgSnr: 5,
  lastHops: 1,
  minHops: 1,
  lastHeard: NOW - 5000,
  ...over,
});

function renderWidget(props: Partial<React.ComponentProps<typeof LiveMeshActivityWidget>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onWindowChange = vi.fn();
  const onOpenNodeDetails = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <LiveMeshActivityWidget
        id="w1"
        windowMinutes={10}
        onWindowChange={onWindowChange}
        onRemove={vi.fn()}
        onOpenNodeDetails={onOpenNodeDetails}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onWindowChange, onOpenNodeDetails };
}

describe('LiveMeshActivityWidget', () => {
  beforeEach(() => {
    getNodeActivity.mockReset();
    sourceState.sourceId = 'src-a';
  });

  it('shows how to enable the packet log when it is off', async () => {
    getNodeActivity.mockResolvedValue({ enabled: false, windowStart: NOW, coverageStart: null, truncated: false, nodes: [] });
    renderWidget();
    expect(await screen.findByTestId('live-activity-disabled')).toBeTruthy();
    expect(screen.getByText('dashboard.widget.live_mesh_activity.disabled_title')).toBeTruthy();
    expect(screen.getByText('dashboard.widget.live_mesh_activity.disabled_where')).toBeTruthy();
    expect(screen.queryByTestId('live-activity-row')).toBeNull();
  });

  it('asks for a source when none is selected, without fetching', () => {
    sourceState.sourceId = null;
    renderWidget();
    expect(screen.getByText('dashboard.widget.live_mesh_activity.no_source')).toBeTruthy();
    expect(getNodeActivity).not.toHaveBeenCalled();
  });

  it('shows the "data covers since" line only when truncated', async () => {
    getNodeActivity.mockResolvedValue({ enabled: true, windowStart: NOW - 600_000, coverageStart: NOW - 60_000, truncated: true, nodes: [node({})] });
    renderWidget();
    expect(await screen.findByTestId('live-activity-truncated')).toBeTruthy();
  });

  it('omits the truncation line when the log covers the window', async () => {
    getNodeActivity.mockResolvedValue({ enabled: true, windowStart: NOW - 600_000, coverageStart: NOW - 7_200_000, truncated: false, nodes: [node({})] });
    renderWidget();
    await screen.findByTestId('live-activity-row');
    expect(screen.queryByTestId('live-activity-truncated')).toBeNull();
  });

  it('fetches RF-only by default and all transports when toggled', async () => {
    getNodeActivity.mockResolvedValue({ enabled: true, windowStart: NOW, coverageStart: null, truncated: false, nodes: [] });
    renderWidget();
    await waitFor(() => expect(getNodeActivity).toHaveBeenCalledWith('src-a', 10, 'rf'));
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(getNodeActivity).toHaveBeenCalledWith('src-a', 10, 'all'));
  });

  it('saves a new window and refetches with it', async () => {
    getNodeActivity.mockResolvedValue({ enabled: true, windowStart: NOW, coverageStart: null, truncated: false, nodes: [] });
    const { onWindowChange } = renderWidget();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '30' } });
    expect(onWindowChange).toHaveBeenCalledWith(30);
    await waitFor(() => expect(getNodeActivity).toHaveBeenCalledWith('src-a', 30, 'rf'));
  });

  it('does not save the window for a read-only viewer', async () => {
    getNodeActivity.mockResolvedValue({ enabled: true, windowStart: NOW, coverageStart: null, truncated: false, nodes: [] });
    const { onWindowChange } = renderWidget({ canEdit: false });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '5' } });
    expect(onWindowChange).not.toHaveBeenCalled();
    await waitFor(() => expect(getNodeActivity).toHaveBeenCalledWith('src-a', 5, 'rf'));
  });

  it('opens node details on row click, deriving the id when the row has none', async () => {
    getNodeActivity.mockResolvedValue({
      enabled: true, windowStart: NOW, coverageStart: null, truncated: false,
      nodes: [node({ nodeNum: 0xabc, nodeId: null, shortName: null, longName: null })],
    });
    const { onOpenNodeDetails } = renderWidget();
    fireEvent.click(await screen.findByTestId('live-activity-row'));
    expect(onOpenNodeDetails).toHaveBeenCalledWith('!00000abc');
  });

  it('renders the columns and an SNR trend, newest first, and sorts by packets', async () => {
    getNodeActivity.mockResolvedValue({
      enabled: true, windowStart: NOW, coverageStart: null, truncated: false,
      nodes: [
        node({ nodeNum: 1, nodeId: '!00000001', shortName: 'NEW', packets: 2, extraReceptions: 1, lastSnr: 8, avgSnr: 4, lastHops: 2, minHops: 0, lastHeard: NOW - 1000 }),
        node({ nodeNum: 2, nodeId: '!00000002', shortName: 'OLD', packets: 9, lastSnr: -3, avgSnr: 2, lastHeard: NOW - 120_000 }),
      ],
    });
    renderWidget();
    let rows = await screen.findAllByTestId('live-activity-row');
    expect(within(rows[0]).getByText('NEW')).toBeTruthy();
    expect(within(rows[0]).getByText('2 / 0')).toBeTruthy();
    expect(within(rows[0]).getByText('8.0 dB')).toBeTruthy();
    expect(rows[0].querySelector('[data-trend="up"]')).not.toBeNull();
    expect(rows[1].querySelector('[data-trend="down"]')).not.toBeNull();

    fireEvent.click(screen.getByTitle(/sort_by.*col_packets/));
    rows = screen.getAllByTestId('live-activity-row');
    expect(within(rows[0]).getByText('OLD')).toBeTruthy();
  });
});
