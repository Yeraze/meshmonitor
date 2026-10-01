/**
 * MeshCoreContactSyncSection (#5502): auto-add state + toggle, the
 * missing-favourites banner, and "Push to radio" with its result summary.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MeshCoreContactSyncSection } from './MeshCoreContactSyncSection';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const h = vi.hoisted(() => ({ csrfFetch: vi.fn() }));
vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => h.csrfFetch }));

const json = (body: unknown) => ({ headers: { get: () => 'application/json' }, json: async () => body });

const PREFIX = '/mm/api/sources/src-1/meshcore';

function syncStatus(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    manualAddContacts: 1,
    autoAddEnabled: false,
    missingFavorites: [
      { publicKey: 'aa'.repeat(32), name: 'Rpt A' },
      { publicKey: 'bb'.repeat(32), name: 'Rpt B' },
    ],
    deviceContactCount: 4,
    deviceContactsKnown: true,
    ...overrides,
  };
}

/** Route csrfFetch by URL; `status` can change between calls. */
function mockServer(opts: { status: () => Record<string, unknown>; push?: unknown; autoAdd?: unknown }) {
  h.csrfFetch.mockImplementation(async (url: string) => {
    if (url === `${PREFIX}/contacts/device-sync`) return json({ success: true, data: opts.status() });
    if (url === `${PREFIX}/contacts/push-to-device`) return json(opts.push);
    if (url === `${PREFIX}/config/auto-add-contacts`) return json(opts.autoAdd);
    throw new Error(`unexpected ${url}`);
  });
}

function renderSection(props: Partial<React.ComponentProps<typeof MeshCoreContactSyncSection>> = {}) {
  return render(
    <MeshCoreContactSyncSection
      baseUrl="/mm"
      sourceId="src-1"
      connected
      canEditConfig
      canEditNodes
      {...props}
    />,
  );
}

describe('MeshCoreContactSyncSection (#5502)', () => {
  beforeEach(() => {
    h.csrfFetch.mockReset();
  });

  it('shows auto-add Off and the missing-favourites banner with the auto-add explanation', async () => {
    mockServer({ status: () => syncStatus() });
    renderSection();
    await waitFor(() => expect(screen.getByTestId('meshcore-auto-add-state').textContent).toBe('Off'));
    const banner = screen.getByTestId('meshcore-missing-favorites');
    expect(banner.textContent).toContain("2 favourite(s) are not in the radio's contact list");
    expect(banner.textContent).toContain('Auto-add contacts is off on this radio');
  });

  it('omits the auto-add explanation when auto-add is on', async () => {
    mockServer({ status: () => syncStatus({ autoAddEnabled: true, manualAddContacts: 0 }) });
    renderSection();
    await waitFor(() => expect(screen.getByTestId('meshcore-missing-favorites')).toBeTruthy());
    expect(screen.getByTestId('meshcore-auto-add-state').textContent).toBe('On');
    expect(screen.getByTestId('meshcore-missing-favorites').textContent).not.toContain('Auto-add contacts is off');
  });

  it('says the radio list is not read yet instead of a missing count', async () => {
    mockServer({ status: () => syncStatus({ deviceContactsKnown: false, missingFavorites: [] }) });
    renderSection();
    expect(await screen.findByTestId('meshcore-device-contacts-unknown')).toBeInTheDocument();
    expect(screen.queryByTestId('meshcore-missing-favorites')).not.toBeInTheDocument();
  });

  it('hides the banner when no favourite is missing', async () => {
    mockServer({ status: () => syncStatus({ missingFavorites: [] }) });
    renderSection();
    await waitFor(() => expect(screen.getByTestId('meshcore-auto-add-state').textContent).toBe('Off'));
    expect(screen.queryByTestId('meshcore-missing-favorites')).toBeNull();
  });

  it('toggles auto-add on and re-reads the status', async () => {
    let current = syncStatus();
    mockServer({
      status: () => current,
      autoAdd: { success: true, data: { autoAddEnabled: true, manualAddContacts: 0 } },
    });
    renderSection();
    const button = await screen.findByRole('button', { name: 'Turn on' });
    current = syncStatus({ autoAddEnabled: true, manualAddContacts: 0 });
    await userEvent.click(button);
    const call = h.csrfFetch.mock.calls.find(([url]) => url === `${PREFIX}/config/auto-add-contacts`);
    expect(call?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ enabled: true }) });
    await waitFor(() => expect(screen.getByTestId('meshcore-auto-add-state').textContent).toBe('On'));
  });

  it('shows the server error when the toggle fails', async () => {
    mockServer({ status: () => syncStatus(), autoAdd: { success: false, error: 'Device said no' } });
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Device said no');
  });

  it('hides the toggle without configuration:write and the push without nodes:write', async () => {
    mockServer({ status: () => syncStatus() });
    renderSection({ canEditConfig: false, canEditNodes: false });
    await waitFor(() => expect(screen.getByTestId('meshcore-auto-add-state').textContent).toBe('Off'));
    expect(screen.queryByRole('button', { name: 'Turn on' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Push to radio/ })).toBeNull();
  });

  it('pushes to the radio and summarises the result', async () => {
    mockServer({
      status: () => syncStatus(),
      push: {
        success: true,
        data: {
          added: [{ publicKey: 'aa'.repeat(32), name: 'Rpt A' }],
          alreadyOnDevice: 4,
          skipped: [
            { publicKey: 'cc'.repeat(32), name: null, reason: 'unknown_type' },
            { publicKey: 'dd'.repeat(32), name: null, reason: 'ignored' },
          ],
          notAddedNoRoom: 3,
          evicted: [],
          capacityKnown: true,
          maxContacts: 100,
          freeSlotsBefore: 1,
          freeSlotsAfter: 0,
        },
      },
    });
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: /Push to radio/ }));
    const result = await screen.findByTestId('meshcore-push-result');
    expect(result.textContent).toContain('Added: 1');
    expect(result.textContent).toContain('Already on the radio: 4');
    expect(result.textContent).toContain('Not added, no free slot: 3');
    expect(result.textContent).toContain('Skipped, type not known yet: 1');
    expect(result.textContent).toContain('Skipped, ignored or blocked: 1');
    expect(result.textContent).toContain('Free slots: 1 before, 0 after (of 100)');
    // Full afterwards with nodes left out: point at the per-node Add to radio.
    expect(screen.getByTestId('meshcore-push-full-hint').textContent).toContain('Add to radio');
  });

  it('says when the capacity could not be read', async () => {
    mockServer({
      status: () => syncStatus(),
      push: {
        success: true,
        data: {
          added: [], alreadyOnDevice: 0, skipped: [], notAddedNoRoom: 2, evicted: [],
          capacityKnown: false, maxContacts: null, freeSlotsBefore: null, freeSlotsAfter: null,
        },
      },
    });
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: /Push to radio/ }));
    expect((await screen.findByTestId('meshcore-push-result')).textContent).toContain('only favourites were pushed');
  });

  it('shows the error when the push fails', async () => {
    mockServer({ status: () => syncStatus(), push: { success: false, code: 'PUSH_IN_PROGRESS', error: 'A push to the radio is already running' } });
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: /Push to radio/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('A push to the radio is already running');
  });

  it('does not load while disconnected and disables the buttons', async () => {
    mockServer({ status: () => syncStatus() });
    renderSection({ connected: false });
    expect(h.csrfFetch).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: /Push to radio/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
