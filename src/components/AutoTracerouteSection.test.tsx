/**
 * @vitest-environment jsdom
 *
 * Regression tests for #2914: per-source `tracerouteIntervalMinutes` was being
 * shadowed by the global prop, so after a save + reload the checkbox snapped
 * back to "off" even while the per-source scheduler kept running.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import AutoTracerouteSection from './AutoTracerouteSection';
import { SourceProvider } from '../contexts/SourceContext';

const mockCsrfFetch = vi.fn();
vi.mock('../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => mockCsrfFetch,
}));

const mockShowToast = vi.fn();
vi.mock('./ToastContainer', () => ({
  useToast: () => ({ showToast: mockShowToast }),
  ToastContainer: () => null,
}));

const mockUseSaveBar = vi.fn();
vi.mock('../hooks/useSaveBar', () => ({
  useSaveBar: (opts: any) => mockUseSaveBar(opts),
}));

describe('AutoTracerouteSection — per-source interval reload (#2914)', () => {
  const defaultFilterResponse = {
    enabled: false,
    nodeNums: [],
    filterChannels: [],
    filterRoles: [],
    filterHwModels: [],
    filterNameRegex: '.*',
    filterNodesEnabled: true,
    filterChannelsEnabled: true,
    filterRolesEnabled: true,
    filterHwModelsEnabled: true,
    filterRegexEnabled: true,
    filterLastHeardEnabled: true,
    filterLastHeardHours: 168,
    filterHopsEnabled: false,
    filterHopsMin: 0,
    filterHopsMax: 10,
    expirationHours: 24,
    sortByHops: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockApi(opts: { tracerouteIntervalMinutes?: string | undefined }) {
    mockCsrfFetch.mockImplementation((url: string) => {
      if (url.includes('/api/settings/traceroute-nodes')) {
        return Promise.resolve({ ok: true, json: async () => defaultFilterResponse });
      }
      if (url.includes('/api/settings/traceroute-log')) {
        return Promise.resolve({ ok: true, json: async () => ({ log: [] }) });
      }
      if (url.includes('/api/settings')) {
        const body: Record<string, unknown> = {
          tracerouteScheduleEnabled: 'false',
          tracerouteScheduleStart: '00:00',
          tracerouteScheduleEnd: '00:00',
        };
        if (opts.tracerouteIntervalMinutes !== undefined) {
          body.tracerouteIntervalMinutes = opts.tracerouteIntervalMinutes;
        }
        return Promise.resolve({ ok: true, json: async () => body });
      }
      if (url.includes('/api/nodes')) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });
  }

  it('uses per-source tracerouteIntervalMinutes even when the prop is 0', async () => {
    // Server stored `15` per-source, but the global GET that powers the prop
    // returns nothing → parent passes 0. UI must still hydrate from per-source.
    mockApi({ tracerouteIntervalMinutes: '15' });

    const onIntervalChange = vi.fn();
    render(
      <SourceProvider sourceId="src-1" sourceName="Source 1">
        <AutoTracerouteSection
          intervalMinutes={0}
          baseUrl=""
          onIntervalChange={onIntervalChange}
        />
      </SourceProvider>
    );

    const intervalInput = await screen.findByDisplayValue('15');
    expect((intervalInput as HTMLInputElement).id).toBe('tracerouteInterval');

    // The master "enable" checkbox is the first checkbox in the section header.
    const checkboxes = screen.getAllByRole('checkbox');
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);

    // No spurious "unsaved changes" — baseline matches the per-source value.
    await waitFor(() => {
      expect(mockUseSaveBar).toHaveBeenCalled();
    });
    const lastCall = mockUseSaveBar.mock.calls[mockUseSaveBar.mock.calls.length - 1][0];
    expect(lastCall.hasChanges).toBe(false);
  });

  it('falls back to the prop when per-source value is missing', async () => {
    mockApi({ tracerouteIntervalMinutes: undefined });

    render(
      <SourceProvider sourceId="src-1" sourceName="Source 1">
        <AutoTracerouteSection
          intervalMinutes={20}
          baseUrl=""
          onIntervalChange={vi.fn()}
        />
      </SourceProvider>
    );

    const intervalInput = await screen.findByDisplayValue('20');
    expect((intervalInput as HTMLInputElement).id).toBe('tracerouteInterval');

    const checkboxes = screen.getAllByRole('checkbox');
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
  });
});
