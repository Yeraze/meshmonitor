/**
 * @vitest-environment jsdom
 *
 * Save behaviour shared by the three per-node MeshCore schedule panels
 * (telemetry, neighbours, time sync), refs #5797:
 *
 *  - a failed PATCH puts the checkbox / interval back to the value the server
 *    still holds, and shows the panel's existing error text;
 *  - a reply that lands after the user has moved to another node is dropped,
 *    so node A's config never paints onto node B;
 *  - each toggle sends exactly one PATCH, and nothing else writes.
 *
 * These PATCHes change RF poll schedules, so the write count is asserted.
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MeshCoreNodeTelemetryConfig } from './MeshCoreNodeTelemetryConfig';
import { MeshCoreNodeNeighboursConfig } from './MeshCoreNodeNeighboursConfig';
import { MeshCoreNodeTimeSyncConfig } from './MeshCoreNodeTimeSyncConfig';

const { csrfFetchMock, hasPermissionMock, showToastMock, t } = vi.hoisted(() => ({
  csrfFetchMock: vi.fn(),
  hasPermissionMock: vi.fn(),
  showToastMock: vi.fn(),
  // One identity across renders, like the real `t` (the load effect lists it).
  t: (_key: string, fallback?: string | Record<string, unknown>) =>
    typeof fallback === 'string' ? fallback : _key,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t }),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: hasPermissionMock }),
}));

vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));

vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);

type PanelProps = { baseUrl: string; sourceId: string; publicKey: string };

interface PanelCase {
  name: string;
  Panel: React.FC<PanelProps>;
  configPath: string;
  /** Interval node A loads with. */
  baseInterval: number;
  /** A legal interval to type in. */
  newInterval: number;
  saveError: string;
}

const PANELS: PanelCase[] = [
  {
    name: 'telemetry',
    Panel: MeshCoreNodeTelemetryConfig,
    configPath: 'telemetry-config',
    baseInterval: 60,
    newInterval: 120,
    saveError: 'Failed to save',
  },
  {
    name: 'neighbours',
    Panel: MeshCoreNodeNeighboursConfig,
    configPath: 'neighbours-config',
    baseInterval: 60,
    newInterval: 120,
    saveError: 'Failed to save',
  },
  {
    name: 'time sync',
    Panel: MeshCoreNodeTimeSyncConfig,
    configPath: 'time-sync-config',
    baseInterval: 720,
    newInterval: 1440,
    saveError: 'Failed to save',
  },
];

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Per-node config the GET returns. B differs from A in every field. */
function configFor(url: string, c: PanelCase) {
  if (url.includes(PK_B)) {
    return { enabled: false, intervalMinutes: 90, lastRequestAt: null, lastSyncAt: null, hasSavedCredential: true };
  }
  return {
    enabled: false,
    intervalMinutes: c.baseInterval,
    lastRequestAt: null,
    lastSyncAt: null,
    hasSavedCredential: true,
  };
}

const patchCalls = () =>
  csrfFetchMock.mock.calls.filter(([, opts]) => (opts as { method?: string } | undefined)?.method === 'PATCH');

