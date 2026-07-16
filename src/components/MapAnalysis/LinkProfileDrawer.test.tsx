/**
 * @vitest-environment jsdom
 *
 * LinkProfileDrawer (Terrain Link Profile epic #4111 Phase 2, WP-B). Mocks:
 *  - `recharts` to simple divs (assertions target stats, not SVG internals —
 *    mirrors TelemetryGraphs.test.tsx).
 *  - `../../contexts/SettingsContext` for `distanceUnit`.
 *  - `./MapAnalysisContext` so `linkProfileMode`/`linkEndpoints` are driven
 *    directly by each test, without needing a real picker interaction.
 *  - `../../services/api`'s `getElevationProfile` — this is the "query fn"
 *    boundary the recompute-without-refetch test asserts against; the real
 *    `useElevationProfile` hook (WP-A) and a real `QueryClient` are used
 *    on top of it so budget-input edits are proven not to touch the network.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LinkProfileDrawer from './LinkProfileDrawer';
import { ApiError } from '../../services/api';
import type { AutoRadioDefaults } from '../../hooks/useAutoRadioDefaults';
import type { LinkEndpoint } from '../../utils/linkProfile';
import type { ElevationProfile } from '../../types/elevation';

vi.mock('recharts', () => ({
  ComposedChart: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="composed-chart">{children}</div>
  ),
  Area: () => null,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ReferenceDot: () => null,
  ReferenceLine: () => null,
}));

let mockDistanceUnit: 'km' | 'mi' = 'km';
vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({ distanceUnit: mockDistanceUnit }),
}));

let mockLinkProfileMode = true;
let mockLinkEndpoints: LinkEndpoint[] = [];
let setLinkProfileModeSpy: ReturnType<typeof vi.fn>;
let setLinkEndpointsSpy: ReturnType<typeof vi.fn>;
vi.mock('./MapAnalysisContext', () => ({
  useMapAnalysisCtx: () => ({
    linkProfileMode: mockLinkProfileMode,
    linkEndpoints: mockLinkEndpoints,
    setLinkProfileMode: setLinkProfileModeSpy,
    setLinkEndpoints: setLinkEndpointsSpy,
  }),
}));

const getElevationProfileMock = vi.fn();
vi.mock('../../services/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      getElevationProfile: (...args: unknown[]) => getElevationProfileMock(...args),
    },
  };
});

// Auto-frequency/RX-sensitivity suggestion (#4111 P3 WP-2). Defaults to
// all-null so the existing locked-value tests (which assume the documented
// 915 MHz / -129 dBm defaults) are unaffected; individual seeding tests
// override this per-test.
let mockAutoRadioDefaults: AutoRadioDefaults = { freqMhz: null, rxSensitivityDbm: null, provenance: null };
vi.mock('../../hooks/useAutoRadioDefaults', () => ({
  useAutoRadioDefaults: () => mockAutoRadioDefaults,
}));

const endpointA: LinkEndpoint = { id: 'node-a', lat: 0, lng: 0, isNode: true };
const endpointB: LinkEndpoint = { id: 'node-b', lat: 0.3, lng: 0, isNode: true };

// Obstructed fixture: 33.3km @ default 915MHz/2m-AGL — the total distance
// (33300m) matches the spec's locked FSPL/RX-power/margin reference values
// (122.117dB / -97.817dBm / +31.183dB) so the stats readout can assert exact
// rounded text. Flat 100m ground at both ends (antenna tops = 102m, so LOS is
// flat at 102m); a 90m mid-path sample plus the ~16.317m curvature bulge at
// the midpoint (d1=d2=16650m, k=4/3) raises effective terrain to ~106.3m,
// above the 102m LOS -> obstructed.
const OBSTRUCTED_PROFILE: ElevationProfile = {
  distanceMeters: 33300,
  provider: 'test',
  samples: [
    { distance: 0, lat: 0, lng: 0, elevation: 100 },
    { distance: 16650, lat: 0.15, lng: 0, elevation: 90 },
    { distance: 33300, lat: 0.3, lng: 0, elevation: 100 },
  ],
};

const ALL_NULL_PROFILE: ElevationProfile = {
  distanceMeters: 33300,
  provider: 'test',
  samples: [
    { distance: 0, lat: 0, lng: 0, elevation: null },
    { distance: 16650, lat: 0.15, lng: 0, elevation: null },
    { distance: 33300, lat: 0.3, lng: 0, elevation: null },
  ],
};

function renderDrawer() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <LinkProfileDrawer />
    </QueryClientProvider>
  );
  // Re-renders the same tree (same QueryClient) so tests can flip module-level
  // mock state (e.g. `mockLinkEndpoints`, `mockAutoRadioDefaults`) and observe
  // the drawer react to a picker change without unmounting.
  const rerenderDrawer = () =>
    utils.rerender(
      <QueryClientProvider client={queryClient}>
        <LinkProfileDrawer />
      </QueryClientProvider>
    );
  return { ...utils, rerenderDrawer };
}

describe('LinkProfileDrawer', () => {
  beforeEach(() => {
    mockDistanceUnit = 'km';
    mockLinkProfileMode = true;
    mockLinkEndpoints = [];
    setLinkProfileModeSpy = vi.fn();
    setLinkEndpointsSpy = vi.fn();
    getElevationProfileMock.mockReset();
    mockAutoRadioDefaults = { freqMhz: null, rxSensitivityDbm: null, provenance: null };
  });

  it('renders nothing when the tool is off and no endpoints were picked', () => {
    mockLinkProfileMode = false;
    mockLinkEndpoints = [];
    const { container } = renderDrawer();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a prompt while only one endpoint is picked', () => {
    mockLinkEndpoints = [endpointA];
    renderDrawer();
    expect(screen.getByText(/pick a second point/i)).toBeInTheDocument();
  });

  it('shows a loading state while the elevation profile is fetching', () => {
    mockLinkEndpoints = [endpointA, endpointB];
    getElevationProfileMock.mockReturnValue(new Promise(() => {})); // never resolves
    renderDrawer();
    expect(screen.getByText(/loading elevation profile/i)).toBeInTheDocument();
  });

  it('shows a "no terrain data" message for an all-null profile', async () => {
    mockLinkEndpoints = [endpointA, endpointB];
    getElevationProfileMock.mockResolvedValue(ALL_NULL_PROFILE);
    renderDrawer();
    expect(await screen.findByText(/no terrain data/i)).toBeInTheDocument();
  });

  it('renders verdict, FSPL, RX power, margin and distance for an obstructed link', async () => {
    mockLinkEndpoints = [endpointA, endpointB];
    getElevationProfileMock.mockResolvedValue(OBSTRUCTED_PROFILE);
    renderDrawer();

    expect(await screen.findByText(/Obstructed/)).toBeInTheDocument();
    expect(screen.getByText('122.1 dB')).toBeInTheDocument(); // FSPL
    expect(screen.getByText('-97.8 dBm')).toBeInTheDocument(); // RX power
    expect(screen.getByText('+31.2 dB')).toBeInTheDocument(); // margin (positive)
    expect(screen.getByText('33.3 km')).toBeInTheDocument(); // distance

    const marginDd = screen.getByText('+31.2 dB');
    expect(marginDd.className).toContain('link-margin-positive');
  });

  it('renders distance in miles when the user prefers miles', async () => {
    mockDistanceUnit = 'mi';
    mockLinkEndpoints = [endpointA, endpointB];
    getElevationProfileMock.mockResolvedValue(OBSTRUCTED_PROFILE);
    renderDrawer();
    expect(await screen.findByText('20.7 mi')).toBeInTheDocument();
  });

  it('recomputes the margin from a budget-input edit without an extra elevation fetch', async () => {
    mockLinkEndpoints = [endpointA, endpointB];
    getElevationProfileMock.mockResolvedValue(OBSTRUCTED_PROFILE);
    renderDrawer();

    await screen.findByText('+31.2 dB');
    const callsAfterLoad = getElevationProfileMock.mock.calls.length;
    expect(callsAfterLoad).toBeGreaterThan(0);

    const rxSensInput = screen.getByLabelText(/RX sensitivity/i);
    fireEvent.change(rxSensInput, { target: { value: '-140' } });

    // margin = rxPower(-97.817) - (-140) = +42.183 -> "+42.2 dB"
    await waitFor(() => expect(screen.getByText('+42.2 dB')).toBeInTheDocument());
    expect(getElevationProfileMock.mock.calls.length).toBe(callsAfterLoad);
  });

  it('colours a negative margin red', async () => {
    mockLinkEndpoints = [endpointA, endpointB];
    getElevationProfileMock.mockResolvedValue(OBSTRUCTED_PROFILE);
    renderDrawer();

    await screen.findByText('+31.2 dB');
    const rxSensInput = screen.getByLabelText(/RX sensitivity/i);
    // Raise RX sensitivity toward 0 (worse) until the margin goes negative.
    fireEvent.change(rxSensInput, { target: { value: '-50' } });

    const marginDd = await screen.findByText('-47.8 dB');
    expect(marginDd.className).toContain('link-margin-negative');
  });

  it('calls setLinkProfileMode(false) and clears endpoints when closed', async () => {
    mockLinkEndpoints = [endpointA, endpointB];
    getElevationProfileMock.mockResolvedValue(OBSTRUCTED_PROFILE);
    renderDrawer();
    await screen.findByText('+31.2 dB');

    fireEvent.click(screen.getByRole('button', { name: /close link profile/i }));
    expect(setLinkProfileModeSpy).toHaveBeenCalledWith(false);
    expect(setLinkEndpointsSpy).toHaveBeenCalledWith([]);
  });

  // #4111 Phase 3 WP-2: per-source auto-frequency/RX-sensitivity seeding,
  // manual-override-wins, re-seed on a new pair, and the provenance hint.
  describe('auto radio defaults (#4111 P3 WP-2)', () => {
    it('auto-seeds frequency and RX sensitivity with a provenance hint', async () => {
      mockAutoRadioDefaults = { freqMhz: 906.875, rxSensitivityDbm: -126.5, provenance: 'from Home Base (US)' };
      mockLinkEndpoints = [endpointA, endpointB];
      getElevationProfileMock.mockResolvedValue(OBSTRUCTED_PROFILE);
      renderDrawer();

      const freqInput = (await screen.findByLabelText(/Frequency \(MHz\)/i)) as HTMLInputElement;
      await waitFor(() => expect(freqInput.value).toBe('906.875'));
      const rxInput = screen.getByLabelText(/RX sensitivity/i) as HTMLInputElement;
      expect(rxInput.value).toBe('-126.5');
      expect(screen.getByText('from Home Base (US)')).toBeInTheDocument();
    });

    it('keeps 915 MHz / -129 dBm defaults when no auto suggestion is available', async () => {
      mockLinkEndpoints = [endpointA, endpointB];
      getElevationProfileMock.mockResolvedValue(OBSTRUCTED_PROFILE);
      renderDrawer();

      const freqInput = (await screen.findByLabelText(/Frequency \(MHz\)/i)) as HTMLInputElement;
      expect(freqInput.value).toBe('915');
      const rxInput = screen.getByLabelText(/RX sensitivity/i) as HTMLInputElement;
      expect(rxInput.value).toBe('-129');
      expect(screen.queryByText(/^from /)).not.toBeInTheDocument();
    });

    it('keeps a manually edited frequency and hides the provenance hint once edited', async () => {
      mockAutoRadioDefaults = { freqMhz: 906.875, rxSensitivityDbm: -126.5, provenance: 'from Home Base (US)' };
      mockLinkEndpoints = [endpointA, endpointB];
      getElevationProfileMock.mockResolvedValue(OBSTRUCTED_PROFILE);
      renderDrawer();

      const freqInput = (await screen.findByLabelText(/Frequency \(MHz\)/i)) as HTMLInputElement;
      await waitFor(() => expect(freqInput.value).toBe('906.875'));

      fireEvent.change(freqInput, { target: { value: '433' } });
      expect(freqInput.value).toBe('433');
      expect(screen.queryByText('from Home Base (US)')).not.toBeInTheDocument();

      // An unrelated budget-input edit re-renders the drawer — the manually
      // edited frequency must not be clobbered by the still-active auto value.
      fireEvent.change(screen.getByLabelText(/Antenna A height AGL/i), { target: { value: '3' } });
      expect(freqInput.value).toBe('433');
    });

    it('re-seeds frequency and provenance for a newly picked endpoint pair', async () => {
      mockAutoRadioDefaults = { freqMhz: 906.875, rxSensitivityDbm: -126.5, provenance: 'from Home Base (US)' };
      mockLinkEndpoints = [endpointA, endpointB];
      getElevationProfileMock.mockResolvedValue(OBSTRUCTED_PROFILE);
      const { rerenderDrawer } = renderDrawer();

      const freqInput = (await screen.findByLabelText(/Frequency \(MHz\)/i)) as HTMLInputElement;
      await waitFor(() => expect(freqInput.value).toBe('906.875'));
      fireEvent.change(freqInput, { target: { value: '433' } });
      expect(freqInput.value).toBe('433');

      // Pick a new pair (different endpoint B) with a different source's suggestion.
      const endpointC: LinkEndpoint = { id: 'node-c', lat: 0.6, lng: 0, isNode: true };
      mockLinkEndpoints = [endpointA, endpointC];
      mockAutoRadioDefaults = { freqMhz: 869.525, rxSensitivityDbm: -120, provenance: 'from Repeater Hill' };
      getElevationProfileMock.mockResolvedValue(OBSTRUCTED_PROFILE);
      rerenderDrawer();

      await waitFor(() => expect(freqInput.value).toBe('869.525'));
      expect(screen.getByText('from Repeater Hill')).toBeInTheDocument();
    });
  });

  // #4111 Phase 3 WP-2: friendly per-code copy for the elevation-profile
  // error branch (server codes from elevationService.ts's validation order).
  describe('friendly error messages (#4111 P3 WP-2)', () => {
    it('shows a friendly message for IDENTICAL_POINTS', async () => {
      mockLinkEndpoints = [endpointA, endpointB];
      getElevationProfileMock.mockRejectedValue(
        new ApiError('Identical points', 400, { code: 'IDENTICAL_POINTS' })
      );
      renderDrawer();
      expect(await screen.findByText('Pick two different points.')).toBeInTheDocument();
    });

    it('shows a friendly message for PATH_TOO_LONG', async () => {
      mockLinkEndpoints = [endpointA, endpointB];
      getElevationProfileMock.mockRejectedValue(
        new ApiError('Path too long', 400, { code: 'PATH_TOO_LONG' })
      );
      renderDrawer();
      expect(
        await screen.findByText('That link is too long to profile (max 500 km).')
      ).toBeInTheDocument();
    });

    it('shows a friendly message for INVALID_COORDINATES', async () => {
      mockLinkEndpoints = [endpointA, endpointB];
      getElevationProfileMock.mockRejectedValue(
        new ApiError('Bad coordinates', 400, { code: 'INVALID_COORDINATES' })
      );
      renderDrawer();
      expect(
        await screen.findByText('One of the points has invalid coordinates.')
      ).toBeInTheDocument();
    });

    it('falls back to the generic message for an unmapped error code', async () => {
      mockLinkEndpoints = [endpointA, endpointB];
      getElevationProfileMock.mockRejectedValue(new ApiError('Server exploded', 500, { code: 'SOME_OTHER_CODE' }));
      renderDrawer();
      expect(
        await screen.findByText('Failed to load the elevation profile. Please try again.')
      ).toBeInTheDocument();
    });

    it('falls back to the generic message for a non-ApiError (network) failure', async () => {
      mockLinkEndpoints = [endpointA, endpointB];
      getElevationProfileMock.mockRejectedValue(new Error('network down'));
      renderDrawer();
      expect(
        await screen.findByText('Failed to load the elevation profile. Please try again.')
      ).toBeInTheDocument();
    });
  });
});
