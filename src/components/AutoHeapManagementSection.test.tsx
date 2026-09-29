/**
 * @vitest-environment jsdom
 *
 * The heap readout must come from the session-authed internal telemetry route.
 * It used to call /api/v1/telemetry, the bearer-token API, which answers a
 * browser session with 401: the readout never showed and the Automation page
 * logged a failed request on every visit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SourceProvider } from '../contexts/SourceContext';

const csrfFetch = vi.fn();

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => csrfFetch }));
vi.mock('../hooks/useSaveBar', () => ({ useSaveBar: () => undefined }));
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../contexts/DataContext', () => ({ useData: () => ({ currentNodeId: '!d8ee7714' }) }));

import AutoHeapManagementSection from './AutoHeapManagementSection';

const json = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });

function telemetryCalls(): string[] {
  return csrfFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('telemetry'));
}

describe('AutoHeapManagementSection heap readout', () => {
  beforeEach(() => {
    csrfFetch.mockReset();
    csrfFetch.mockImplementation((url: string) => {
      if (url.includes('/api/settings')) return json({});
      if (url.includes('/api/telemetry/')) {
        return json([
          { telemetryType: 'heapFreeBytes', timestamp: 1000, value: 50_000 },
          { telemetryType: 'heapFreeBytes', timestamp: 3000, value: 42_000 },
          { telemetryType: 'heapTotalBytes', timestamp: 4000, value: 200_000 },
          { telemetryType: 'heapFreeBytes', timestamp: 2000, value: 60_000 },
        ]);
      }
      return json({}, 404);
    });
  });

  it('never calls the token-only /api/v1 API', async () => {
    render(
      <SourceProvider sourceId="src-1">
        <AutoHeapManagementSection baseUrl="/meshmonitor" />
      </SourceProvider>,
    );
    await waitFor(() => expect(telemetryCalls()).toHaveLength(1));
    expect(csrfFetch.mock.calls.some((c) => String(c[0]).includes('/api/v1/'))).toBe(false);
  });

  it('reads the internal per-source route and shows the newest heapFreeBytes', async () => {
    render(
      <SourceProvider sourceId="src-1">
        <AutoHeapManagementSection baseUrl="/meshmonitor" />
      </SourceProvider>,
    );

    expect(await screen.findByText('Current heap: 42 KB free')).toBeTruthy();
    const [url] = telemetryCalls();
    expect(url.startsWith('/meshmonitor/api/telemetry/!d8ee7714?')).toBe(true);
    expect(url).toContain('sourceId=src-1');
  });

  it('skips the request when there is no source to scope it to', async () => {
    render(<AutoHeapManagementSection baseUrl="/meshmonitor" />);
    await waitFor(() =>
      expect(csrfFetch.mock.calls.some((c) => String(c[0]).includes('/api/settings'))).toBe(true),
    );
    expect(telemetryCalls()).toHaveLength(0);
  });
});
