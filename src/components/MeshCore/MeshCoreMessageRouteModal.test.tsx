/**
 * @vitest-environment jsdom
 *
 * Tests for the message route-detail modal: clicking a received message's
 * relay-hash chain opens this popup, which shows message details and expands
 * each relay hash to the matching repeater / room-server name (mirroring the
 * {ROUTE_NAMES} automation token — unknown hashes stay raw, collisions are
 * annotated as a best guess).
 */
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
});
