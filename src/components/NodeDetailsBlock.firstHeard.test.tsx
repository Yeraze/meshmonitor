/**
 * @vitest-environment jsdom
 *
 * #5390: the Node Details block shows First Heard (Unix seconds) next to
 * Last Heard, and hides it when unknown.
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

const nowS = Math.floor(Date.now() / 1000);
const baseNode: DeviceInfo = {
  nodeNum: 123,
  user: { id: '!0000007b', longName: 'Node', shortName: 'N', role: 'CLIENT' },
  lastHeard: nowS - 60,
};

describe('NodeDetailsBlock First Heard (#5390)', () => {
  it('shows First Heard when the node has one', () => {
    render(<NodeDetailsBlock node={{ ...baseNode, firstHeard: nowS - 3 * 86_400 }} />);
    const card = screen.getByTestId('node-first-heard');
    expect(card).toHaveTextContent('First Heard');
    // Seconds, not ms: 3 days ago must not render as a 1970 / far-past date.
    expect(card).toHaveTextContent(/3 days ago|3d/);
  });

  it('hides First Heard when unknown', () => {
    render(<NodeDetailsBlock node={baseNode} />);
    expect(screen.queryByTestId('node-first-heard')).not.toBeInTheDocument();
  });
});
