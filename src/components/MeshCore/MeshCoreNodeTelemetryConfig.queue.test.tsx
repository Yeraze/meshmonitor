/**
 * @vitest-environment jsdom
 *
 * Queue states of the manual poll buttons (#6493): queued countdown,
 * replace-the-queued-one, numeric 429 cooldown, remount.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MeshCoreNodeTelemetryConfig } from './MeshCoreNodeTelemetryConfig';
import { resetMeshTxQueueStoreForTests } from './hooks/meshTxQueueStore';

const { csrfFetchMock } = vi.hoisted(() => ({ csrfFetchMock: vi.fn() }));

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => csrfFetchMock }));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

const PK = 'a'.repeat(64);
const res = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  ok: status < 300,
  status,
  headers: new Headers(headers),
  json: async () => body,
});

let posts: Array<{ body: Record<string, unknown>; settle: (r: unknown) => void }>;
let queueGet: () => unknown;

const afterPost = () => act(async () => { await vi.advanceTimersByTimeAsync(1000); });
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const renderPanel = () => render(<MeshCoreNodeTelemetryConfig baseUrl="" sourceId="s1" publicKey={PK} nodeLabel="Hilltop" />);

describe('MeshCoreNodeTelemetryConfig queue states', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMeshTxQueueStoreForTests();
    posts = [];
    queueGet = () => res(200, { success: true, data: { position: 2, depth: 2, startsInSecs: 45 } });
    csrfFetchMock.mockReset().mockImplementation((url: string, opts?: { method?: string; body?: string }) => {
      if (opts?.method === 'POST') {
        return new Promise((resolve) => posts.push({ body: JSON.parse(opts.body ?? '{}'), settle: resolve }));
      }
      if (url.includes('/tx-queue/')) return Promise.resolve(queueGet());
      return Promise.resolve(res(200, { success: true, data: { enabled: false, intervalMinutes: 60, lastRequestAt: null } }));
    });
  });
  afterEach(() => {
    resetMeshTxQueueStoreForTests();
    vi.useRealTimers();
  });

  it('shows the queued countdown, disables only the queued button, and counts down', async () => {
    renderPanel();
    await flush();
    fireEvent.click(screen.getByText('Poll Status'));
    await afterPost();
    expect(screen.getByText(/Queued — sending in 45 s · 1 ahead/)).toBeInTheDocument();
    expect(screen.getByText('Polling…').closest('button')).toBeDisabled();
    expect(screen.getByText('Poll Environment (LPP)').closest('button')).not.toBeDisabled();
    await advance(1000);
    expect(screen.getByText(/Queued — sending in 44 s/)).toBeInTheDocument();
  });

  it('queueing the other poll replaces the first: old shows Replaced, new shows Replaces', async () => {
    renderPanel();
    await flush();
    fireEvent.click(screen.getByText('Poll Status'));
    await afterPost();
    fireEvent.click(screen.getByText('Poll Environment (LPP)'));
    await afterPost();
    expect(screen.getByText(/Replaces your queued Poll Status for Hilltop/)).toBeInTheDocument();
    await act(async () => {
      posts[0].settle(
        res(409, { success: false, code: 'MESH_TX_SUPERSEDED', error: 'Replaced by your newer request', supersededBy: { action: 'telemetry', publicKey: PK } }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(/Replaced by your newer request \(Poll Environment \(LPP\)\)/)).toBeInTheDocument();
    await advance(8100);
    expect(screen.queryByText(/Replaced by your newer request/)).toBeNull();
  });

  it('a numeric 429 counts down and re-enables the button without resending', async () => {
    queueGet = () => res(404, { success: false, code: 'MESH_TX_REQUEST_NOT_FOUND' });
    renderPanel();
    await flush();
    fireEvent.click(screen.getByText('Poll Status'));
    await afterPost();
    await act(async () => {
      posts[0].settle(res(429, { success: false, code: 'MESH_TX_QUEUE_TIMEOUT', retryAfterSecs: 3, retryAfterSeconds: 3 }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(/Try again in 3 s/)).toBeInTheDocument();
    expect(screen.getByText('Polling…').closest('button')).toBeDisabled();
    await advance(3100);
    expect(screen.getByText('Poll Status').closest('button')).not.toBeDisabled();
    expect(posts.length).toBe(1);
  });

  it('keeps the queued state across unmount and remount', async () => {
    const first = renderPanel();
    await flush();
    fireEvent.click(screen.getByText('Poll Status'));
    await afterPost();
    first.unmount();
    renderPanel();
    await flush();
    expect(screen.getByText(/Queued — sending in/)).toBeInTheDocument();
    expect(screen.getByText('Polling…').closest('button')).toBeDisabled();
  });
});
