/**
 * @vitest-environment jsdom
 *
 * MeshCoreObserverSection — per-broker credentials (#5825).
 *
 * Runs the REAL useObserverCredentials hook and the REAL broker panel, with
 * only the network (`useCsrfFetch`) and the broker status poll stubbed, so the
 * assertions are about the exact requests the page sends:
 *   - Set / Clear on a broker card carry that broker's `brokerKey`.
 *   - The Clear confirm names the broker.
 *   - The old shared credential is removed with `?legacy=1`, never a bare
 *     key-less DELETE (which used to wipe every broker's credential).
 *   - The signing-key block shows when ANY broker uses token auth.
 *
 * `src/test/setup.ts` mocks react-i18next so `t(key, fallback, opts)` returns
 * the key — assertions query by key string.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ObserverBrokerStatus, ObserverStatusResponse } from '../../services/api';

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));
vi.mock('../../hooks/useDashboardData', () => ({
  useSourceStatuses: () => new Map(),
  useDashboardSources: () => ({ data: [] }),
}));

// --- Broker list draft (#5831) ----------------------------------------------
// The editable broker list has its own test file
// (MeshCoreObserverSection.brokerEditor.test.tsx). Here the source list is
// empty and the SaveBar is a no-op, so these tests stay about the key and
// credential blocks.
vi.mock('../../hooks/useSaveBar', () => ({ useSaveBar: vi.fn() }));
vi.mock('./hooks/useObserverKey', () => ({
  useObserverKey: () => ({
    status: null,
    loading: false,
    loadError: null,
    busy: null,
    actionError: null,
    refresh: vi.fn(),
    importFromDevice: vi.fn(),
    setManualKey: vi.fn(),
    clearKey: vi.fn(),
    clearActionError: vi.fn(),
  }),
}));

let observerStatus: ObserverStatusResponse | null = null;
vi.mock('./hooks/useObserverStatus', () => ({
  useObserverStatus: () => ({ status: observerStatus, loading: false, error: null, refetch: vi.fn() }),
}));

const csrfFetchMock = vi.fn();
vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));
vi.mock('../../init', () => ({ appBasename: '' }));

import { MeshCoreObserverSection } from './MeshCoreObserverSection';

const SOURCE_ID = 's1';
const BASE = `/api/sources/${SOURCE_ID}/observer/credentials`;
const PW_A = 'wss://alpha.example:443';
const PW_B = 'wss://bravo.example:443';
const TOKEN_C = 'wss://charlie.example:443';

function broker(key: string, authMode: 'token' | 'password', label: string | null): ObserverBrokerStatus {
  return {
    key,
    url: key,
    label,
    authMode,
    tokenAudience: null,
    configured: true,
    keyStored: true,
    connected: false,
    publishes: 0,
    dropped: 0,
    lastPublishAt: null,
    lastError: null,
    tokenExpiresAt: null,
  };
}

function statusWith(brokers: ObserverBrokerStatus[]): ObserverStatusResponse {
  return {
    running: false,
    configured: true,
    authMode: brokers[0]?.authMode ?? 'token',
    keyStored: true,
    connected: false,
    publishes: 0,
    dropped: 0,
    lastPublishAt: null,
    lastError: null,
    tokenExpiresAt: null,
    brokers,
  } as unknown as ObserverStatusResponse;
}

interface CredBody {
  stored: boolean;
  username: string | null;
  updatedAt: number | null;
  keyRotated: boolean;
  canStore: boolean;
  reason: string | null;
  brokers: Array<{ brokerKey: string; username: string | null }>;
  legacy: { username: string | null } | null;
}

function credBody(overrides: Partial<CredBody> = {}): CredBody {
  return {
    stored: false,
    username: null,
    updatedAt: null,
    keyRotated: false,
    canStore: true,
    reason: null,
    brokers: [],
    legacy: null,
    ...overrides,
  };
}

function respond(body: CredBody) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: body }) });
}

/** Every request the page made, as `METHOD url`. */
function calls(): Array<{ method: string; url: string; body: unknown }> {
  return csrfFetchMock.mock.calls.map(([url, init]) => ({
    method: (init as RequestInit | undefined)?.method ?? 'GET',
    url: String(url),
    body: (init as RequestInit | undefined)?.body ? JSON.parse(String((init as RequestInit).body)) : undefined,
  }));
}

