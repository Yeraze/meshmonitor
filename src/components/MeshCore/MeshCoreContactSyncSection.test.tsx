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
function mockServer(opts: {
  status: () => Record<string, unknown>;
  push?: unknown;
  autoAdd?: unknown;
  config?: () => Record<string, unknown>;
  configPost?: unknown;
  remove?: unknown;
}) {
  h.csrfFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url === `${PREFIX}/contacts/device-sync`) return json({ success: true, data: opts.status() });
    if (url === `${PREFIX}/contacts/push-to-device`) return json(opts.push);
    if (url === `${PREFIX}/config/auto-add-contacts`) return json(opts.autoAdd);
    if (url === `${PREFIX}/config/autoadd-config`) {
      if (init?.method === 'POST') return json(opts.configPost ?? { success: true, data: {} });
      if (opts.config) return json({ success: true, data: opts.config() });
      return json({ success: false, error: 'nope' });
    }
    if (url === `${PREFIX}/contacts/remove-non-favorites`) return json(opts.remove);
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

function autoAddConfig(overrides: Record<string, unknown> = {}) {
  return {
    supported: true,
    overwriteOldest: false,
    types: { chat: true, repeater: false, room: false, sensor: false },
    maxHops: 0,
    ...overrides,
  };
}

const configPosts = () =>
  h.csrfFetch.mock.calls
    .filter(([url, init]) => url === `${PREFIX}/config/autoadd-config` && init?.method === 'POST')
    .map(([, init]) => JSON.parse(init.body));

describe('MeshCoreContactSyncSection auto-add options (#5777)', () => {
  beforeEach(() => {
    h.csrfFetch.mockReset();
  });

  it('derives "every node" from the toggle and disables the type boxes', async () => {
    mockServer({
      status: () => syncStatus({ autoAddEnabled: true, manualAddContacts: 0 }),
      config: () => autoAddConfig({ types: { chat: true, repeater: true, room: false, sensor: false } }),
    });
    renderSection();
    const all = await screen.findByRole('radio', { name: 'Add every node it hears' });
    expect((all as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Repeaters' }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/type boxes do nothing while/)).toBeTruthy();
  });

  it('reads "only these types" when manual with a type bit set, and enables the boxes', async () => {
    mockServer({ status: () => syncStatus(), config: () => autoAddConfig() });
    renderSection();
    const only = await screen.findByRole('radio', { name: 'Add only these types' });
    expect((only as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Companions' }) as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Companions' }) as HTMLInputElement).checked).toBe(true);
  });

  it('reads "none" when manual with no type bit, and hides max hops', async () => {
    mockServer({
      status: () => syncStatus(),
      config: () => autoAddConfig({ types: { chat: false, repeater: false, room: false, sensor: false } }),
    });
    renderSection();
    const none = await screen.findByRole('radio', { name: 'Add none (manual)' });
    expect((none as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByLabelText('Max hops')).toBeNull();
  });

  it('sends only the changed type box', async () => {
    mockServer({ status: () => syncStatus(), config: () => autoAddConfig() });
    renderSection();
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Repeaters' }));
    await waitFor(() => expect(configPosts()).toEqual([{ types: { repeater: true } }]));
  });

  it('sends max hops and overwrite-oldest', async () => {
    mockServer({ status: () => syncStatus(), config: () => autoAddConfig({ maxHops: 12 }) });
    renderSection();
    const select = await screen.findByLabelText('Max hops');
    // A value the device reports above the standard list stays selectable.
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.value)).toContain('12');
    await userEvent.selectOptions(select, '2');
    await userEvent.click(screen.getByRole('checkbox', { name: /Replace the oldest non-favourite contact/ }));
    await waitFor(() => expect(configPosts()).toEqual([{ maxHops: 2 }, { overwriteOldest: true }]));
  });

  it('switching to "every node" turns the toggle on', async () => {
    mockServer({
      status: () => syncStatus(),
      config: () => autoAddConfig(),
      autoAdd: { success: true, data: { autoAddEnabled: true, manualAddContacts: 0 } },
    });
    renderSection();
    await userEvent.click(await screen.findByRole('radio', { name: 'Add every node it hears' }));
    await waitFor(() => {
      const call = h.csrfFetch.mock.calls.find(([url]) => url === `${PREFIX}/config/auto-add-contacts`);
      expect(JSON.parse(call?.[1].body)).toEqual({ enabled: true });
    });
  });

  it('switching to "none" turns the toggle off and clears every type', async () => {
    mockServer({
      status: () => syncStatus({ autoAddEnabled: true, manualAddContacts: 0 }),
      config: () => autoAddConfig(),
      autoAdd: { success: true, data: { autoAddEnabled: false, manualAddContacts: 1 } },
    });
    renderSection();
    await userEvent.click(await screen.findByRole('radio', { name: 'Add none (manual)' }));
    await waitFor(() =>
      expect(configPosts()).toEqual([{ types: { chat: false, repeater: false, room: false, sensor: false } }]),
    );
    const call = h.csrfFetch.mock.calls.find(([url]) => url === `${PREFIX}/config/auto-add-contacts`);
    expect(JSON.parse(call?.[1].body)).toEqual({ enabled: false });
  });

  it('hides the options and shows one hint when the firmware lacks them; the toggle still works', async () => {
    mockServer({ status: () => syncStatus(), config: () => autoAddConfig({ supported: false }) });
    renderSection();
    expect(await screen.findByTestId('meshcore-autoadd-unsupported')).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByLabelText('Max hops')).toBeNull();
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Push to radio/ })).toBeTruthy();
  });

  it('disables the config controls without configuration:write', async () => {
    mockServer({ status: () => syncStatus(), config: () => autoAddConfig() });
    renderSection({ canEditConfig: false });
    const radio = await screen.findByRole('radio', { name: 'Add only these types' });
    expect(radio).toBeDisabled();
  });
});

