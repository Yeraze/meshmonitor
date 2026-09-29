/**
 * @vitest-environment jsdom
 *
 * MeshCoreContactDetailPanel — paged Neighbours fetch (#5413). The button
 * reads the whole table page by page (one per 60 s), so the panel must show
 * live progress, the neighbours gathered so far, and a working Cancel rather
 * than a frozen "Loading…".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MeshCoreContactDetailPanel } from './MeshCoreContactDetailPanel';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';
import type { MeshCoreNeighboursFetchActions, MeshCoreNeighboursFetchSnapshot } from './hooks/meshcoreNeighboursFetchApi';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));

vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'test-source', sourceName: 'Test' }),
}));

vi.mock('../../services/api', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ success: true, data: { items: [] } }),
    setBaseUrl: vi.fn(),
  },
}));

const PK = 'a'.repeat(64);
const repeater: MeshCoreContact = { publicKey: PK, advName: 'Hilltop RPT', advType: 2, lastSeen: Date.now() };

const neighbours = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    publicKeyPrefix: `pfx${String(i).padStart(5, '0')}`,
    heardSecondsAgo: 30,
    snr: 5,
    name: `Node ${i}`,
    fullPublicKey: null,
  }));

const snap = (over: Partial<MeshCoreNeighboursFetchSnapshot>): MeshCoreNeighboursFetchSnapshot => ({
  requestId: 'r', publicKey: PK, phase: 'waiting', page: 2, plannedPages: 4, maxPages: 5, total: 37,
  pagesFetched: 1, neighbours: neighbours(10), waitMs: 60_000, waitRemainingMs: 42_000, cancelRequested: false,
  outcome: null, stored: null, written: null, error: null, ...over,
});

function renderPanel(actions: MeshCoreNeighboursFetchActions) {
  return render(
    <MemoryRouter>
      <MeshCoreContactDetailPanel
        contact={repeater}
        publicKey={PK}
        onGetNeighbours={vi.fn()}
        neighboursFetchActions={actions}
      />
    </MemoryRouter>,
  );
}

describe('MeshCoreContactDetailPanel paged neighbours (#5413)', () => {
  let progress: MeshCoreNeighboursFetchSnapshot;
  let actions: {
    startNeighboursFetch: ReturnType<typeof vi.fn>;
    getNeighboursFetchProgress: ReturnType<typeof vi.fn>;
    cancelNeighboursFetch: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    progress = snap({});
    actions = {
      startNeighboursFetch: vi.fn(async (_pk: string, requestId: string) => ({ ok: true as const, requestId })),
      getNeighboursFetchProgress: vi.fn(async () => progress),
      cancelNeighboursFetch: vi.fn(async () => true),
    };
  });

  it('shows page, count, countdown and the neighbours gathered so far', async () => {
    renderPanel(actions);
    fireEvent.click(screen.getByRole('button', { name: 'Neighbours' }));

    const status = await screen.findByTestId('meshcore-neighbours-fetch-progress');
    await waitFor(() => expect(status.textContent).toMatch(/Page 2 of 4 · 10 of 37 neighbours · next page in 4\d s/));
    expect(actions.startNeighboursFetch).toHaveBeenCalledWith(PK, expect.any(String));
    expect(screen.getByText(/\(10 of 37 total\)/)).toBeInTheDocument();
    expect(screen.getByText('Node 0')).toBeInTheDocument();
    expect(screen.getByText('Node 9')).toBeInTheDocument();
    // The Neighbours button is locked while the fetch runs; Cancel is not.
    expect(screen.getByRole('button', { name: 'Neighbours' })).toBeDisabled();
    expect(within(status).getByRole('button', { name: 'Cancel' })).not.toBeDisabled();
  });

  it('Cancel stops further pages and keeps the partial list on screen', async () => {
    renderPanel(actions);
    fireEvent.click(screen.getByRole('button', { name: 'Neighbours' }));
    const status = await screen.findByTestId('meshcore-neighbours-fetch-progress');
    await waitFor(() => expect(status.textContent).toMatch(/Page 2 of 4/));

    fireEvent.click(within(status).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(actions.cancelNeighboursFetch).toHaveBeenCalledWith(PK, expect.any(String)));

    progress = snap({
      phase: 'done', outcome: 'cancelled', stored: 'merged', written: 10, waitMs: null, waitRemainingMs: null, cancelRequested: true,
    });
    const notice = await screen.findByTestId('meshcore-neighbours-fetch-notice', {}, { timeout: 3000 });
    expect(notice.textContent).toMatch(/Cancelled: showing 10 of 37 neighbours/);
    expect(screen.getByText('Node 9')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Neighbours' })).not.toBeDisabled();
  });

  it('a complete fetch shows the full table with no note', async () => {
    progress = snap({ phase: 'done', outcome: 'complete', page: 4, pagesFetched: 4, neighbours: neighbours(37), stored: 'replaced', written: 37, waitMs: null, waitRemainingMs: null });
    renderPanel(actions);
    fireEvent.click(screen.getByRole('button', { name: 'Neighbours' }));
    await screen.findByText('Node 36');
    expect(screen.getByText(/\(37 total\)/)).toBeInTheDocument();
    expect(screen.queryByTestId('meshcore-neighbours-fetch-notice')).toBeNull();
    expect(screen.queryByTestId('meshcore-neighbours-fetch-progress')).toBeNull();
  });

  it('re-attaches to the caller\'s own fetch already running on this node', async () => {
    actions.startNeighboursFetch.mockResolvedValue({
      ok: false, status: 409, code: 'NEIGHBOURS_FETCH_IN_PROGRESS', error: 'busy',
      activeRequestId: 'existing-id', activePublicKey: PK,
    });
    renderPanel(actions);
    fireEvent.click(screen.getByRole('button', { name: 'Neighbours' }));
    await waitFor(() => expect(actions.getNeighboursFetchProgress).toHaveBeenCalledWith(PK, 'existing-id'));
    await screen.findByTestId('meshcore-neighbours-fetch-progress');
  });

  it('shows why a start was refused (another fetch on this source)', async () => {
    actions.startNeighboursFetch.mockResolvedValue({
      ok: false, status: 409, code: 'NEIGHBOURS_FETCH_IN_PROGRESS', error: 'A neighbours fetch is already running on this source',
      activeRequestId: null, activePublicKey: 'c'.repeat(64),
    });
    renderPanel(actions);
    fireEvent.click(screen.getByRole('button', { name: 'Neighbours' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A neighbours fetch is already running on this source');
    expect(actions.getNeighboursFetchProgress).not.toHaveBeenCalled();
  });
});
