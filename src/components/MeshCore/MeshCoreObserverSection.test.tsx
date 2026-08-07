/**
 * @vitest-environment jsdom
 *
 * MeshCoreObserverSection tests (#4457 Phase 3 WP3, spec §11.2).
 *
 * Mocks:
 *  - `../../contexts/AuthContext` — reassignable `authPermission`, mirroring
 *    MeshCoreConfigurationView.test.tsx's pattern.
 *  - `../../hooks/useDashboardData` (`useSourceStatuses`) — reassignable map.
 *  - `./hooks/useObserverKey` — its own tests live in useObserverKey.test.tsx.
 *    This mock is a small real hook (backed by React state) so that clicking
 *    a button produces the same busy -> resolve -> status/actionError
 *    transitions the real hook would, without re-testing the hook itself.
 *
 * `src/test/setup.ts` mocks react-i18next so `t(key, fallback)` returns the
 * key — assertions query by key string throughout.
 */
import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ObserverKeyStatus, ObserverKeyError, ObserverKeyAction } from './hooks/useObserverKey';

// --- AuthContext -----------------------------------------------------------
let authPermission: (resource: string, action: string, opts?: { sourceId?: string }) => boolean = () => true;
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    hasPermission: (r: string, a: string, o?: { sourceId?: string }) => authPermission(r, a, o),
  }),
}));

// --- useSourceStatuses -------------------------------------------------------
let sourceStatusMap: Map<string, Record<string, unknown> | null> = new Map();
vi.mock('../../hooks/useDashboardData', () => ({
  useSourceStatuses: () => sourceStatusMap,
}));

// --- useObserverKey ----------------------------------------------------------
type MockResult = { ok: boolean; data?: ObserverKeyStatus; error?: ObserverKeyError };
interface MockBackends {
  importFromDevice: () => Promise<MockResult>;
  setManualKey: (hex: string) => Promise<MockResult>;
  clearKey: () => Promise<MockResult>;
}

let mockInitialStatus: ObserverKeyStatus | null = null;
let mockLoading = false;
let mockLoadError: ObserverKeyError | null = null;
let mockBackends: MockBackends;

vi.mock('./hooks/useObserverKey', () => ({
  useObserverKey: () => {
    const [status, setStatus] = useState<ObserverKeyStatus | null>(mockInitialStatus);
    const [busy, setBusy] = useState<ObserverKeyAction | null>(null);
    const [actionError, setActionError] = useState<ObserverKeyError | null>(null);

    const run = async (
      action: ObserverKeyAction,
      fn: () => Promise<MockResult>,
    ): Promise<boolean> => {
      setBusy(action);
      setActionError(null);
      const result = await fn();
      setBusy(null);
      if (result.ok) {
        if (result.data) setStatus(result.data);
        return true;
      }
      setActionError(result.error ?? { code: null, message: null });
      return false;
    };

    return {
      status,
      loading: mockLoading,
      loadError: mockLoadError,
      busy,
      actionError,
      refresh: vi.fn(),
      importFromDevice: () => run('import', () => mockBackends.importFromDevice()),
      setManualKey: (hex: string) => run('manual', () => mockBackends.setManualKey(hex)),
      clearKey: () => run('clear', () => mockBackends.clearKey()),
      clearActionError: () => setActionError(null),
    };
  },
}));

// --- useObserverCredentials (#4595) -----------------------------------------
// The section now also mounts the static-credential block. These tests are
// about the SIGNING-KEY blocks, so the credential hook is stubbed to "nothing
// stored" — which also keeps the mode heuristic on the token/unknown branch so
// the key blocks stay rendered. Stubbing it (rather than wrapping the tree in a
// CsrfProvider) keeps this file's existing no-provider render() calls working.
const mockCredentialStatus: ObserverCredentialStatus | null = null;
const mockSaveCredentials = vi.fn(async () => true);
const mockClearCredentials = vi.fn(async () => true);
vi.mock('./hooks/useObserverCredentials', () => ({
  useObserverCredentials: () => ({
    status: mockCredentialStatus,
    loading: false,
    loadError: null,
    busy: null,
    actionError: null,
    refresh: vi.fn(),
    saveCredentials: mockSaveCredentials,
    clearCredentials: mockClearCredentials,
    clearActionError: vi.fn(),
  }),
}));

