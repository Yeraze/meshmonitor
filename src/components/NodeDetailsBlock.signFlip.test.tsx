/**
 * @vitest-environment jsdom
 *
 * #5363: the Node Details block says when the shown position was
 * auto-corrected for a sign flip, and shows what the node reported.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import NodeDetailsBlock from './NodeDetailsBlock';
import type { DeviceInfo } from '../types/device';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
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

const baseNode: DeviceInfo = {
  nodeNum: 123,
  user: { id: '!0000007b', longName: 'Node', shortName: 'N', role: 'CLIENT' },
  position: { latitude: 27.9, longitude: -82.5 },
};

describe('NodeDetailsBlock sign-flip notice (#5363)', () => {
  it('shows the notice and the reported coordinates when corrected', () => {
    render(
      <NodeDetailsBlock
        node={{ ...baseNode, positionSignFlipCorrected: true, reportedLatitude: 27.9, reportedLongitude: 82.5 }}
      />,
    );
    const notice = screen.getByTestId('sign-flip-notice');
    expect(notice).toHaveTextContent('Position auto-corrected (sign flip)');
    expect(notice).toHaveTextContent('Reported: 27.90000, 82.50000');
    // The Position card shows the corrected point.
    expect(screen.getByText('27.90000, -82.50000')).toBeInTheDocument();
  });

  it('shows nothing for an uncorrected position', () => {
    render(<NodeDetailsBlock node={baseNode} />);
    expect(screen.queryByTestId('sign-flip-notice')).not.toBeInTheDocument();
  });
});
