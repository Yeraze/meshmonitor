/**
 * @vitest-environment jsdom
 *
 * CoverageReport query-stability regression test (#5277, browser-validation
 * bug). An earlier version computed `{ sinceMs, untilMs }` from `Date.now()`
 * inline on every render. TanStack Query's default `queryKeyHashFn` does
 * structural (JSON) equality, so a numeric value that changes by even 1ms
 * produced a genuinely different query key EVERY render — an endless
 * ~6 req/s refetch loop (`/senders` + `/receptions`) that kept `isLoading`
 * permanently true (Refresh stayed disabled, the map never rendered).
 *
 * Unlike CoverageReport.test.tsx (which mocks `useCoverageData` entirely to
 * test CoverageReport's own filter wiring in isolation), THIS file exercises
 * the REAL `useCoverageData` hooks inside a real `QueryClientProvider`, with
 * only the underlying `analysisApi` fetchers mocked — a regression to
 * render-time `Date.now()` would show up here as more than one fetcher call
 * after the component settles. Real timers throughout (no fake timers): the
 * bug was a real-world render-loop, and fake timers would mask it.
 */
import type { CoverageReceptionDto } from '../../types/coverage';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
      if (typeof fallback === 'string') {
        const vars = (opts ?? {}) as Record<string, unknown>;
        return fallback.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
      }
      return _key;
    },
  }),
}));

vi.mock('./CoverageMap', () => ({
  CoverageMap: () => <div data-testid="coverage-map-stub" />,
}));

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({ distanceUnit: 'km' }),
}));

// P4a WP1/WP3 modules (COVERAGE_P4_SPEC.md §2a) — separate worktrees that
// merge before this WP; their real files do not exist here. Trivial
// stand-ins so CoverageReport's OWN query-stability behaviour (the thing
// this file actually regression-tests) is what's under test, not these.
vi.mock('../../utils/coverageGaps', () => ({
  detectCoverageGaps: vi.fn(() => ({
    intervalSec: 30,
    intervalSource: 'default',
    gaps: [],
    breaks: 0,
    heard: 0,
    expected: 0,
  })),
}));
vi.mock('../../utils/coverageSummary', () => ({
  summarizeCoverage: vi.fn(() => ({
    fixesHeard: 0,
    receptions: 0,
    bestSnr: null,
    worstSnr: null,
    bestRssi: null,
    worstRssi: null,
    receivers: [],
    distancePoints: [],
  })),
}));
vi.mock('../../utils/coverageGrid', () => ({
  binFixesToGrid: vi.fn(() => []),
}));
vi.mock('./CoverageSummaryPanel', () => ({
  CoverageSummaryPanel: () => <div data-testid="coverage-summary-panel-stub" />,
}));
vi.mock('./CoverageDistanceChart', () => ({
  CoverageDistanceChart: () => <div data-testid="coverage-distance-chart-stub" />,
}));
vi.mock('./CoverageExportButtons', () => ({
  CoverageExportButtons: () => <div data-testid="coverage-export-buttons-stub" />,
}));

vi.mock('../../services/analysisApi', () => ({
  fetchCoverageReceivers: vi.fn(),
  fetchCoverageSenders: vi.fn(),
  fetchCoverageReceptionsPage: vi.fn(),
  fetchCoverageSurveys: vi.fn(),
}));

// #5277 P4b WP3: CoverageReport now also calls useCoverageSurveys(). Stubbed
// out here (its own query-stability behaviour has no bearing on THIS
// regression test) the same way the P4a WP3 components above are stubbed.
vi.mock('./CoverageSurveyBar', () => ({
  CoverageSurveyBar: () => <div data-testid="coverage-survey-bar-stub" />,
}));

import {
  fetchCoverageReceivers,
  fetchCoverageSenders,
  fetchCoverageReceptionsPage,
  fetchCoverageSurveys,
} from '../../services/analysisApi';
import CoverageReport from './CoverageReport';

function makeReception(): CoverageReceptionDto {
  return {
    id: 1,
    sourceId: 'src-a',
    protocol: 'meshtastic',
    receiverKind: 'local',
    receiverId: '!aaaaaaaa',
    receiverNodeNum: 1,
    receiverLatitude: 26.1,
    receiverLongitude: -80.2,
    senderId: '!bbbbbbbb',
    senderNodeNum: 2,
    packetKey: '100',
    packetId: 100,
    pathKey: 'r0:h0',
    latitude: 26.15,
    longitude: -80.25,
    altitude: null,
    precisionBits: null,
    snr: 5,
    rssi: -80,
    hopStart: 0,
    hopLimit: 0,
    hopsAway: 0,
    relayNode: 0,
    transportMechanism: null,
    channel: 0,
    rxTime: 1_700_000_000,
    receivedAt: 1_700_000_000_000,
  };
}

function renderWithClient() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <CoverageReport />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('CoverageReport query stability (#5277 regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchCoverageReceivers).mockResolvedValue({
      receivers: [
        {
          sourceId: 'src-a', sourceName: 'Source A', protocol: 'meshtastic', receiverKind: 'local',
          receiverId: '!aaaaaaaa', receiverNodeNum: 1, longName: 'Receiver One', shortName: 'R1',
          latitude: 26.1, longitude: -80.2, lastReceivedAt: 1, receptionCount: 3,
        },
      ],
      retentionDays: 7,
      mqttSources: [],
    });
    vi.mocked(fetchCoverageSenders).mockResolvedValue({ senders: [], truncated: false });
    vi.mocked(fetchCoverageReceptionsPage).mockResolvedValue({
      items: [makeReception()],
      pageSize: 1000,
      hasMore: false,
      nextCursor: null,
    });
    vi.mocked(fetchCoverageSurveys).mockResolvedValue([]);
  });

  it('fetches each endpoint exactly once on mount, renders the map, and fetches exactly once more per Refresh click', async () => {
    renderWithClient();

    // Let the component settle across several renders/microtasks — a
    // render-loop regression would keep firing fetches during this window.
    await waitFor(() => expect(screen.getByTestId('coverage-map-stub')).toBeInTheDocument());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    expect(fetchCoverageReceivers).toHaveBeenCalledTimes(1);
    expect(fetchCoverageSenders).toHaveBeenCalledTimes(1);
    expect(fetchCoverageReceptionsPage).toHaveBeenCalledTimes(1);
    expect(fetchCoverageSurveys).toHaveBeenCalledTimes(1);

    // Refresh must be enabled once loading has settled (it stayed
    // permanently disabled under the render-loop bug).
    const refreshButton = screen.getByRole('button', { name: /Refresh/i });
    expect(refreshButton).toBeEnabled();

    fireEvent.click(refreshButton);

    await waitFor(() => expect(fetchCoverageReceivers).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fetchCoverageSenders).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fetchCoverageReceptionsPage).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fetchCoverageSurveys).toHaveBeenCalledTimes(2));

    // Settle again after Refresh and confirm nothing kept looping.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(fetchCoverageReceivers).toHaveBeenCalledTimes(2);
    expect(fetchCoverageSenders).toHaveBeenCalledTimes(2);
    expect(fetchCoverageReceptionsPage).toHaveBeenCalledTimes(2);
    expect(fetchCoverageSurveys).toHaveBeenCalledTimes(2);
  });
});
