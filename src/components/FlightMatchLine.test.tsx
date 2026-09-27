/**
 * @vitest-environment jsdom
 *
 * FlightMatchLine (#5374): lazy fetch gated on likelyAircraft + the global
 * enable flag, the "Matched"/"Possible match" line, link and credit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import FlightMatchLine from './FlightMatchLine';
import type { FlightMatch } from '../types/flightMatch';

const get = vi.fn();
const getFlightMatch = vi.fn();
vi.mock('../services/api', () => ({
  default: {
    get: (...args: unknown[]) => get(...args),
    getFlightMatch: (...args: unknown[]) => getFlightMatch(...args),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, vars?: Record<string, string>) =>
      vars ? fallback.replace(/\{\{(\w+)\}\}/g, (_m, k) => vars[k] ?? '') : fallback,
  }),
}));

const MATCH: FlightMatch = {
  nodeNum: 123,
  status: 'matched',
  feed: 'adsb.lol',
  hex: 'a1b2c3',
  callsign: 'UAL123',
  aircraftType: 'B738',
  registration: 'N12345',
  gsKt: 450,
  trackDeg: 270,
  altM: 3000,
  distanceKm: 1.2,
  matchedAt: 1,
  feedName: 'adsb.lol',
  flightUrl: 'https://adsb.lol/?icao=a1b2c3',
  attribution: 'Data: adsb.lol',
};

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('FlightMatchLine', () => {
  beforeEach(() => {
    get.mockReset();
    getFlightMatch.mockReset();
    get.mockResolvedValue({ adsbMatchEnabled: 'true' });
  });

  it('renders the matched line, linked to the feed, with a credit', async () => {
    getFlightMatch.mockResolvedValue(MATCH);
    render(wrap(<FlightMatchLine sourceId="src-a" nodeNum={123} likelyAircraft variant="popup" />));
    const link = await screen.findByRole('link');
    expect(link.textContent).toBe('Matched: UAL123 · B738 · N12345 · 450 kt 270°');
    expect(link.getAttribute('href')).toBe('https://adsb.lol/?icao=a1b2c3');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(screen.getByText('Data: adsb.lol')).toBeTruthy();
    expect(getFlightMatch).toHaveBeenCalledWith('src-a', 123);
  });

  it('says "Possible match" for a one-fix match (details variant)', async () => {
    getFlightMatch.mockResolvedValue({ ...MATCH, status: 'possible', registration: null });
    render(wrap(<FlightMatchLine sourceId="src-a" nodeNum={123} likelyAircraft variant="details" />));
    expect((await screen.findByRole('link')).textContent).toBe('Possible match: UAL123 · B738 · 450 kt 270°');
    expect(screen.getByText('Flight (ADS-B)')).toBeTruthy();
  });

  it('renders nothing when there is no match', async () => {
    getFlightMatch.mockResolvedValue(null);
    const { container } = render(wrap(<FlightMatchLine sourceId="src-a" nodeNum={123} likelyAircraft variant="popup" />));
    await waitFor(() => expect(getFlightMatch).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('does not fetch while matching is off', async () => {
    get.mockResolvedValue({ adsbMatchEnabled: 'false' });
    render(wrap(<FlightMatchLine sourceId="src-a" nodeNum={123} likelyAircraft variant="popup" />));
    await waitFor(() => expect(get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(getFlightMatch).not.toHaveBeenCalled();
  });

  it('does not fetch without a source or for an unflagged node', async () => {
    render(wrap(<FlightMatchLine sourceId={null} nodeNum={123} likelyAircraft variant="popup" />));
    render(wrap(<FlightMatchLine sourceId="src-a" nodeNum={123} likelyAircraft={false} variant="popup" />));
    await new Promise((r) => setTimeout(r, 10));
    expect(getFlightMatch).not.toHaveBeenCalled();
  });

  it('renders nothing (and does not throw) outside a QueryClientProvider', () => {
    const { container } = render(<FlightMatchLine sourceId="src-a" nodeNum={123} likelyAircraft variant="popup" />);
    expect(container.textContent).toBe('');
    expect(get).not.toHaveBeenCalled();
  });
});
