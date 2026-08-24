/**
 * @vitest-environment jsdom
 *
 * MeshCoreNodeDisplaySection (#4412 Phase 4 WP2).
 *
 * Renders inside a REAL QueryClientProvider with `apiService.get` mocked, so
 * `useNodeDisplaySettings` is exercised for real (not stubbed) — this is the
 * only place the section, the Nodes list and the map's shared cache entry is
 * proven to actually hydrate from `/api/settings?sourceId=`.
 *
 * `useSaveBar` is mocked to capture its options into a ref, the same
 * strategy `SettingsTab.nodeDisplay.perSource.test.tsx` uses, so tests can
 * drive onSave()/onDismiss() directly without rendering a SaveBarProvider.
 *
 * Test (7) — cache invalidation after save — is the deliverable named by the
 * spec (§5.2(7) / R3): without it, the Nodes list and map keep filtering on
 * a stale cutoff until a full page reload, and every other test in this
 * suite still passes. It is not optional.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MeshCoreNodeDisplaySection } from './MeshCoreNodeDisplaySection';
import {
  NODE_DISPLAY_RANGES,
  type NodeDisplaySettingKey,
} from '../../constants/nodeDisplayDefaults';

const SOURCE_ID = 'mc-source one'; // contains a space so URL-encoding is actually exercised

const MESHCORE_KEYS = [
  'maxNodeAge',
  'inactiveNodeThresholdHours',
  'inactiveNodeCheckIntervalMinutes',
  'inactiveNodeCooldownHours',
] as const;

const MESHTASTIC_ONLY_IDS = [
  'localStatsIntervalMinutes',
  'nodeHopsCalculation',
  'hideIncompleteNodes',
  'nodeDimmingEnabled',
  'nodeDimmingStartHours',
  'nodeDimmingMinOpacity',
] as const;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
  }),
}));

const { hasPermissionMock } = vi.hoisted(() => ({ hasPermissionMock: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: hasPermissionMock }),
}));

const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

const { csrfFetchMock } = vi.hoisted(() => ({ csrfFetchMock: vi.fn() }));
vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));

const { saveBarCapture } = vi.hoisted(() => ({
  saveBarCapture: {
    current: null as null | {
      hasChanges: boolean;
      isSaving: boolean;
      onSave: () => Promise<void>;
      onDismiss: () => void;
    },
  },
}));
vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: (options: unknown) => {
    saveBarCapture.current = options as typeof saveBarCapture.current;
  },
}));

const { writeNodeDisplayLocalMock } = vi.hoisted(() => ({
  writeNodeDisplayLocalMock: vi.fn(),
}));
vi.mock('../../utils/nodeDisplayStorage', () => ({
  writeNodeDisplayLocal: writeNodeDisplayLocalMock,
}));

vi.mock('../../services/api', () => ({
  default: { get: vi.fn() },
}));
import apiService from '../../services/api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SERVED_VALUES: Record<string, string> = {
  maxNodeAgeHours: '48',
  inactiveNodeThresholdHours: '12',
  inactiveNodeCheckIntervalMinutes: '30',
  inactiveNodeCooldownHours: '6',
};

function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderSection(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MeshCoreNodeDisplaySection baseUrl="" sourceId={SOURCE_ID} />
    </QueryClientProvider>,
  );
}

async function waitForHydration() {
  await waitFor(() =>
    expect((document.getElementById('maxNodeAge') as HTMLInputElement | null)?.value).toBe('48'),
  );
}

describe('MeshCoreNodeDisplaySection', () => {
  beforeEach(() => {
    vi.mocked(apiService.get).mockReset().mockResolvedValue(SERVED_VALUES);
    hasPermissionMock.mockReset().mockReturnValue(true);
    showToastMock.mockReset();
    writeNodeDisplayLocalMock.mockReset();
    csrfFetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({}) });
    saveBarCapture.current = null;
  });

  it('(1) renders exactly four number inputs, with the SettingsTab-matching ids', async () => {
    renderSection(makeQueryClient());
    await waitForHydration();
    for (const id of MESHCORE_KEYS) {
      const input = document.getElementById(id) as HTMLInputElement | null;
      expect(input).not.toBeNull();
      expect(input?.tagName).toBe('INPUT');
      expect(input?.type).toBe('number');
    }
  });

  it('(2) renders none of the six Meshtastic-only keys — replaces the deleted SettingsTab hide-branch test', async () => {
    renderSection(makeQueryClient());
    await waitForHydration();
    for (const id of MESHTASTIC_ONLY_IDS) {
      expect(document.getElementById(id)).toBeNull();
    }
  });

  it('(3) min/max on each input come from NODE_DISPLAY_RANGES, not literals', async () => {
    renderSection(makeQueryClient());
    await waitForHydration();
    const idToKey: Record<string, NodeDisplaySettingKey> = {
      maxNodeAge: 'maxNodeAgeHours',
      inactiveNodeThresholdHours: 'inactiveNodeThresholdHours',
      inactiveNodeCheckIntervalMinutes: 'inactiveNodeCheckIntervalMinutes',
      inactiveNodeCooldownHours: 'inactiveNodeCooldownHours',
    };
    for (const [id, key] of Object.entries(idToKey)) {
      const input = document.getElementById(id) as HTMLInputElement;
      const range = NODE_DISPLAY_RANGES[key]!;
      expect(input.min).toBe(String(range.min));
      expect(input.max).toBe(String(range.max));
    }
  });

  it('(4) hydrates from GET /api/settings?sourceId=<id>, URL-encoded, and shows the served values', async () => {
    renderSection(makeQueryClient());
    await waitFor(() =>
      expect(apiService.get).toHaveBeenCalledWith(
        `/api/settings?sourceId=${encodeURIComponent(SOURCE_ID)}`,
      ),
    );
    await waitForHydration();
    expect((document.getElementById('inactiveNodeThresholdHours') as HTMLInputElement).value).toBe('12');
    expect((document.getElementById('inactiveNodeCheckIntervalMinutes') as HTMLInputElement).value).toBe('30');
    expect((document.getElementById('inactiveNodeCooldownHours') as HTMLInputElement).value).toBe('6');
  });

  it('(5) editing an input flips hasChanges; onSave() clears it', async () => {
    renderSection(makeQueryClient());
    await waitForHydration();

    expect(saveBarCapture.current?.hasChanges).toBe(false);

    const input = document.getElementById('maxNodeAge') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '72' } });

    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(true));

    await saveBarCapture.current!.onSave();

    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(false));
  });

  it('(6) onSave() POSTs to /api/settings?sourceId=<id> with exactly the five keys, as strings', async () => {
    renderSection(makeQueryClient());
    await waitForHydration();

    await saveBarCapture.current!.onSave();

    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalled());
    const [url, opts] = csrfFetchMock.mock.calls[0];
    expect(url).toBe(`/api/settings?sourceId=${encodeURIComponent(SOURCE_ID)}`);
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(Object.keys(body).sort()).toEqual([
      'inactiveNodeCheckIntervalMinutes',
      'inactiveNodeCooldownHours',
      'inactiveNodeThresholdHours',
      'maxInfraNodeAgeHours',
      'maxNodeAgeHours',
    ]);
    for (const v of Object.values(body)) {
      expect(typeof v).toBe('string');
    }
  });

  it('(6b) clearing a field does not produce NaN in the saved payload (#4433 review)', async () => {
    renderSection(makeQueryClient());
    await waitForHydration();

    const input = document.getElementById('maxNodeAge') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });

    // The draft falls back to the last-known-good value rather than NaN, so
    // the input never renders the literal string "NaN"...
    expect(input.value).toBe('48');

    await saveBarCapture.current!.onSave();

    // ...and the saved payload carries that same numeric string, not "NaN".
    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalled());
    const [, opts] = csrfFetchMock.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.maxNodeAgeHours).toBe('48');
    for (const v of Object.values(body)) {
      expect(v).not.toBe('NaN');
    }
  });

  it('(7) MANDATORY: a successful save invalidates the shared node-display query cache', async () => {
    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderSection(queryClient);
    await waitForHydration();

    await saveBarCapture.current!.onSave();

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['settings', 'node-display', SOURCE_ID],
      }),
    );
  });

  it('(8) writes the four namespaced localStorage mirrors after a successful save', async () => {
    renderSection(makeQueryClient());
    await waitForHydration();

    await saveBarCapture.current!.onSave();

    await waitFor(() => expect(writeNodeDisplayLocalMock).toHaveBeenCalledTimes(4));
    const writtenKeys = writeNodeDisplayLocalMock.mock.calls.map((c: unknown[]) => c[1]).sort();
    expect(writtenKeys).toEqual([
      'inactiveNodeCheckIntervalMinutes',
      'inactiveNodeCooldownHours',
      'inactiveNodeThresholdHours',
      'maxNodeAgeHours',
    ]);
    for (const call of writeNodeDisplayLocalMock.mock.calls) {
      expect(call[0]).toBe(SOURCE_ID);
      expect(typeof call[2]).toBe('string');
    }
  });

  it('(9) hasPermission("settings","write") false disables all four inputs', async () => {
    hasPermissionMock.mockReturnValue(false);
    renderSection(makeQueryClient());
    await waitForHydration();
    for (const id of MESHCORE_KEYS) {
      expect((document.getElementById(id) as HTMLInputElement).disabled).toBe(true);
    }
    expect(hasPermissionMock).toHaveBeenCalledWith('settings', 'write', { sourceId: SOURCE_ID });
  });

  it('(10) a 403 response shows the insufficient-permissions toast and leaves hasChanges true', async () => {
    csrfFetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    renderSection(makeQueryClient());
    await waitForHydration();

    fireEvent.change(document.getElementById('maxNodeAge') as HTMLInputElement, {
      target: { value: '72' },
    });
    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(true));

    await saveBarCapture.current!.onSave();

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith('Insufficient permissions', 'error'));
    expect(saveBarCapture.current?.hasChanges).toBe(true);
  });
});
