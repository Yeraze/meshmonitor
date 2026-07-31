/**
 * @vitest-environment jsdom
 *
 * useObserverKey (#4457 Phase 3, WP1) — the single owner of the four
 * observer signing-key routes. Pins the D-5 envelope unwrap, the
 * single-round-trip mutation contract, the busy re-entry guard, and unmount
 * safety. See docs/internal/dev-notes/MESHCORE_OBSERVER_PHASE3_SPEC.md §5/§5.1/§11.1.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const csrfFetchMock = vi.fn();
vi.mock('../../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));
vi.mock('../../../init', () => ({ appBasename: '' }));

import { useObserverKey } from './useObserverKey';
import type { ObserverKeyStatus } from './useObserverKey';

function baseStatus(overrides: Partial<ObserverKeyStatus> = {}): ObserverKeyStatus {
  return {
    stored: true,
    publicKey: 'AB'.repeat(32),
    origin: 'device',
    updatedAt: 1,
    keyRotated: false,
    canStore: true,
    reason: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: async () => body,
  });
}

describe('useObserverKey', () => {
  beforeEach(() => {
    csrfFetchMock.mockReset();
  });

  it('unwraps the {success, data} envelope (D-5)', async () => {
    csrfFetchMock.mockReturnValueOnce(
      jsonResponse({ success: true, data: baseStatus() }),
    );

    const { result } = renderHook(() => useObserverKey('s1'));

    await waitFor(() => expect(result.current.status).not.toBeNull());
    expect(result.current.status?.stored).toBe(true);
    expect(result.current.status?.publicKey).toBe('AB'.repeat(32));
    // A future "just use the body" regression (reading `success`/`stored`
    // straight off the un-enveloped response) must fail here.
    expect((result.current.status as unknown as { success?: boolean }).success).toBeUndefined();
  });

  it('calls the right URLs and methods for GET/import/PUT/DELETE', async () => {
    csrfFetchMock.mockReturnValue(jsonResponse({ success: true, data: baseStatus() }));

    const { result } = renderHook(() => useObserverKey('s1'));
    await waitFor(() => expect(result.current.status).not.toBeNull());
    expect(csrfFetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/sources/s1/observer/key',
      { method: 'GET' },
    );

    await result.current.importFromDevice();
    expect(csrfFetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/sources/s1/observer/key/import',
      { method: 'POST' },
    );

    await result.current.setManualKey('  0xAB  ');
    expect(csrfFetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/sources/s1/observer/key',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privateKey: '  0xAB  ' }),
      },
    );

    await result.current.clearKey();
    expect(csrfFetchMock).toHaveBeenNthCalledWith(
      4,
      '/api/sources/s1/observer/key',
      { method: 'DELETE' },
    );
  });

  it('setManualKey sends the raw string — no trim, no 0x strip', async () => {
    csrfFetchMock.mockReturnValue(jsonResponse({ success: true, data: baseStatus() }));
    const { result } = renderHook(() => useObserverKey('s1'));
    await waitFor(() => expect(result.current.status).not.toBeNull());

    await result.current.setManualKey('  0xAB…  ');

    const putCall = csrfFetchMock.mock.calls.find(([, opts]) => opts?.method === 'PUT');
    expect(putCall?.[1]?.body).toBe(JSON.stringify({ privateKey: '  0xAB…  ' }));
  });

  it('a successful mutation replaces status without a second GET (2 total calls)', async () => {
    csrfFetchMock
      .mockReturnValueOnce(jsonResponse({ success: true, data: baseStatus({ stored: false }) }))
      .mockReturnValueOnce(jsonResponse({ success: true, data: baseStatus({ stored: true, origin: 'manual' }) }));

    const { result } = renderHook(() => useObserverKey('s1'));
    await waitFor(() => expect(result.current.status?.stored).toBe(false));

    const ok = await result.current.importFromDevice();

    expect(ok).toBe(true);
    await waitFor(() => expect(result.current.status?.stored).toBe(true));
    expect(result.current.status?.origin).toBe('manual');
    expect(csrfFetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps a JSON error response onto actionError and leaves status unchanged', async () => {
    const originalStatus = baseStatus();
    csrfFetchMock
      .mockReturnValueOnce(jsonResponse({ success: true, data: originalStatus }))
      .mockReturnValueOnce(
        jsonResponse(
          { success: false, error: 'Source is not connected…', code: 'SOURCE_NOT_CONNECTED' },
          false,
          409,
        ),
      );

    const { result } = renderHook(() => useObserverKey('s1'));
    await waitFor(() => expect(result.current.status).not.toBeNull());

    const ok = await result.current.importFromDevice();

    expect(ok).toBe(false);
    await waitFor(() =>
      expect(result.current.actionError).toEqual({
        code: 'SOURCE_NOT_CONNECTED',
        message: 'Source is not connected…',
      }),
    );
    expect(result.current.status).toEqual(originalStatus);
  });

  it('a non-JSON error body maps to code:null without throwing', async () => {
    csrfFetchMock
      .mockReturnValueOnce(jsonResponse({ success: true, data: baseStatus() }))
      .mockReturnValueOnce(
        Promise.resolve({
          ok: false,
          status: 500,
          json: async () => {
            throw new Error('not json');
          },
        }),
      );

    const { result } = renderHook(() => useObserverKey('s1'));
    await waitFor(() => expect(result.current.status).not.toBeNull());

    let thrown: unknown = null;
    let ok: boolean | undefined;
    try {
      ok = await result.current.clearKey();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeNull();
    expect(ok).toBe(false);
    await waitFor(() =>
      expect(result.current.actionError).toEqual({ code: null, message: null }),
    );
  });

  it('sets busy to the action name during flight and null after; a re-entrant call is rejected without a request', async () => {
    let resolveImport: (v: unknown) => void = () => {};
    csrfFetchMock
      .mockReturnValueOnce(jsonResponse({ success: true, data: baseStatus() }))
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveImport = resolve;
        }),
      );

    const { result } = renderHook(() => useObserverKey('s1'));
    await waitFor(() => expect(result.current.status).not.toBeNull());

    const firstCall = result.current.importFromDevice();
    await waitFor(() => expect(result.current.busy).toBe('import'));

    // Re-entrant call while busy: resolves false immediately, no new request.
    const secondCall = await result.current.clearKey();
    expect(secondCall).toBe(false);
    expect(csrfFetchMock).toHaveBeenCalledTimes(2); // initial GET + the in-flight import only

    resolveImport({ ok: true, status: 200, json: async () => ({ success: true, data: baseStatus() }) });
    await firstCall;

    await waitFor(() => expect(result.current.busy).toBeNull());
  });

  it('enabled:false performs no initial GET', async () => {
    renderHook(() => useObserverKey('s1', { enabled: false }));
    await new Promise((r) => setTimeout(r, 10));

    expect(csrfFetchMock).not.toHaveBeenCalled();
  });

  it('does not update state after unmount', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let resolveGet: (v: unknown) => void = () => {};
    csrfFetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveGet = resolve;
      }),
    );

    const { unmount } = renderHook(() => useObserverKey('s1'));
    unmount();

    resolveGet({ ok: true, status: 200, json: async () => ({ success: true, data: baseStatus() }) });
    await new Promise((r) => setTimeout(r, 10));

    // A cancelledRef-guarded setState after unmount never fires, so React
    // never logs the "not wrapped in act(...)" warning for this hook.
    const actWarning = errorSpy.mock.calls.some((args) =>
      String(args[0]).includes('not wrapped in act'),
    );
    expect(actWarning).toBe(false);
    errorSpy.mockRestore();
  });

  it('recovers after a disable→enable cycle — cancelledRef resets on effect re-run (PR #4471 finding 2)', async () => {
    csrfFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: baseStatus({ stored: true, publicKey: 'AB'.repeat(32) }) }),
    });

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useObserverKey('s1', { enabled }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.status?.stored).toBe(true));

    // Disable (cleanup sets cancelledRef true), then re-enable. Without the
    // reset at effect start, every response after this point is dropped and
    // the hook is dead forever.
    rerender({ enabled: false });
    rerender({ enabled: true });

    await waitFor(() => expect(result.current.status?.stored).toBe(true));
    // A mutation after the cycle must also still land.
    csrfFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: baseStatus({ stored: false }) }),
    });
    await result.current.clearKey();
    await waitFor(() => expect(result.current.status?.stored).toBe(false));
  });
});
