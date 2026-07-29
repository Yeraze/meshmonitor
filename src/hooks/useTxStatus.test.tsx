/**
 * @vitest-environment jsdom
 *
 * useTxStatus send-gating (#4294 banner, #4394 UDP-broadcast relay).
 *
 * `isTxDisabled` must mean "sends are futile", not "the radio's TX flag is
 * off": a node with `lora.txEnabled=false` but `network.enabledProtocols &
 * UDP_BROADCAST` still reaches the mesh through a LAN peer that relays its
 * UDP broadcasts. That case reports `isUdpRelay` instead, so the UI can stay
 * honest about how packets leave without disabling the compose box.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useTxStatus } from './useTxStatus';

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

function mockTxStatus(body: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  }));
}

describe('useTxStatus', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('is not TX-disabled when the radio can transmit', async () => {
    mockTxStatus({ txEnabled: true, udpRelayEnabled: false, canTransmit: true });
    const { result } = renderHook(() => useTxStatus({ refetchInterval: 60000 }), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.isTxDisabled).toBe(false);
    expect(result.current.isUdpRelay).toBe(false);
  });

  it('is TX-disabled when neither the radio nor UDP broadcast can carry a send', async () => {
    mockTxStatus({ txEnabled: false, udpRelayEnabled: false, canTransmit: false });
    const { result } = renderHook(() => useTxStatus({ refetchInterval: 60000 }), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.isTxDisabled).toBe(true);
    expect(result.current.isUdpRelay).toBe(false);
  });

  it('is NOT TX-disabled when the radio is off but UDP broadcast relays (#4394)', async () => {
    mockTxStatus({ txEnabled: false, udpRelayEnabled: true, canTransmit: true });
    const { result } = renderHook(() => useTxStatus({ refetchInterval: 60000 }), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.isTxDisabled).toBe(false);
    expect(result.current.isUdpRelay).toBe(true);
  });

  it('falls back to txEnabled when an older server omits canTransmit', async () => {
    mockTxStatus({ txEnabled: false });
    const { result } = renderHook(() => useTxStatus({ refetchInterval: 60000 }), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.isTxDisabled).toBe(true);
    expect(result.current.isUdpRelay).toBe(false);
  });

  it('reports nothing disabled before the query resolves', () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    const { result } = renderHook(() => useTxStatus({ refetchInterval: 60000 }), { wrapper });
    expect(result.current.isTxDisabled).toBe(false);
    expect(result.current.isUdpRelay).toBe(false);
  });
});
