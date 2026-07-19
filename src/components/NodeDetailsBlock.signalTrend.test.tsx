/**
 * @vitest-environment jsdom
 *
 * Signal-trend badge rendering tests for NodeDetailsBlock (issue #4110).
 * The badge is fed by apiService.getSignalTrend; here that call is mocked so we
 * assert the component renders the right label/direction per trend state and
 * omits the badge when data is insufficient or no source is selected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import NodeDetailsBlock from './NodeDetailsBlock';
import type { DeviceInfo } from '../types/device';
import type { SignalTrendResult } from '../services/api';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, def?: string) => def ?? key }),
}));
vi.mock('../hooks/useServerData', () => ({
  useChannels: () => ({ channels: [] }),
  useDeviceConfig: () => ({ currentNodeId: null }),
}));
vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({ nodeHopsCalculation: 'client' }),
}));
vi.mock('../contexts/MapContext', () => ({
  useMapContext: () => ({ traceroutes: [] }),
}));
vi.mock('./NodeDetailsBlock.css', () => ({}));

const getSignalTrend = vi.fn();
vi.mock('../services/api', () => ({
  default: { getSignalTrend: (...args: unknown[]) => getSignalTrend(...args) },
}));

const baseNode: DeviceInfo = {
  nodeNum: 0xaabbccdd,
  user: { id: '!aabbccdd', longName: 'Node', shortName: 'N', role: 'CLIENT' },
};

const metric = (delta: number) => ({
  recent: -90, baseline: -90 + delta * -1, delta, recentCount: 5, baselineCount: 20, unit: 'dBm',
});

const trend = (t: SignalTrendResult['trend']): SignalTrendResult => ({
  trend: t,
  basis: t === 'insufficient' ? null : 'rssi',
  rssi: t === 'insufficient' ? null : metric(t === 'degrading' ? -12 : t === 'improving' ? 12 : -1),
  snr: null,
  noiseFloor: null,
  noiseFloorRising: false,
});

describe('NodeDetailsBlock signal trend badge (#4110)', () => {
  beforeEach(() => {
    getSignalTrend.mockReset();
  });

  it('renders a Degrading badge when the trend is degrading', async () => {
    getSignalTrend.mockResolvedValue(trend('degrading'));
    render(<NodeDetailsBlock node={baseNode} sourceId="src-a" />);
    expect(await screen.findByText('Degrading')).toBeInTheDocument();
    expect(screen.getByText('Signal Trend')).toBeInTheDocument();
    expect(getSignalTrend).toHaveBeenCalledWith('!aabbccdd', 'src-a');
  });

  it('renders an Improving badge when the trend is improving', async () => {
    getSignalTrend.mockResolvedValue(trend('improving'));
    render(<NodeDetailsBlock node={baseNode} sourceId="src-a" />);
    expect(await screen.findByText('Improving')).toBeInTheDocument();
  });

  it('renders a Stable badge when the trend is stable', async () => {
    getSignalTrend.mockResolvedValue(trend('stable'));
    render(<NodeDetailsBlock node={baseNode} sourceId="src-a" />);
    expect(await screen.findByText('Stable')).toBeInTheDocument();
  });

  it('renders no badge when the trend is insufficient', async () => {
    getSignalTrend.mockResolvedValue(trend('insufficient'));
    render(<NodeDetailsBlock node={baseNode} sourceId="src-a" />);
    // Give the effect a chance to resolve, then assert absence.
    await waitFor(() => expect(getSignalTrend).toHaveBeenCalled());
    expect(screen.queryByText('Signal Trend')).not.toBeInTheDocument();
  });

  it('does not fetch or render the badge without a sourceId', async () => {
    render(<NodeDetailsBlock node={baseNode} />);
    await Promise.resolve();
    expect(getSignalTrend).not.toHaveBeenCalled();
    expect(screen.queryByText('Signal Trend')).not.toBeInTheDocument();
  });
});