import type { ObserverCredentialStatus } from './hooks/useObserverCredentials';
import { MeshCoreObserverSection } from './MeshCoreObserverSection';

const SOURCE_ID = 's1';
const VALID_KEY_HEX = 'ab'.repeat(64); // 128 hex chars

function makeKeyStatus(overrides: Partial<ObserverKeyStatus> = {}): ObserverKeyStatus {
  return {
    stored: false,
    publicKey: null,
    origin: null,
    updatedAt: null,
    keyRotated: false,
    canStore: true,
    reason: null,
    ...overrides,
  };
}

function makeObserverStatusEntry(observer: Record<string, unknown> | undefined) {
  return { sourceId: SOURCE_ID, connected: true, observer };
}

beforeEach(() => {
  authPermission = () => true;
  sourceStatusMap = new Map([[SOURCE_ID, makeObserverStatusEntry(undefined)]]);
  mockInitialStatus = null;
  mockLoading = false;
  mockLoadError = null;
  mockBackends = {
    importFromDevice: vi.fn().mockResolvedValue({ ok: true, data: makeKeyStatus({ stored: true }) }),
    setManualKey: vi.fn().mockResolvedValue({ ok: true, data: makeKeyStatus({ stored: true }) }),
    clearKey: vi.fn().mockResolvedValue({ ok: true, data: makeKeyStatus({ stored: false }) }),
  };
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('MeshCoreObserverSection — permission gating', () => {
  it('renders nothing without configuration:read', () => {
    authPermission = () => false;
    const { container } = render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('hides the actions block when configuration:write is denied while status/key display remains', () => {
    authPermission = (_resource, action) => action !== 'write';
    mockInitialStatus = makeKeyStatus({ stored: true, publicKey: VALID_KEY_HEX, origin: 'device', updatedAt: 1 });
    render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);

    expect(screen.getByText('meshcore.observer.key_heading')).toBeDefined();
    expect(screen.queryByText('meshcore.observer.fetch_button')).toBeNull();
    expect(screen.queryByText('meshcore.observer.manual_button')).toBeNull();
    expect(screen.queryByText('meshcore.observer.clear_button')).toBeNull();
  });
});

describe('MeshCoreObserverSection — [A] live status block', () => {
  it('renders the status block when observer is present on the source status', () => {
    sourceStatusMap = new Map([
      [
        SOURCE_ID,
        makeObserverStatusEntry({
          configured: true,
          keyStored: true,
          connected: true,
          publishes: 5,
          dropped: 0,
          lastPublishAt: null,
          lastError: null,
          tokenExpiresAt: null,
        }),
      ],
    ]);
    render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);
    expect(screen.getByText('meshcore.observer.status_heading')).toBeDefined();
  });

  it('renders no status block (normal, not an error) when observer is absent, while the key block still renders', () => {
    sourceStatusMap = new Map([[SOURCE_ID, makeObserverStatusEntry(undefined)]]);
    mockInitialStatus = makeKeyStatus({ stored: false });
    render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);
    expect(screen.queryByText('meshcore.observer.status_heading')).toBeNull();
    expect(screen.getByText('meshcore.observer.key_heading')).toBeDefined();
  });

  it('treats tokenExpiresAt as unix SECONDS (×1000), so a future value renders a future time, not decades ago', () => {
    const futureSeconds = Math.floor(Date.now() / 1000) + 3600;
    sourceStatusMap = new Map([
      [
        SOURCE_ID,
        makeObserverStatusEntry({
          configured: true,
          keyStored: true,
          connected: true,
          publishes: 0,
          dropped: 0,
          lastPublishAt: null,
          lastError: null,
          tokenExpiresAt: futureSeconds,
        }),
      ],
    ]);
    render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);
    // Rendered as an absolute local time (formatRelativeTime clamps future
    // timestamps to "just now", which reads wrong for a +24h expiry — caught
    // in Phase 3 browser validation). The ×1000 guard: using the raw seconds
    // value as milliseconds would resolve to a date decades in the past.
    const expected = new Date(futureSeconds * 1000).toLocaleString();
    expect(screen.getByText(expected)).toBeDefined();
    expect(screen.queryByText('just now')).toBeNull();
    expect(screen.queryByText(/19[0-9]{2}\b/)).toBeNull();
  });
});

