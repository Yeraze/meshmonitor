/**
 * @vitest-environment jsdom
 *
 * Integration smoke for the Node Details sky-view wiring. The two data hooks
 * (`useSkyView`, `useTelemetry`) are mocked so this focuses on the composition:
 * position gating, deferred fetch, and the reported-vs-theoretical diagnostic.
 * The real `SkyPlot` renders from the mocked sky-view data.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NodeSkyView } from './NodeSkyView';
import { useSkyView } from '../../hooks/useSkyView';
import { useTelemetry } from '../../hooks/useTelemetry';
import type { DeviceInfo } from '../../types/device';

vi.mock('../../hooks/useSkyView', () => ({ useSkyView: vi.fn() }));
vi.mock('../../hooks/useTelemetry', () => ({ useTelemetry: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, def?: string) => def ?? _key }),
}));

const skyView = {
  satellites: [
    { name: 'G01', azDeg: 10, elDeg: 70 },
    { name: 'G02', azDeg: 200, elDeg: 30 },
  ],
  dop: null,
  visibleCount: 11,
  isLoading: false,
  error: null,
};

const telemetryRows = [
  { nodeId: '!0000000a', nodeNum: 10, telemetryType: 'sats_in_view', timestamp: 1000, value: 5, createdAt: 1000 },
  { nodeId: '!0000000a', nodeNum: 10, telemetryType: 'sats_in_view', timestamp: 2000, value: 7, createdAt: 2000 },
  { nodeId: '!0000000a', nodeNum: 10, telemetryType: 'voltage', timestamp: 2000, value: 4.1, createdAt: 2000 },
];

const nodeWithPosition = {
  nodeNum: 10,
  user: { id: '!0000000a' },
  position: { latitude: 40.1, longitude: -105.2 },
} as unknown as DeviceInfo;

function mockHooks(sky = skyView, tele = telemetryRows) {
  vi.mocked(useSkyView).mockReturnValue(sky as ReturnType<typeof useSkyView>);
  vi.mocked(useTelemetry).mockReturnValue({ data: tele } as unknown as ReturnType<typeof useTelemetry>);
}

describe('NodeSkyView', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders nothing when the node has no position', () => {
    mockHooks();
    const node = { nodeNum: 10, user: { id: '!0000000a' } } as unknown as DeviceInfo;
    const { container } = render(<NodeSkyView node={node} sourceId="src-a" />);
    expect(container.firstChild).toBeNull();
  });

  it('is collapsed by default: header shown, body (and its data hooks) deferred', () => {
    mockHooks();
    render(<NodeSkyView node={nodeWithPosition} sourceId="src-a" />);
    expect(screen.getByText('GNSS Sky View')).toBeInTheDocument();
    // No satellites rendered while collapsed.
    expect(screen.queryAllByTestId('skyplot-sat')).toHaveLength(0);
    // The data body is unmounted while collapsed, so neither query hook runs —
    // a collapsed section needs no QueryClient and issues no request.
    expect(useSkyView).not.toHaveBeenCalled();
    expect(useTelemetry).not.toHaveBeenCalled();
  });

  it('shows the plot and reported-vs-theoretical diagnostic when expanded', () => {
    mockHooks();
    render(<NodeSkyView node={nodeWithPosition} sourceId="src-a" />);
    fireEvent.click(screen.getByText('GNSS Sky View'));

    // Plot now rendered from the mocked sky-view data.
    expect(screen.getAllByTestId('skyplot-sat')).toHaveLength(2);

    // Diagnostic: latest reported sats_in_view (7) vs theoretical (11).
    expect(screen.getByText('GPS in view')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('11')).toBeInTheDocument();
  });

  it('shows an em dash when there is no reported sats_in_view telemetry', () => {
    mockHooks(skyView, []);
    render(<NodeSkyView node={nodeWithPosition} sourceId="src-a" />);
    fireEvent.click(screen.getByText('GNSS Sky View'));
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('11')).toBeInTheDocument();
  });
});
