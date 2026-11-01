/**
 * @vitest-environment jsdom
 *
 * ReticulumConnectionsGraph (#6119) — the position-free topology view. Proves
 * the rendered graph: a node per destination/relay plus the central local
 * node, the three-item legend, click-to-open destination details, and that an
 * unresolved relay (viaHash with no known destination) renders but is not a
 * click target.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import { ReticulumConnectionsGraph } from './ReticulumConnectionsGraph';
import { LOCAL_NODE_ID } from './reticulumConnectionGraph';
import type { ReticulumDestinationRow, ReticulumPathRow } from '../../types/reticulum';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

function dest(overrides: Partial<ReticulumDestinationRow> = {}): ReticulumDestinationRow {
  return {
    sourceId: 'src-rns', destinationHash: 'deadbeefcafef00d', identityHash: null,
    appName: 'sideband', aspects: null, displayName: 'Alice', appDataB64: null,
    hops: 2, nextHopInterface: null, rssi: -80, snr: 5, quality: null,
    announceCount: 1, firstSeen: 0, lastSeen: 0, lastAnnounceAt: null,
    isFavorite: false, createdAt: 0, updatedAt: 0,
    latitude: null, longitude: null, altitude: null, speed: null,
    bearing: null, accuracy: null, positionUpdatedAt: null,
    ...overrides,
  };
}

function path(overrides: Partial<ReticulumPathRow> = {}): ReticulumPathRow {
  return {
    sourceId: 'src-rns', destinationHash: 'deadbeefcafef00d', viaHash: null,
    hops: 1, interfaceName: null, expiresAt: null, updatedAt: 0,
    ...overrides,
  };
}

describe('ReticulumConnectionsGraph', () => {
  it('shows an empty state when there are no paths', () => {
    render(<ReticulumConnectionsGraph paths={[]} destinations={[dest()]} />);
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByText(/nothing to graph/i)).toBeTruthy();
    // No SVG graph rendered.
    expect(screen.queryByTestId(`reticulum-graph-node-${LOCAL_NODE_ID}`)).toBeNull();
  });

  it('renders the local centre node and a node per destination/relay', () => {
    render(<ReticulumConnectionsGraph
      paths={[
        path({ destinationHash: 'aaaa', viaHash: null }),
        path({ destinationHash: 'bbbb', viaHash: 'relayX' }),
      ]}
      destinations={[dest({ destinationHash: 'aaaa', displayName: 'Alice' })]}
    />);
    expect(screen.getByTestId(`reticulum-graph-node-${LOCAL_NODE_ID}`)).toBeTruthy();
    expect(screen.getByTestId('reticulum-graph-node-dest:aaaa')).toBeTruthy();
    expect(screen.getByTestId('reticulum-graph-node-dest:bbbb')).toBeTruthy();
    expect(screen.getByTestId('reticulum-graph-node-relay:relayX').getAttribute('data-kind')).toBe('relay');
  });

  it('renders the three-item legend', () => {
    render(<ReticulumConnectionsGraph paths={[path({ destinationHash: 'aaaa' })]} destinations={[]} />);
    expect(screen.getByText('Direct link')).toBeTruthy();
    expect(screen.getByText('Through a relay')).toBeTruthy();
    expect(screen.getByText('Relay node')).toBeTruthy();
  });

  it('opens destination details when a resolvable node is clicked', () => {
    render(<ReticulumConnectionsGraph
      paths={[path({ destinationHash: 'aaaa', viaHash: null })]}
      destinations={[dest({ destinationHash: 'aaaa', displayName: 'Alice', rssi: -72 })]}
    />);
    expect(screen.queryByTestId('reticulum-connections-detail')).toBeNull();
    const node = screen.getByTestId('reticulum-graph-node-dest:aaaa');
    expect(node.getAttribute('role')).toBe('button');
    fireEvent.click(node);
    const panel = screen.getByTestId('reticulum-connections-detail');
    expect(panel).toBeTruthy();
    expect(panel.textContent).toContain('Alice');
    expect(panel.textContent).toContain('-72 dBm');
  });

  it('renders an unresolved relay node that is not a click target', () => {
    render(<ReticulumConnectionsGraph
      paths={[path({ destinationHash: 'aaaa', viaHash: 'feedfacecafebabe0123' })]}
      destinations={[dest({ destinationHash: 'aaaa', displayName: 'Alice' })]}
    />);
    const relay = screen.getByTestId('reticulum-graph-node-relay:feedfacecafebabe0123');
    expect(relay.getAttribute('role')).toBeNull(); // not clickable
    fireEvent.click(relay);
    expect(screen.queryByTestId('reticulum-connections-detail')).toBeNull();
  });

  it('closes the detail panel via the close button', () => {
    render(<ReticulumConnectionsGraph
      paths={[path({ destinationHash: 'aaaa', viaHash: null })]}
      destinations={[dest({ destinationHash: 'aaaa', displayName: 'Alice' })]}
    />);
    fireEvent.click(screen.getByTestId('reticulum-graph-node-dest:aaaa'));
    expect(screen.getByTestId('reticulum-connections-detail')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(screen.queryByTestId('reticulum-connections-detail')).toBeNull();
  });
});
