/**
 * @vitest-environment jsdom
 *
 * Issue #5900: Node Details explains an ESTIMATED position in a bordered box,
 * and shows nothing of the kind for a GPS fix or an override.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import NodeDetailsBlock from './NodeDetailsBlock';
import type { DeviceInfo } from '../types/device';
import apiService, { type PositionEstimateRationale } from '../services/api';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  // Default mock: English fallback with {{vars}} filled in.
  return createReactI18nextMock();
});
vi.mock('../hooks/useServerData', () => ({
  useChannels: () => ({ channels: [] }),
  useDeviceConfig: () => ({ currentNodeId: null }),
}));
vi.mock('../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ nodeHopsCalculation: 'client', distanceUnit: 'km' }),
}));
vi.mock('../contexts/MapContext', () => ({
  useMapContext: () => ({ traceroutes: [] }),
}));
vi.mock('./NodeDetailsBlock.css', () => ({}));

const NODE_NUM = 0x11223344;
const baseNode: DeviceInfo = {
  nodeNum: NODE_NUM,
  user: { id: '!11223344', longName: 'Target', shortName: 'TGT', role: 'CLIENT' },
  position: { latitude: 59.91, longitude: 10.75 },
};

function rationale(extra: Partial<PositionEstimateRationale> = {}): PositionEstimateRationale {
  return {
    nodeNum: NODE_NUM,
    nodeId: '!11223344',
    latitude: 59.91,
    longitude: 10.75,
    uncertaintyKm: 5,
    observationCount: 6,
    updatedAt: Date.now() - 5 * 60_000,
    nEff: 1,
    radiusMethod: 'single_anchor',
    uniqueAnchors: 1,
    uniqueAnchorsIsLowerBound: false,
    singleAnchorDefaultKm: 5,
    anchors: [{
      anchorNodeNum: 0xaaaa0001,
      anchorNodeId: '!aaaa0001',
      anchorLongName: 'Relay A',
      anchorShortName: 'RA',
      anchorLat: 59.91,
      anchorLon: 10.75,
      kind: 'traceroute',
      snrDb: -6.25,
      observedAt: Date.now() - 60_000,
      weight: 0.226309,
      distanceKm: 0,
    }],
    anchorsStored: 1,
    anchorsTruncated: true,
    maxStoredAnchors: 20,
    ...extra,
  };
}

describe('NodeDetailsBlock estimated-position rationale (#5900)', () => {
  let getPositionEstimate: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.restoreAllMocks();
    getPositionEstimate = vi.spyOn(apiService, 'getPositionEstimate');
    vi.spyOn(apiService, 'getSignalTrend').mockRejectedValue(new Error('none'));
  });

  it('explains a single-anchor estimate', async () => {
    getPositionEstimate.mockResolvedValue(rationale());
    render(<NodeDetailsBlock node={{ ...baseNode, positionIsEstimated: true, positionEstimateUncertaintyKm: 5 }} />);

    expect(await screen.findByText('How this position was estimated')).toBeInTheDocument();
    expect(getPositionEstimate).toHaveBeenCalledWith(NODE_NUM);
    expect(screen.getByText(/Single anchor: radio-range default/)).toBeInTheDocument();
    expect(screen.getByText('Unique anchors').nextSibling).toHaveTextContent('1');
    expect(screen.getByText('Observations').nextSibling).toHaveTextContent('6');
    // Short lists open by default.
    expect(screen.getByText('Relay A')).toBeInTheDocument();
    expect(screen.getByText(/SNR -6.25 dB/)).toBeInTheDocument();
    expect(screen.getByText('Showing 1 of 6 observations.')).toBeInTheDocument();
  });

  it('names a converged estimate and collapses a long anchor list', async () => {
    const anchors = Array.from({ length: 5 }, (_, i) => ({
      ...rationale().anchors[0],
      anchorNodeNum: i,
      anchorNodeId: `!0000000${i}`,
      anchorLongName: `Relay ${i}`,
    }));
    getPositionEstimate.mockResolvedValue(rationale({
      radiusMethod: 'convergence', uniqueAnchors: 5, anchors, anchorsStored: 5,
      observationCount: 5, anchorsTruncated: false, uncertaintyKm: 0.4,
    }));
    render(<NodeDetailsBlock node={{ ...baseNode, positionIsEstimated: true }} />);

    expect(await screen.findByText(/Converged from 5 anchors/)).toBeInTheDocument();
    expect(screen.queryByText('Relay 0')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Anchors \(5\)/ }));
    expect(screen.getByText('Relay 0')).toBeInTheDocument();
  });

  it('renders nothing for a GPS position', async () => {
    getPositionEstimate.mockResolvedValue(rationale());
    render(<NodeDetailsBlock node={baseNode} />);
    await waitFor(() => expect(screen.getByText('Position')).toBeInTheDocument());
    expect(getPositionEstimate).not.toHaveBeenCalled();
    expect(screen.queryByText('How this position was estimated')).not.toBeInTheDocument();
  });

  it('renders nothing for an override', () => {
    render(<NodeDetailsBlock node={{ ...baseNode, positionIsOverride: true, positionIsEstimated: true }} />);
    expect(getPositionEstimate).not.toHaveBeenCalled();
  });

  it('renders nothing when the server has no estimate to explain', async () => {
    getPositionEstimate.mockRejectedValue(new Error('404'));
    render(<NodeDetailsBlock node={{ ...baseNode, positionIsEstimated: true }} />);
    await waitFor(() => expect(getPositionEstimate).toHaveBeenCalled());
    expect(screen.queryByText('How this position was estimated')).not.toBeInTheDocument();
  });
});
