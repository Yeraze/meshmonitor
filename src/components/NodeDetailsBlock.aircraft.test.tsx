/**
 * @vitest-environment jsdom
 *
 * #5364/#5365 Phase 2: the Node Details block shows the aircraft age-out and
 * "reclassified as fixed" marks.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import NodeDetailsBlock from './NodeDetailsBlock';
import type { DeviceInfo } from '../types/device';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, def?: string) => (typeof def === 'string' ? def : key) }),
}));
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

const baseNode: DeviceInfo = {
  nodeNum: 123,
  user: { id: '!0000007b', longName: 'Node', shortName: 'N', role: 'CLIENT' },
};

describe('NodeDetailsBlock aircraft marks (#5364/#5365 Phase 2)', () => {
  it('shows "Aged out (likely aircraft)" for an age-out ignore', () => {
    render(<NodeDetailsBlock node={{ ...baseNode, isIgnored: true, aircraftAgedOutAt: 1_700_000_000_000 }} />);
    expect(screen.getByTestId('node-details-aircraft-aged-out')).toHaveTextContent('Aged out (likely aircraft)');
  });

  it('does not show it for a manual ignore or a lifted node', () => {
    const { unmount } = render(<NodeDetailsBlock node={{ ...baseNode, isIgnored: true, aircraftAgedOutAt: null }} />);
    expect(screen.queryByTestId('node-details-aircraft-aged-out')).not.toBeInTheDocument();
    unmount();
    render(<NodeDetailsBlock node={{ ...baseNode, isIgnored: false, aircraftAgedOutAt: 1 }} />);
    expect(screen.queryByTestId('node-details-aircraft-aged-out')).not.toBeInTheDocument();
  });

  it('shows "Reclassified as fixed" only with the fixed mark', () => {
    const { unmount } = render(<NodeDetailsBlock node={{ ...baseNode, aircraftFixedAt: 1_700_000_000_000 }} />);
    expect(screen.getByTestId('node-details-aircraft-fixed')).toHaveTextContent('Reclassified as fixed');
    unmount();
    render(<NodeDetailsBlock node={baseNode} />);
    expect(screen.queryByTestId('node-details-aircraft-fixed')).not.toBeInTheDocument();
  });
});
