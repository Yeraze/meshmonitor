/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import DashboardNodePopup from './DashboardNodePopup';

vi.mock('../../contexts/SettingsContext', () => ({
  useDisplaySettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));

const pos = { lat: 35.12345, lng: -80.6789 };

describe('DashboardNodePopup', () => {
  it('renders name, short name, node ID, role, hardware, and hops from flat fields', () => {
    render(
      <DashboardNodePopup
        pos={pos}
        node={{
          nodeNum: 42,
          nodeId: '!0000002a',
          longName: 'Tower Node',
          shortName: 'TWR',
          role: 2,
          hwModel: 9,
          hopsAway: 3,
          lastHeard: Math.floor(Date.now() / 1000) - 120,
        }}
      />,
    );
    expect(screen.getByText('Tower Node')).toBeInTheDocument();
    expect(screen.getByText('TWR')).toBeInTheDocument();
    expect(screen.getByText('!0000002a')).toBeInTheDocument();
    expect(screen.getByText('3 hops')).toBeInTheDocument();
    // Coordinates always shown
    expect(screen.getByText('35.12345, -80.67890')).toBeInTheDocument();
  });

  it('falls back to nested user/position fields', () => {
    render(
      <DashboardNodePopup
        pos={pos}
        node={{
          nodeNum: 7,
          user: { id: '!00000007', longName: 'Nested Node', shortName: 'NST' },
          position: { altitude: 120 },
          hopsAway: 0,
        }}
      />,
    );
    expect(screen.getByText('Nested Node')).toBeInTheDocument();
    expect(screen.getByText('NST')).toBeInTheDocument();
    expect(screen.getByText('!00000007')).toBeInTheDocument();
    expect(screen.getByText('0 hops')).toBeInTheDocument();
    expect(screen.getByText('120m')).toBeInTheDocument();
  });

  it('renders the per-source list with protocol badges on the unified view', () => {
    render(
      <DashboardNodePopup
        pos={pos}
        node={{
          nodeNum: 100,
          longName: 'Shared Node',
          sources: [
            { sourceId: 'a', sourceName: 'Tower Alpha', protocol: 'Meshtastic' },
            { sourceId: 'b', sourceName: 'Core Bravo', protocol: 'MeshCore' },
          ],
        }}
      />,
    );
    expect(screen.getByText('Seen by 2 sources')).toBeInTheDocument();
    expect(screen.getByText('Tower Alpha')).toBeInTheDocument();
    expect(screen.getByText('Core Bravo')).toBeInTheDocument();
    expect(screen.getByText('Meshtastic')).toBeInTheDocument();
    expect(screen.getByText('MeshCore')).toBeInTheDocument();
  });

  it('omits the sources section for single-source nodes', () => {
    render(
      <DashboardNodePopup
        pos={pos}
        node={{ nodeNum: 1, longName: 'Solo Node' }}
      />,
    );
    expect(screen.queryByText(/Seen by/)).not.toBeInTheDocument();
  });
});
