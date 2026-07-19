/**
 * @vitest-environment jsdom
 *
 * Regression tests for issue #4109 — the Node Details quick-stats grid shows
 * a Noise Floor card (dBm) alongside Channel Utilization / Air Utilization TX
 * whenever `deviceMetrics.noiseFloor` is populated, and omits it otherwise.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import NodeDetailsBlock from './NodeDetailsBlock';
import type { DeviceInfo } from '../types/device';

// See NodeDetailsBlock.position.test.tsx for rationale on these stubs.
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

describe('NodeDetailsBlock noise floor card (#4109)', () => {
  it('renders the Noise Floor card with a formatted dBm value', () => {
    render(
      <NodeDetailsBlock
        node={{ ...baseNode, deviceMetrics: { noiseFloor: -97 } }}
      />,
    );
    expect(screen.getByText('node_details.noise_floor')).toBeInTheDocument();
    expect(screen.getByText('-97 dBm')).toBeInTheDocument();
  });

  it('omits the Noise Floor card when noiseFloor is undefined', () => {
    render(
      <NodeDetailsBlock
        node={{ ...baseNode, deviceMetrics: { batteryLevel: 80 } }}
      />,
    );
    expect(screen.queryByText('node_details.noise_floor')).not.toBeInTheDocument();
  });

  it('omits the Noise Floor card when deviceMetrics is absent entirely', () => {
    render(<NodeDetailsBlock node={baseNode} />);
    expect(screen.queryByText('node_details.noise_floor')).not.toBeInTheDocument();
  });
});