describe('MeshCoreObserverSection — [B] key status block', () => {
  it('renders the cannot_store warning and disables Fetch + Manual while Clear stays enabled', () => {
    mockInitialStatus = makeKeyStatus({
      stored: true,
      publicKey: VALID_KEY_HEX,
      canStore: false,
      reason: 'SESSION_SECRET is auto-generated',
    });
    render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);

    expect(screen.getByText('meshcore.observer.cannot_store')).toBeDefined();
    expect(screen.getByText('meshcore.observer.fetch_button').closest('button')).toBeDisabled();
    expect(screen.getByText('meshcore.observer.manual_button').closest('button')).toBeDisabled();
    expect(screen.getByText('meshcore.observer.clear_button').closest('button')).not.toBeDisabled();
  });

  it('disables Clear when no key is stored', () => {
    mockInitialStatus = makeKeyStatus({ stored: false });
    render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);
    expect(screen.getByText('meshcore.observer.clear_button').closest('button')).toBeDisabled();
  });

  it('renders a role="alert" keyRotated warning', () => {
    mockInitialStatus = makeKeyStatus({
      stored: true,
      publicKey: VALID_KEY_HEX,
      keyRotated: true,
    });
    render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);
    const alertEl = screen.getByText('meshcore.observer.key_rotated');
    expect(alertEl.closest('[role="alert"]')).not.toBeNull();
  });

  it('truncates the public key for display and keeps the full key in the title attribute', () => {
    mockInitialStatus = makeKeyStatus({ stored: true, publicKey: VALID_KEY_HEX, origin: 'device', updatedAt: 1 });
    render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);
    const expectedTruncated = `${VALID_KEY_HEX.slice(0, 8)}…${VALID_KEY_HEX.slice(-8)}`;
    const pkEl = screen.getByText(expectedTruncated);
    expect(pkEl.getAttribute('title')).toBe(VALID_KEY_HEX);
    expect(screen.queryByText(VALID_KEY_HEX)).toBeNull();
  });
});

