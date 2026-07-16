/**
 * @vitest-environment jsdom
 *
 * Regression tests for issue #4130 — the Node Details block renders a node's
 * latitude/longitude and elevation as plain text (so a bogus fix like 0,0 is
 * visible without opening a map).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import NodeDetailsBlock from './NodeDetailsBlock';
import type { DeviceInfo } from '../types/device';

// The block reads channels/current-node/settings/map-context via hooks; stub
// them so the component renders standalone. `t(key, def)` returns the provided
// default (falling back to the key) so label lookups don't need a real bundle —
// the assertions below target the language-independent coordinate/elevation
// values, not the labels.
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

const baseNode: DeviceInfo = {
  nodeNum: 123,
  user: { id: '!0000007b', longName: 'Node', shortName: 'N', role: 'CLIENT' },
};

describe('NodeDetailsBlock position/elevation (#4130)', () => {
  it('renders latitude/longitude and elevation text when the node has a position', () => {
    render(
      <NodeDetailsBlock
        node={{ ...baseNode, position: { latitude: 35.123456, longitude: -80.654321, altitude: 120 } }}
      />,
    );
    expect(screen.getByText('Position')).toBeInTheDocument();
    // 5-decimal rounding, matching the map popup's PositionItem.
    expect(screen.getByText('35.12346, -80.65432')).toBeInTheDocument();
    expect(screen.getByText('Elevation')).toBeInTheDocument();
    expect(screen.getByText('120m')).toBeInTheDocument();
  });

  it('omits elevation when altitude is absent but still shows coordinates', () => {
    render(
      <NodeDetailsBlock node={{ ...baseNode, position: { latitude: 0, longitude: 0 } }} />,
    );
    // A bogus 0,0 fix is exactly what this feature exists to make visible.
    expect(screen.getByText('0.00000, 0.00000')).toBeInTheDocument();
    expect(screen.queryByText('Elevation')).not.toBeInTheDocument();
  });

  it('renders neither Position nor Elevation when the node has no position', () => {
    render(<NodeDetailsBlock node={baseNode} />);
    expect(screen.queryByText('Position')).not.toBeInTheDocument();
    expect(screen.queryByText('Elevation')).not.toBeInTheDocument();
  });
});
