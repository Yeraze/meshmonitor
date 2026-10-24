/**
 * @vitest-environment jsdom
 *
 * MeshCore Auto Ping section (#5953): shown only on a Companion source, loads
 * the per-source settings, shows the airtime warning, saves through the
 * SaveBar, and lists active sessions with direct / flood counts.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));
const showToast = vi.fn();
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast }) }));

const saveBar = vi.hoisted(() => ({ last: {} as Record<string, { hasChanges: boolean; onSave: () => Promise<void> }> }));
vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: (opts: { id: string; hasChanges: boolean; onSave: () => Promise<void> }) => {
    saveBar.last[opts.id] = opts;
  },
}));

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => fetchMock }));

import { MeshCoreAutoPingSection } from './MeshCoreAutoPingSection';
import { MeshCoreAutomationsView } from './MeshCoreAutomationsView';

const AUTO_PING_URL = '/api/sources/src-1/meshcore/automation/auto-ping';

const reply = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: async () => body });

function routeFetch(sessions: unknown[] = []) {
  fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    if (url === AUTO_PING_URL && (!init || !init.method)) {
      return reply({
        success: true,
        data: {
          settings: { autoPingEnabled: true, autoPingIntervalSeconds: 45, autoPingMaxPings: 12, autoPingTimeoutSeconds: 60 },
          sessions,
        },
      });
    }
    if (url === AUTO_PING_URL && init?.method === 'POST') {
      return reply({ success: true, data: { settings: JSON.parse(init.body ?? '{}') } });
    }
    return reply({}, 404);
  });
}

function renderView(isCompanionSource: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MeshCoreAutomationsView baseUrl="" sourceId="src-1" isCompanionSource={isCompanionSource} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  showToast.mockReset();
  saveBar.last = {};
  (window as unknown as { scrollTo: () => void }).scrollTo = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MeshCoreAutoPingSection', () => {
  it('renders on a Companion source, with its nav chip', async () => {
    routeFetch();
    const { container } = renderView(true);
    expect(container.querySelector('#meshcore-automation-auto-ping')).not.toBeNull();
    expect(container.querySelector('[data-section-id="meshcore-automation-auto-ping"]')).not.toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(AUTO_PING_URL));
  });

  it('does not render on a Repeater source', () => {
    routeFetch();
    const { container } = renderView(false);
    expect(container.querySelector('#meshcore-automation-auto-ping')).toBeNull();
    expect(container.querySelector('[data-section-id="meshcore-automation-auto-ping"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalledWith(AUTO_PING_URL);
  });

  it('loads the saved settings and shows the airtime warning', async () => {
    routeFetch();
    render(<MeshCoreAutoPingSection baseUrl="" sourceId="src-1" />);
    await waitFor(() => expect(screen.getByLabelText(/Ping Interval/)).toHaveValue(45));
    expect(screen.getByLabelText(/Max Pings Per Session/)).toHaveValue(12);
    expect(screen.getByRole('note')).toHaveTextContent(/flooded and every repeater in range/);
  });

  it('saves the settings through the SaveBar', async () => {
    routeFetch();
    render(<MeshCoreAutoPingSection baseUrl="" sourceId="src-1" />);
    await waitFor(() => expect(screen.getByLabelText(/Ping Interval/)).toHaveValue(45));

    // Turn it off: the section is dirty and its save posts the settings.
    act(() => { screen.getByRole('checkbox', { name: 'Auto Ping' }).click(); });
    await waitFor(() => expect(saveBar.last['meshcore-auto-ping'].hasChanges).toBe(true));
    await act(async () => { await saveBar.last['meshcore-auto-ping'].onSave(); });

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe(AUTO_PING_URL);
    expect(JSON.parse(post![1].body)).toEqual({
      autoPingEnabled: false, autoPingIntervalSeconds: 45, autoPingMaxPings: 12, autoPingTimeoutSeconds: 60,
    });
    expect(showToast).toHaveBeenCalledWith('Auto-ping settings saved', 'success');
    await waitFor(() => expect(saveBar.last['meshcore-auto-ping'].hasChanges).toBe(false));
  });

  it('lists active sessions with direct / flood counts', async () => {
    routeFetch([{
      requestedBy: 'cd'.repeat(32), requestedByName: 'Mobile', totalPings: 10, completedPings: 4,
      successfulPings: 3, failedPings: 1, directPings: 1, floodPings: 3, startTime: Date.now(),
    }]);
    render(<MeshCoreAutoPingSection baseUrl="" sourceId="src-1" />);
    await waitFor(() => expect(screen.getByText('Mobile')).toBeInTheDocument());
    expect(screen.getByText('4/10')).toBeInTheDocument();
    expect(screen.getByText('1 / 3')).toBeInTheDocument();
  });
});
