/**
 * @vitest-environment jsdom
 *
 * Tests for the message route-detail modal: clicking a received message's
 * relay-hash chain opens this popup, which shows message details and expands
 * each relay hash to the matching repeater / room-server name (mirroring the
 * {ROUTE_NAMES} automation token — unknown hashes stay raw, collisions are
 * annotated as a best guess). When every hop resolves to a positioned
 * contact, a mini map traces the packet flow with labeled hop markers
 * (BaseMap/react-leaflet stubbed — mirrors the MeshCoreMap.test.tsx style).
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === 'string') return fallback;
      return key;
    },
  }),
  Trans: ({ children }: { children?: unknown }) => children,
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('../map/BaseMap', () => ({
  BaseMap: ({ children }: { children?: ReactNode }) => <div data-testid="base-map">{children}</div>,
}));

vi.mock('react-leaflet', () => ({
  CircleMarker: ({ children }: { children?: ReactNode }) => <div data-testid="flow-marker">{children}</div>,
  Polyline: () => <div data-testid="flow-line" />,
  Tooltip: ({ children }: { children?: ReactNode }) => <span data-testid="flow-label">{children}</span>,
  useMap: () => ({ setView: vi.fn(), fitBounds: vi.fn() }),
}));

import MeshCoreMessageRouteModal from './MeshCoreMessageRouteModal';
import type { MeshCoreMessage } from './hooks/useMeshCore';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

const msg = (over: Partial<MeshCoreMessage> = {}): MeshCoreMessage => ({
  id: 'm1',
  fromPublicKey: 'deadbeefcafe',
  fromName: 'Sender',
  text: 'test ping',
  timestamp: Date.now(),
  hopCount: 2,
  routePath: 'a3,7f',
  ...over,
});

const contacts: MeshCoreContact[] = [
  { publicKey: 'a3' + 'b'.repeat(62), advType: 2, advName: 'Hilltop' },
  { publicKey: '7f' + 'c'.repeat(62), advType: 3, advName: 'Downtown Room' },
];

describe('MeshCoreMessageRouteModal', () => {
  it('shows message details and resolves relay hashes to repeater names', () => {
    render(
      <MeshCoreMessageRouteModal
        message={msg()}
        fromLabel="Sender"
        contacts={contacts}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Message Route')).toBeTruthy();
    expect(screen.getByText('Sender')).toBeTruthy();
    expect(screen.getByText('test ping')).toBeTruthy();
    // Per-hop rows resolve to names; the summary row joins them (icon arrows).
    const resolved = document.querySelector('.mc-route-resolved');
    expect(resolved?.textContent).toContain('Hilltop');
    expect(resolved?.textContent).toContain('Downtown Room');
    // Hash width inferred from the hop hex length (2 chars = 1 byte).
    expect(screen.getByText('1 B')).toBeTruthy();
  });

  it('leaves unknown hashes raw and annotates collisions as a best guess', () => {
    const twins: MeshCoreContact[] = [
      { publicKey: 'a3' + 'b'.repeat(62), advType: 2, advName: 'Twin One' },
      { publicKey: 'a3' + 'c'.repeat(62), advType: 2, advName: 'Twin Two' },
    ];
    render(
      <MeshCoreMessageRouteModal
        message={msg({ routePath: 'a3,ff' })}
        fromLabel="Sender"
        contacts={twins}
        onClose={() => {}}
      />,
    );
    // Collision → alphabetical first (no positions) + best-guess note.
    expect(screen.getAllByText(/best guess of/).length).toBeGreaterThan(0);
    // Unknown hash "ff" falls back to raw hex in the summary.
    const resolved = document.querySelector('.mc-route-resolved');
    expect(resolved?.textContent).toContain('Twin One');
    expect(resolved?.textContent).toContain('ff');
    // Per-hop row text is split around the arrow icon — match on substring.
    expect(screen.getAllByText(/unknown repeater/).length).toBeGreaterThan(0);
  });

  it('shows the direct fallback when the message has no relay path', () => {
    render(
      <MeshCoreMessageRouteModal
        message={msg({ routePath: null, hopCount: 0 })}
        fromLabel="Sender"
        contacts={contacts}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Direct (no relays)')).toBeTruthy();
  });

  it('invokes onClose from the close button and backdrop, not the content', () => {
    const onClose = vi.fn();
    const { container } = render(
      <MeshCoreMessageRouteModal
        message={msg()}
        fromLabel="Sender"
        contacts={contacts}
        onClose={onClose}
      />,
    );
    fireEvent.click(container.querySelector('.mcpm-modal-content')!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector('.mcpm-modal')!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('is an accessible dialog: role/aria set, focused on mount, Escape closes', () => {
    const onClose = vi.fn();
    const { container } = render(
      <MeshCoreMessageRouteModal
        message={msg()}
        fromLabel="Sender"
        contacts={contacts}
        onClose={onClose}
      />,
    );
    const content = container.querySelector('.mcpm-modal-content')!;
    expect(content.getAttribute('role')).toBe('dialog');
    expect(content.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(content);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe('packet-flow map', () => {
    const positioned: MeshCoreContact[] = [
      { publicKey: 'a3' + 'b'.repeat(62), advType: 2, advName: 'Hilltop', latitude: 30.0, longitude: -90.0 },
      { publicKey: '7f' + 'c'.repeat(62), advType: 3, advName: 'Downtown Room', latitude: 30.0, longitude: -89.9 },
    ];

    it('renders the flow map with numbered hop labels when all hops have positions', () => {
      render(
        <MeshCoreMessageRouteModal
          message={msg()}
          fromLabel="Sender"
          contacts={positioned}
          onClose={() => {}}
        />,
      );
      expect(screen.getByTestId('base-map')).toBeTruthy();
      expect(screen.getByTestId('flow-line')).toBeTruthy();
      const labels = screen.getAllByTestId('flow-label').map((el) => el.textContent);
      expect(labels).toContain('#1 Hilltop');
      expect(labels).toContain('#2 Downtown Room');
    });

    it('prepends the sender and appends the local node when they have positions', () => {
      const withEndpoints: MeshCoreContact[] = [
        ...positioned,
        { publicKey: 'deadbeefcafe' + 'e'.repeat(52), advType: 1, advName: 'Sender Node', latitude: 30.0, longitude: -90.1 },
        { publicKey: '99' + 'f'.repeat(62), advType: 1, advName: 'Base (local)', latitude: 30.0, longitude: -89.8 },
      ];
      render(
        <MeshCoreMessageRouteModal
          message={msg()}
          fromLabel="Sender"
          contacts={withEndpoints}
          onClose={() => {}}
        />,
      );
      const labels = screen.getAllByTestId('flow-label').map((el) => el.textContent);
      expect(labels[0]).toBe('Sender');
      expect(labels[labels.length - 1]).toBe('You');
      expect(labels).toHaveLength(4);
    });

    it('shows no map when any hop lacks a position', () => {
      const partial: MeshCoreContact[] = [
        { publicKey: 'a3' + 'b'.repeat(62), advType: 2, advName: 'Hilltop', latitude: 30.0, longitude: -90.0 },
        { publicKey: '7f' + 'c'.repeat(62), advType: 3, advName: 'Downtown Room' }, // no position
      ];
      render(
        <MeshCoreMessageRouteModal
          message={msg()}
          fromLabel="Sender"
          contacts={partial}
          onClose={() => {}}
        />,
      );
      expect(screen.queryByTestId('base-map')).toBeNull();
    });

    it('shows no map when a hop is unknown, even if others are positioned', () => {
      render(
        <MeshCoreMessageRouteModal
          message={msg({ routePath: 'a3,ff' })}
          fromLabel="Sender"
          contacts={positioned}
          onClose={() => {}}
        />,
      );
      expect(screen.queryByTestId('base-map')).toBeNull();
    });
  });
});
