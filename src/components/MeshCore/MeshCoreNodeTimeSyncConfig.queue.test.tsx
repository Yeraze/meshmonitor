/**
 * @vitest-environment jsdom
 *
 * Queue states of Sync Now (#6493).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MeshCoreNodeTimeSyncConfig } from './MeshCoreNodeTimeSyncConfig';
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
const res = (status: number, body: unknown) => ({ ok: status < 300, status, headers: new Headers(), json: async () => body });
let posts: Array<{ settle: (r: unknown) => void }>;
const afterPost = () => act(async () => { await vi.advanceTimersByTimeAsync(1000); });
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

describe('MeshCoreNodeTimeSyncConfig queue states', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMeshTxQueueStoreForTests();
    posts = [];
    csrfFetchMock.mockReset().mockImplementation((url: string, opts?: { method?: string }) => {
      if (opts?.method === 'POST') return new Promise((resolve) => posts.push({ settle: resolve }));
      if (url.includes('/tx-queue/')) return Promise.resolve(res(200, { success: true, data: { position: 1, depth: 1, startsInSecs: 20 } }));
      return Promise.resolve(res(200, { success: true, data: { enabled: false, intervalMinutes: 720, lastSyncAt: null, hasSavedCredential: true } }));
    });
  });
  afterEach(() => {
    resetMeshTxQueueStoreForTests();
    vi.useRealTimers();
  });

  it('queues, disables the button, then reports success when the POST answers', async () => {
    render(<MeshCoreNodeTimeSyncConfig baseUrl="" sourceId="s1" publicKey={PK} />);
    await flush();
    fireEvent.click(screen.getByText('Sync Clock'));
    await afterPost();
    expect(screen.getByText(/Queued — sending in 20 s/)).toBeInTheDocument();
    expect(screen.getByText('Syncing…').closest('button')).toBeDisabled();
    await act(async () => {
      posts[0].settle(res(200, { success: true, data: { syncedAt: 1700000000000, waitedSecs: 20 } }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('Clock pushed to repeater.')).toBeInTheDocument();
    expect(screen.getByText('Sync Clock').closest('button')).not.toBeDisabled();
  });

  it('a string retryAfter 429 shows a plain error with no countdown', async () => {
    render(<MeshCoreNodeTimeSyncConfig baseUrl="" sourceId="s1" publicKey={PK} />);
    await flush();
    fireEvent.click(screen.getByText('Sync Clock'));
    await flush();
    await act(async () => {
      posts[0].settle(res(429, { success: false, error: 'Too many requests', retryAfter: '1 minute' }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Too many requests');
    expect(screen.queryByText(/Try again in/)).toBeNull();
  });
});
