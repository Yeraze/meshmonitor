/**
 * @vitest-environment jsdom
 *
 * Sort/search/favorite/copy behavior for the Reticulum destinations table
 * (#3960 Phase 1b WP3), plus the derived "announce rate" formula and
 * null-signal rendering (build spec §2/§3a).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === 'string') return fallback;
      return key;
    },
  }),
}));

vi.mock('../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));

import {
  ReticulumDestinationsView,
  computeAnnounceRatePerSecond,
  formatAnnounceRate,
} from './ReticulumDestinationsView';
import type { ReticulumDestinationRow } from '../../types/reticulum';

const NOW = Date.now();
const HOUR_MS = 60 * 60 * 1000;

function makeRow(overrides: Partial<ReticulumDestinationRow>): ReticulumDestinationRow {
  return {
    sourceId: 'source-a',
    destinationHash: 'a'.repeat(32),
    identityHash: null,
    appName: 'rnsapp',
    aspects: 'chat',
    displayName: 'Alpha',
    appDataB64: null,
    hops: 2,
    nextHopInterface: null,
    rssi: -80,
    snr: 5.5,
    quality: 90,
    announceCount: 4,
    firstSeen: NOW - 4 * HOUR_MS,
    lastSeen: NOW - 1 * HOUR_MS,
    lastAnnounceAt: NOW - 1 * HOUR_MS,
    isFavorite: false,
    createdAt: NOW - 4 * HOUR_MS,
    updatedAt: NOW - 1 * HOUR_MS,
    ...overrides,
  };
}

const rowAlpha = makeRow({
  destinationHash: 'a'.repeat(32),
  displayName: 'Alpha',
  lastSeen: NOW - 1 * HOUR_MS,
  isFavorite: false,
});
const rowBravo = makeRow({
  destinationHash: 'b'.repeat(32),
  displayName: 'Bravo',
  lastSeen: NOW - 3 * HOUR_MS,
  isFavorite: false,
});
const rowCharlie = makeRow({
  destinationHash: 'c'.repeat(32),
  displayName: 'Charlie',
  lastSeen: NOW - 2 * HOUR_MS,
  isFavorite: true,
});

function listedNames(): string[] {
  return Array.from(document.querySelectorAll('tbody tr')).map(
    (row) => row.querySelector('td:nth-child(3)')?.textContent || '',
  );
}

describe('ReticulumDestinationsView', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('sorts favorites first, then by last-heard descending by default', () => {
    render(
      <ReticulumDestinationsView
        destinations={[rowAlpha, rowBravo, rowCharlie]}
        onToggleFavorite={vi.fn()}
      />,
    );
    // Charlie is favorited so it pins to the top; Alpha (1h ago) then Bravo
    // (3h ago) follow in descending recency.
    expect(listedNames()).toEqual(['Charlie', 'Alpha', 'Bravo']);
  });

  it('toggles sort field and direction', () => {
    render(
      <ReticulumDestinationsView
        destinations={[rowAlpha, rowBravo, rowCharlie]}
        onToggleFavorite={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'name' } });
    // Favorites-first still applies: Charlie (favorite) first, then Alpha,
    // Bravo alphabetically (desc default direction).
    expect(listedNames()).toEqual(['Charlie', 'Bravo', 'Alpha']);

    // The button's label reflects the CURRENT direction (desc, still
    // unchanged by the sort-field switch above); clicking it flips to asc.
    fireEvent.click(screen.getByLabelText('Descending'));
    expect(listedNames()).toEqual(['Charlie', 'Alpha', 'Bravo']);
  });

  it('filters rows via the search box', () => {
    render(
      <ReticulumDestinationsView
        destinations={[rowAlpha, rowBravo, rowCharlie]}
        onToggleFavorite={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('Search destinations…'), {
      target: { value: 'bravo' },
    });
    expect(listedNames()).toEqual(['Bravo']);

    fireEvent.click(screen.getByLabelText('Clear'));
    expect(listedNames()).toEqual(['Charlie', 'Alpha', 'Bravo']);
  });

  it('copies the destination hash to the clipboard', async () => {
    render(
      <ReticulumDestinationsView
        destinations={[rowAlpha]}
        onToggleFavorite={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle(rowAlpha.destinationHash));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(rowAlpha.destinationHash);
  });

  it('invokes onToggleFavorite with the destination hash and next state', () => {
    const onToggleFavorite = vi.fn();
    render(
      <ReticulumDestinationsView
        destinations={[rowAlpha]}
        onToggleFavorite={onToggleFavorite}
      />,
    );
    fireEvent.click(screen.getByLabelText('Add to favorites'));
    expect(onToggleFavorite).toHaveBeenCalledWith(rowAlpha.destinationHash, true);
  });

  it('derives announce rate from announceCount and the seen window', () => {
    const row = makeRow({
      announceCount: 4,
      firstSeen: 0,
      lastSeen: 3600 * 1000, // exactly one hour elapsed
    });
    // 4 announces / 3600s = 1/900 per second → *3600 = 4/hr.
    expect(computeAnnounceRatePerSecond(row)).toBeCloseTo(4 / 3600, 10);
    expect(formatAnnounceRate(row)).toBe('4.0/hr');
  });

  it('falls back to a /day rate when the hourly figure reads as near-zero', () => {
    const row = makeRow({
      announceCount: 1,
      firstSeen: 0,
      lastSeen: 30 * 24 * 3600 * 1000, // 30 days elapsed, single announce
    });
    const perHour = computeAnnounceRatePerSecond(row) * 3600;
    expect(perHour).toBeLessThan(1);
    expect(formatAnnounceRate(row)).toBe(`${(perHour * 24).toFixed(2)}/day`);
  });

  it('guards against a zero-length seen window (freshly-seen destination)', () => {
    const row = makeRow({ announceCount: 2, firstSeen: NOW, lastSeen: NOW });
    // max(1, 0) elapsed seconds → finite, not Infinity/NaN.
    expect(Number.isFinite(computeAnnounceRatePerSecond(row))).toBe(true);
    expect(computeAnnounceRatePerSecond(row)).toBe(2);
  });

  it('renders "—" instead of a fake rate for a destination seen exactly once', () => {
    // announceCount === 1 && firstSeen === lastSeen: the max(1, …) clamp in
    // computeAnnounceRatePerSecond would otherwise report "1.0/hr", implying
    // active traffic for a single sighting (review finding).
    const row = makeRow({ announceCount: 1, firstSeen: NOW, lastSeen: NOW });
    expect(formatAnnounceRate(row)).toBe('—');

    // A row with the SAME single-announce shape but a genuinely elapsed
    // window (firstSeen !== lastSeen) is a distinct, real destination that
    // was announced once a while ago — the guard must not swallow that case.
    const elapsedOnce = makeRow({ announceCount: 1, firstSeen: NOW - HOUR_MS, lastSeen: NOW });
    expect(formatAnnounceRate(elapsedOnce)).not.toBe('—');
  });

  it('renders "—" for null RSSI/SNR/quality/hops instead of 0 or blank', () => {
    const row = makeRow({
      destinationHash: 'd'.repeat(32),
      displayName: 'DestNull',
      rssi: null,
      snr: null,
      quality: null,
      hops: null,
    });
    render(
      <ReticulumDestinationsView
        destinations={[row]}
        onToggleFavorite={vi.fn()}
      />,
    );
    const cells = Array.from(document.querySelectorAll('tbody tr td')).map(td => td.textContent);
    // columns: [favorite btn, hash, name, app, aspects, hops, rssi, snr, quality, lastHeard, rate]
    expect(cells[5]).toBe('—'); // hops
    expect(cells[6]).toBe('—'); // rssi
    expect(cells[7]).toBe('—'); // snr
    expect(cells[8]).toBe('—'); // quality
  });

  it('shows an empty state when there are no destinations', () => {
    render(<ReticulumDestinationsView destinations={[]} onToggleFavorite={vi.fn()} />);
    expect(screen.getByText('No destinations seen yet')).toBeInTheDocument();
  });
});