describe('MeshCoreObserverSection — [C] key actions', () => {
  it('disables Fetch with a title when disconnected, and enables it when connected', () => {
    mockInitialStatus = makeKeyStatus({ stored: false });
    const { rerender } = render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={false} />);
    const fetchButton = screen.getByText('meshcore.observer.fetch_button').closest('button')!;
    expect(fetchButton).toBeDisabled();
    expect(fetchButton.getAttribute('title')).toBe('meshcore.observer.fetch_needs_connection');

    rerender(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);
    expect(screen.getByText('meshcore.observer.fetch_button').closest('button')).not.toBeDisabled();
  });

  it('clicking Fetch calls importFromDevice; a rejected SOURCE_NOT_CONNECTED renders the mapped error', async () => {
    mockInitialStatus = makeKeyStatus({ stored: false });
    mockBackends.importFromDevice = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'SOURCE_NOT_CONNECTED', message: 'Source is not connected' },
    });
    render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);

    fireEvent.click(screen.getByText('meshcore.observer.fetch_button'));
    expect(mockBackends.importFromDevice).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(screen.getByText('meshcore.observer.err_not_connected')).toBeDefined();
    });
  });

  it('busy disables Fetch, Manual, and Clear while a mutation is in flight', async () => {
    mockInitialStatus = makeKeyStatus({ stored: true, publicKey: VALID_KEY_HEX });
    mockBackends.importFromDevice = vi.fn(() => new Promise<MockResult>(() => {})); // never resolves
    render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);

    fireEvent.click(screen.getByText('meshcore.observer.fetch_button'));

    await waitFor(() => {
      expect(screen.getByText('meshcore.observer.fetching')).toBeDefined();
    });
    expect(screen.getByText('meshcore.observer.fetching').closest('button')).toBeDisabled();
    expect(screen.getByText('meshcore.observer.manual_button').closest('button')).toBeDisabled();
    expect(screen.getByText('meshcore.observer.clear_button').closest('button')).toBeDisabled();
  });

  it('manual panel: a client-side length pre-check blocks a bad-length key before any request', () => {
    mockInitialStatus = makeKeyStatus({ stored: false });
    render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);

    fireEvent.click(screen.getByText('meshcore.observer.manual_button'));
    const input = screen.getByPlaceholderText('meshcore.observer.manual_placeholder');
    fireEvent.change(input, { target: { value: 'a'.repeat(100) } });
    fireEvent.click(screen.getByText('meshcore.observer.manual_save'));

    expect(mockBackends.setManualKey).not.toHaveBeenCalled();
    expect(screen.getByText('meshcore.observer.manual_invalid_length')).toBeDefined();
  });

  it('manual panel: a valid 128-hex key calls setManualKey once with the entered value', async () => {
    mockInitialStatus = makeKeyStatus({ stored: false });
    render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);

    fireEvent.click(screen.getByText('meshcore.observer.manual_button'));
    const input = screen.getByPlaceholderText('meshcore.observer.manual_placeholder') as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.change(input, { target: { value: VALID_KEY_HEX } });
    fireEvent.click(screen.getByText('meshcore.observer.manual_save'));

    await waitFor(() => {
      expect(mockBackends.setManualKey).toHaveBeenCalledTimes(1);
    });
    expect(mockBackends.setManualKey).toHaveBeenCalledWith(VALID_KEY_HEX);
  });

  it('the private key never reaches the DOM after a successful manual save', async () => {
    mockInitialStatus = makeKeyStatus({ stored: false });
    mockBackends.setManualKey = vi.fn().mockResolvedValue({
      ok: true,
      data: makeKeyStatus({ stored: true, publicKey: 'cd'.repeat(64), origin: 'manual', updatedAt: 1 }),
    });
    const { container } = render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);

    fireEvent.click(screen.getByText('meshcore.observer.manual_button'));
    const input = screen.getByPlaceholderText('meshcore.observer.manual_placeholder');
    fireEvent.change(input, { target: { value: VALID_KEY_HEX } });
    fireEvent.click(screen.getByText('meshcore.observer.manual_save'));

    await waitFor(() => {
      expect(screen.queryByPlaceholderText('meshcore.observer.manual_placeholder')).toBeNull();
    });
    expect(container.innerHTML).not.toContain(VALID_KEY_HEX);
  });

  it('Clear asks for confirmation and does nothing when the user cancels', async () => {
    mockInitialStatus = makeKeyStatus({ stored: true, publicKey: VALID_KEY_HEX });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);

    fireEvent.click(screen.getByText('meshcore.observer.clear_button'));
    expect(window.confirm).toHaveBeenCalled();
    expect(mockBackends.clearKey).not.toHaveBeenCalled();
  });

  it('Clear proceeds and calls clearKey when the user confirms', async () => {
    mockInitialStatus = makeKeyStatus({ stored: true, publicKey: VALID_KEY_HEX });
    render(<MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />);

    fireEvent.click(screen.getByText('meshcore.observer.clear_button'));
    await waitFor(() => {
      expect(mockBackends.clearKey).toHaveBeenCalledTimes(1);
    });
  });
});
