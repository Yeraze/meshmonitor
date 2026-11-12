/**
 * @vitest-environment jsdom
 *
 * useMeshCore destructive device actions (power off, reboot, factory reset,
 * private-key import) send `confirm: true` only when the caller asks for it.
 * Omitting the option must not skip the server's danger guard (4.17.3 review L8).
 *
 * Mock shape follows useMeshCore.tracePathTimeout.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('../../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => (globalThis as unknown as { fetch: unknown }).fetch,
}));

vi.mock('../../../contexts/MapContext', () => ({
  useMapContext: () => ({ setMeshCoreNodes: vi.fn() }),
}));

vi.mock('../../../contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({ state: { socket: { connected: true, on: vi.fn(), off: vi.fn(), emit: vi.fn(), io: { on: vi.fn(), off: vi.fn() } } } }),
}));

// Stable reference: a fresh fn per render would re-run the hook's effects forever.
const showToast = vi.fn();
vi.mock('../../ToastContainer', () => ({
  useToast: () => ({ showToast }),
}));

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../../test/mockI18n');
  return createReactI18nextMock();
});

import { useMeshCore } from './useMeshCore';

const LOCAL_PK = 'a'.repeat(64);

const snapshot = {
  success: true,
  data: {
    status: { connected: true, deviceType: 1, deviceTypeName: 'Companion', config: null, localNode: { publicKey: LOCAL_PK, name: 'Me', advType: 1 } },
    contacts: [],
    nodes: [],
    messages: [],
    seqCursor: 0,
  },
};

function mockOk() {
  const fetchMock = vi.fn(async (url: string, _init?: { body?: string }) => {
    if (typeof url === 'string' && url.includes('/snapshot')) {
      return { ok: true, status: 200, json: async () => snapshot };
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  });
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  const bodyFor = (path: string) => {
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes(path));
    return call?.[1]?.body ? JSON.parse(call[1].body) : undefined;
  };
  return { bodyFor };
}

async function renderConnectedHook() {
  const { result } = renderHook(() => useMeshCore({ baseUrl: '', sourceId: 'src-1', enabled: true }));
  await waitFor(() => expect(result.current.hasLoadedOnce).toBe(true));
  return result;
}

describe('useMeshCore — destructive actions need an explicit confirm', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends confirm:false when the caller passes no options', async () => {
    const { bodyFor } = mockOk();
    const result = await renderConnectedHook();

    await result.current.actions.powerOffDevice();
    await result.current.actions.rebootDevice();
    await result.current.actions.factoryReset();
    await result.current.actions.importPrivateKey('ab'.repeat(64));

    expect(bodyFor('/config/power-off')).toEqual({ confirm: false });
    expect(bodyFor('/config/reboot')).toEqual({ confirm: false });
    expect(bodyFor('/config/factory-reset')).toEqual({ confirm: false });
    expect(bodyFor('/config/private-key')).toMatchObject({ confirm: false });
  });

  it('sends confirm:true only when the caller asks for it', async () => {
    const { bodyFor } = mockOk();
    const result = await renderConnectedHook();

    await result.current.actions.powerOffDevice({ confirm: true });
    await result.current.actions.rebootDevice({ confirm: true });
    await result.current.actions.factoryReset({ confirm: true });
    await result.current.actions.importPrivateKey('ab'.repeat(64), { confirm: true });

    expect(bodyFor('/config/power-off')).toEqual({ confirm: true });
    expect(bodyFor('/config/reboot')).toEqual({ confirm: true });
    expect(bodyFor('/config/factory-reset')).toEqual({ confirm: true });
    expect(bodyFor('/config/private-key')).toMatchObject({ confirm: true });
  });
});
