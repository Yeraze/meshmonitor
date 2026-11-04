/**
 * @vitest-environment jsdom
 *
 * Tests for the shared RouteHopRows component (#6190): the per-hop relay-chain
 * rows reused by the Message Route and Packet Decode modals. Each hop is one
 * `#N` row with the hash first and the resolved / best-guess name; an empty
 * route renders the "Direct (no relays)" fallback.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

import { RouteHopRows } from './MeshCoreRouteHops';
import type { ResolvedRouteHopWithFallback } from '../../utils/meshcorePath';

const ownHop = (byte: string, name: string, matchCount = 1): ResolvedRouteHopWithFallback => ({
  byte,
  name,
  matchCount,
  position: null,
  origin: 'own',
  via: null,
  tentative: false,
  candidates: [],
});

describe('RouteHopRows', () => {
  it('renders one numbered row per hop with its resolved name', () => {
    render(<RouteHopRows rows={[ownHop('a3', 'Hilltop'), ownHop('7f', 'Downtown Room')]} />);
    expect(screen.getByText('#1')).toBeTruthy();
    expect(screen.getByText('#2')).toBeTruthy();
    expect(screen.getByText('Hilltop')).toBeTruthy();
    expect(screen.getByText('Downtown Room')).toBeTruthy();
    // The hop hash leads the row.
    expect(screen.getByText('a3')).toBeTruthy();
    expect(screen.getByText('7f')).toBeTruthy();
  });

  it('flags a collision among own contacts as a best guess', () => {
    render(<RouteHopRows rows={[ownHop('a3', 'Twin One', 2)]} />);
    expect(screen.getByText(/best guess of/)).toBeTruthy();
  });

  it('shows the raw hash and "unknown repeater" for an unmatched hop', () => {
    const unknown: ResolvedRouteHopWithFallback = {
      byte: 'ff',
      name: null,
      matchCount: 0,
      position: null,
      origin: 'none',
      via: null,
      tentative: false,
      candidates: [],
    };
    render(<RouteHopRows rows={[unknown]} />);
    expect(screen.getByText('ff')).toBeTruthy();
    expect(screen.getByText('unknown repeater')).toBeTruthy();
  });

  it('renders the direct empty-state when there are no hops', () => {
    render(<RouteHopRows rows={[]} />);
    expect(screen.getByText('Direct (no relays)')).toBeTruthy();
  });
});
