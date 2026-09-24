/**
 * @vitest-environment jsdom
 *
 * #5333: the "Clean outliers…" item in a telemetry chart's ⋯ menu renders
 * only for admins (the purge routes are admin-only) and opens the outlier
 * dialog scoped to that node, metric and source.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TelemetryGraphs from './TelemetryGraphs';
import { ToastProvider } from './ToastContainer';
import { CsrfProvider } from '../contexts/CsrfContext';
import { SettingsProvider } from '../contexts/SettingsContext';

const auth = vi.hoisted(() => ({ isAdmin: true }));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    hasPermission: () => true,
    authStatus: { authenticated: true, user: { isAdmin: auth.isAdmin } },
  }),
}));

vi.mock('../hooks/useResolvedSourceId', () => ({ useResolvedSourceId: () => 'src-test' }));

const dialogSpy = vi.hoisted(() => vi.fn());
vi.mock('./TelemetryOutlierDialog/TelemetryOutlierDialog', () => ({
  default: (props: Record<string, unknown>) => {
    dialogSpy(props);
    return props.isOpen ? <div data-testid="outlier-dialog" /> : null;
  },
}));

vi.mock('recharts', () => ({
  ComposedChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Line: () => null,
  Area: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

global.fetch = vi.fn();

const NODE_ID = '!testNode';

function renderGraphs() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <CsrfProvider>
        <SettingsProvider>
          <ToastProvider>
            <TelemetryGraphs nodeId={NODE_ID} />
          </ToastProvider>
        </SettingsProvider>
      </CsrfProvider>
    </QueryClientProvider>,
  );
}

describe('TelemetryGraphs — Clean outliers menu item (#5333)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (global.fetch as Mock).mockImplementation((url: string) => {
      if (url.includes('/api/settings')) return Promise.resolve({ ok: true, json: async () => ({}) });
      if (url.includes('/api/solar/estimates')) {
        return Promise.resolve({ ok: true, json: async () => ({ count: 0, estimates: [] }) });
      }
      if (url.includes('/api/csrf-token')) return Promise.resolve({ ok: true, json: async () => ({ token: 't' }) });
      return Promise.resolve({
        ok: true,
        json: async () => [
          { id: 1, nodeId: NODE_ID, telemetryType: 'voltage', timestamp: Date.now() - 3_600_000, value: 3.7 },
        ],
      });
    });
  });

  it('admins see the item, and it opens the dialog scoped to node + metric + source', async () => {
    auth.isAdmin = true;
    renderGraphs();
    await waitFor(() => expect(screen.getByText('telemetry.title')).toBeInTheDocument());

    fireEvent.click(screen.getAllByLabelText('telemetry.more_options')[0]);
    fireEvent.click(screen.getByText('telemetry_outliers.menu_item'));

    expect(await screen.findByTestId('outlier-dialog')).toBeInTheDocument();
    const props = dialogSpy.mock.calls.at(-1)![0];
    expect(props).toMatchObject({
      isOpen: true,
      sourceId: 'src-test',
      telemetryType: 'voltage',
      nodeId: NODE_ID,
    });
  });

  it('non-admins do not see the item (and the dialog is never mounted)', async () => {
    auth.isAdmin = false;
    renderGraphs();
    await waitFor(() => expect(screen.getByText('telemetry.title')).toBeInTheDocument());

    fireEvent.click(screen.getAllByLabelText('telemetry.more_options')[0]);
    expect(screen.getByText('telemetry.purge_data')).toBeInTheDocument();
    expect(screen.queryByText('telemetry_outliers.menu_item')).not.toBeInTheDocument();
    expect(dialogSpy).not.toHaveBeenCalled();
  });
});