/** No DELETE may go out without naming a broker or the legacy entry. */
function expectNoBareDelete() {
  for (const c of calls().filter((x) => x.method === 'DELETE')) {
    expect(c.url === BASE).toBe(false);
    expect(/[?&](brokerKey=|legacy=1)/.test(c.url)).toBe(true);
  }
}

function cardFor(title: string): HTMLElement {
  const el = screen.getByText(title).parentElement;
  if (!el) throw new Error(`no card for ${title}`);
  return el;
}

beforeEach(() => {
  csrfFetchMock.mockReset();
  observerStatus = statusWith([broker(PW_A, 'password', 'Alpha'), broker(PW_B, 'password', 'Bravo')]);
});

describe('MeshCoreObserverSection — per-broker credentials (#5825)', () => {
  it('has no single shared username/password block any more', async () => {
    csrfFetchMock.mockImplementation(() => respond(credBody()));
    render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);
    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalled());
    expect(screen.queryByText('meshcore.observer.credentials_heading')).toBeNull();
    expect(screen.queryByText('meshcore.observer.credentials_clear')).toBeNull();
  });

  it("shows each password broker's own status", async () => {
    csrfFetchMock.mockImplementation(() =>
      respond(credBody({ stored: true, brokers: [{ brokerKey: PW_A, username: 'alpha-user' }] })),
    );
    render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);
    await waitFor(() => expect(within(cardFor('Alpha')).getByText('meshcore.observer.credentials_stored')).toBeTruthy());
    expect(within(cardFor('Bravo')).getByText('meshcore.observer.broker_credentials_none')).toBeTruthy();
    // Clear is only offered where something is stored.
    expect(
      (within(cardFor('Bravo')).getByLabelText('meshcore.observer.broker_credentials_clear_aria') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("Set sends a PUT carrying that broker's brokerKey", async () => {
    csrfFetchMock.mockImplementation(() => respond(credBody()));
    render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);
    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalledTimes(1));

    const card = cardFor('Bravo');
    fireEvent.click(within(card).getByLabelText('meshcore.observer.broker_credentials_set_aria'));
    fireEvent.change(within(card).getByPlaceholderText('meshcore'), { target: { value: 'bravo-user' } });
    fireEvent.change(within(card).getByPlaceholderText('meshcore.observer.credentials_password_placeholder'), {
      target: { value: ' pw with spaces ' },
    });
    csrfFetchMock.mockImplementationOnce(() =>
      respond(credBody({ stored: true, brokers: [{ brokerKey: PW_B, username: 'bravo-user' }] })),
    );
    fireEvent.click(within(card).getByText('meshcore.observer.credentials_save'));

    await waitFor(() => expect(calls().some((c) => c.method === 'PUT')).toBe(true));
    const put = calls().find((c) => c.method === 'PUT')!;
    expect(put.url).toBe(BASE);
    expect(put.body).toEqual({ brokerKey: PW_B, username: 'bravo-user', password: ' pw with spaces ' });
    // The password is gone from the DOM once saved.
    await waitFor(() => expect(within(cardFor('Bravo')).getByText('meshcore.observer.credentials_stored')).toBeTruthy());
    expect(document.body.innerHTML).not.toContain('pw with spaces');
  });

  it('Clear confirms with the broker named, then DELETEs with only that brokerKey', async () => {
    csrfFetchMock.mockImplementation(() =>
      respond(
        credBody({
          stored: true,
          brokers: [
            { brokerKey: PW_A, username: 'alpha-user' },
            { brokerKey: PW_B, username: 'bravo-user' },
          ],
        }),
      ),
    );
    render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);
    await waitFor(() => expect(within(cardFor('Alpha')).getByText('meshcore.observer.credentials_stored')).toBeTruthy());

    fireEvent.click(within(cardFor('Alpha')).getByLabelText('meshcore.observer.broker_credentials_clear_aria'));
    const dialog = await screen.findByRole('dialog');
    // The i18n mock returns the key; the broker name reaches t() as an option.
    expect(within(dialog).getByText('meshcore.observer.broker_credentials_clear_title')).toBeTruthy();
    expect(calls().some((c) => c.method === 'DELETE')).toBe(false);

    fireEvent.click(within(dialog).getByText('meshcore.observer.broker_credentials_clear'));
    await waitFor(() => expect(calls().some((c) => c.method === 'DELETE')).toBe(true));
    const del = calls().filter((c) => c.method === 'DELETE');
    expect(del).toHaveLength(1);
    expect(del[0].url).toBe(`${BASE}?brokerKey=${encodeURIComponent(PW_A)}`);
    expectNoBareDelete();
  });

  it('Cancel in the confirm sends nothing', async () => {
    csrfFetchMock.mockImplementation(() =>
      respond(credBody({ stored: true, brokers: [{ brokerKey: PW_A, username: 'alpha-user' }] })),
    );
    render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);
    await waitFor(() => expect(within(cardFor('Alpha')).getByText('meshcore.observer.credentials_stored')).toBeTruthy());
    fireEvent.click(within(cardFor('Alpha')).getByLabelText('meshcore.observer.broker_credentials_clear_aria'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText('common.cancel'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls().filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('removes the old shared credential with ?legacy=1, never a bare DELETE', async () => {
    csrfFetchMock.mockImplementation(() =>
      respond(
        credBody({
          stored: true,
          username: 'old-user',
          brokers: [{ brokerKey: PW_A, username: 'alpha-user' }],
          legacy: { username: 'old-user' },
        }),
      ),
    );
    render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);
    await screen.findByText('meshcore.observer.legacy_credential_note');

    fireEvent.click(screen.getByText('meshcore.observer.legacy_credential_remove'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('meshcore.observer.legacy_credential_remove_confirm')).toBeTruthy();
    fireEvent.click(within(dialog).getByText('meshcore.observer.legacy_credential_remove_button'));

    await waitFor(() => expect(calls().some((c) => c.method === 'DELETE')).toBe(true));
    const del = calls().filter((c) => c.method === 'DELETE');
    expect(del).toHaveLength(1);
    expect(del[0].url).toBe(`${BASE}?legacy=1`);
    expectNoBareDelete();
  });

  it('shows no legacy note when no shared credential is stored', async () => {
    csrfFetchMock.mockImplementation(() =>
      respond(credBody({ stored: true, brokers: [{ brokerKey: PW_A, username: 'alpha-user' }] })),
    );
    render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);
    await waitFor(() => expect(within(cardFor('Alpha')).getByText('meshcore.observer.credentials_stored')).toBeTruthy());
    expect(screen.queryByText('meshcore.observer.legacy_credential_note')).toBeNull();
    expect(screen.queryByText('meshcore.observer.legacy_credential_remove')).toBeNull();
  });

  it('shows the signing-key block when any broker uses token auth, even if the first uses a password', async () => {
    observerStatus = statusWith([broker(PW_A, 'password', 'Alpha'), broker(TOKEN_C, 'token', 'Charlie')]);
    csrfFetchMock.mockImplementation(() => respond(credBody()));
    render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);
    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalled());
    expect(screen.getByText('meshcore.observer.key_heading')).toBeTruthy();
    // The token broker gets no credential controls; the password one does.
    expect(within(cardFor('Charlie')).queryByText('meshcore.observer.broker_credentials_heading')).toBeNull();
    expect(within(cardFor('Alpha')).getByText('meshcore.observer.broker_credentials_heading')).toBeTruthy();
  });

  it('hides the signing-key block when every broker uses a password', async () => {
    csrfFetchMock.mockImplementation(() => respond(credBody()));
    render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);
    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalled());
    expect(screen.queryByText('meshcore.observer.key_heading')).toBeNull();
  });
});