describe('MeshCoreContactSyncSection bulk remove (#5777)', () => {
  beforeEach(() => {
    h.csrfFetch.mockReset();
  });

  const removeButton = () => screen.findByRole('button', { name: /Remove non-favourite contacts from the radio/ });

  it('asks with the exact counts, then shows the result', async () => {
    mockServer({
      status: () => syncStatus({ removableContactCount: 7, keptContactCount: 3 }),
      remove: { success: true, data: { removed: 6, kept: 3, failed: 1, total: 10 } },
    });
    renderSection();
    await userEvent.click(await removeButton());
    expect(screen.getByTestId('meshcore-remove-confirm-text').textContent).toBe(
      'This removes 7 contacts from the radio and keeps 3 favourites.',
    );
    expect(screen.getByText(/changes the radio's list only/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect((await screen.findByTestId('meshcore-remove-result')).textContent).toBe('Removed 6, kept 3, failed 1');
    expect(h.csrfFetch.mock.calls.some(([url]) => url === `${PREFIX}/contacts/remove-non-favorites`)).toBe(true);
  });

  it('cancel sends nothing', async () => {
    mockServer({ status: () => syncStatus({ removableContactCount: 2, keptContactCount: 0 }) });
    renderSection();
    await userEvent.click(await removeButton());
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(h.csrfFetch.mock.calls.some(([url]) => url === `${PREFIX}/contacts/remove-non-favorites`)).toBe(false);
  });

  it('is disabled when nothing would be removed', async () => {
    mockServer({ status: () => syncStatus({ removableContactCount: 0, keptContactCount: 4 }) });
    renderSection();
    expect(((await removeButton()) as HTMLButtonElement).disabled).toBe(true);
  });

  it('is hidden without nodes:write and disabled when not connected', async () => {
    mockServer({ status: () => syncStatus({ removableContactCount: 2 }) });
    const { unmount } = renderSection({ canEditNodes: false });
    await waitFor(() => expect(h.csrfFetch).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Remove non-favourite contacts/ })).toBeNull();
    unmount();
    renderSection({ connected: false });
    expect((screen.getByRole('button', { name: /Remove non-favourite contacts/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the server error', async () => {
    mockServer({
      status: () => syncStatus({ removableContactCount: 2 }),
      remove: { success: false, code: 'BULK_REMOVE_RUNNING', error: 'A bulk remove is already running' },
    });
    renderSection();
    await userEvent.click(await removeButton());
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect((await screen.findByRole('alert')).textContent).toBe('A bulk remove is already running');
  });
});