describe.each(PANELS)('MeshCore per-node $name panel — save rollback and stale replies (#5797)', (c) => {
  const { Panel } = c;
  let patchImpl: (url: string, body: Record<string, unknown>) => Promise<unknown>;

  beforeEach(() => {
    hasPermissionMock.mockReset().mockReturnValue(true);
    showToastMock.mockReset();
    patchImpl = async () => okResponse({ success: false, error: 'boom' });
    csrfFetchMock.mockReset().mockImplementation((url: string, opts?: { method?: string; body?: string }) => {
      if (opts?.method === 'PATCH') return patchImpl(url, JSON.parse(opts.body ?? '{}'));
      if (url.includes(c.configPath)) {
        return Promise.resolve(okResponse({ success: true, data: configFor(url, c) }));
      }
      return Promise.resolve(okResponse({ success: true, data: null }));
    });
  });

  const renderFor = (publicKey: string) => <Panel baseUrl="" sourceId="src-1" publicKey={publicKey} />;

  it('puts the checkbox back when the PATCH reports failure, and sends one PATCH', async () => {
    render(renderFor(PK_A));
    const box = (await screen.findByRole('checkbox')) as HTMLInputElement;
    expect(box.checked).toBe(false);

    fireEvent.click(box);

    expect(await screen.findByText('boom')).toBeInTheDocument();
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false));
    expect(patchCalls()).toHaveLength(1);
    expect(JSON.parse((patchCalls()[0][1] as { body: string }).body)).toEqual({ enabled: true });
  });

  it('puts the checkbox back when the PATCH throws', async () => {
    patchImpl = async () => {
      throw new Error('network down');
    };
    render(renderFor(PK_A));
    fireEvent.click(await screen.findByRole('checkbox'));

    expect(await screen.findByText(c.saveError)).toBeInTheDocument();
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false));
    expect(patchCalls()).toHaveLength(1);
  });

  it('keeps the new checkbox state when the PATCH succeeds', async () => {
    patchImpl = async (_url, body) =>
      okResponse({ success: true, data: { ...configFor('', c), ...body } });
    render(renderFor(PK_A));
    fireEvent.click(await screen.findByRole('checkbox'));

    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect(patchCalls()).toHaveLength(1);
  });

  it('puts the interval back when the PATCH fails, and sends one PATCH on blur', async () => {
    render(renderFor(PK_A));
    const input = (await screen.findByDisplayValue(String(c.baseInterval))) as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: String(c.newInterval) } });
    // Typing alone does not write.
    expect(patchCalls()).toHaveLength(0);
    fireEvent.blur(input);

    expect(await screen.findByText('boom')).toBeInTheDocument();
    await waitFor(() => expect(input.value).toBe(String(c.baseInterval)));
    expect(patchCalls()).toHaveLength(1);
    expect(JSON.parse((patchCalls()[0][1] as { body: string }).body)).toEqual({ intervalMinutes: c.newInterval });
  });

  it("does not paint node A's save reply onto node B", async () => {
    const pending = deferred<unknown>();
    patchImpl = () => pending.promise;
    const { rerender } = render(renderFor(PK_A));
    fireEvent.click(await screen.findByRole('checkbox'));
    expect(patchCalls()).toHaveLength(1);

    rerender(renderFor(PK_B));
    await waitFor(() => expect(screen.getByDisplayValue('90')).toBeInTheDocument());
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);

    // A's save lands late, with A's new config.
    await act(async () => {
      pending.resolve(okResponse({ success: true, data: { ...configFor('', c), enabled: true, intervalMinutes: 300 } }));
      await pending.promise;
    });

    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByDisplayValue('90')).toBeInTheDocument();
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument();
    expect(patchCalls()).toHaveLength(1);
  });

  it("does not roll node B back when node A's save fails late", async () => {
    const pending = deferred<unknown>();
    patchImpl = () => pending.promise;
    csrfFetchMock.mockImplementation((url: string, opts?: { method?: string; body?: string }) => {
      if (opts?.method === 'PATCH') return patchImpl(url, JSON.parse(opts.body ?? '{}'));
      if (url.includes(c.configPath)) {
        // B is already enabled on the server.
        const data = url.includes(PK_B) ? { ...configFor(url, c), enabled: true } : configFor(url, c);
        return Promise.resolve(okResponse({ success: true, data }));
      }
      return Promise.resolve(okResponse({ success: true, data: null }));
    });
    const { rerender } = render(renderFor(PK_A));
    fireEvent.click(await screen.findByRole('checkbox'));

    rerender(renderFor(PK_B));
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true));

    await act(async () => {
      pending.resolve(okResponse({ success: false, error: 'boom' }));
      await pending.promise;
    });

    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText('boom')).not.toBeInTheDocument();
  });

  it("does not paint node A's late config GET onto node B", async () => {
    const slowA = deferred<unknown>();
    csrfFetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (opts?.method === 'PATCH') return patchImpl(url, {});
      if (url.includes(c.configPath)) {
        if (url.includes(PK_A)) return slowA.promise;
        return Promise.resolve(okResponse({ success: true, data: configFor(url, c) }));
      }
      return Promise.resolve(okResponse({ success: true, data: null }));
    });
    const { rerender } = render(renderFor(PK_A));
    rerender(renderFor(PK_B));
    await waitFor(() => expect(screen.getByDisplayValue('90')).toBeInTheDocument());

    await act(async () => {
      slowA.resolve(okResponse({ success: true, data: { ...configFor('', c), enabled: true, intervalMinutes: 300 } }));
      await slowA.promise;
    });

    expect(screen.getByDisplayValue('90')).toBeInTheDocument();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect(patchCalls()).toHaveLength(0);
  });
});
