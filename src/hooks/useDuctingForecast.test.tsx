/**
 * @vitest-environment jsdom
 *
 * useDuctingForecast (#5734, #5972): asks for one step, and only for one
 * source's area when the caller passes `sourceId` (the MeshCore map).
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ductingForecastQueryKey, useDuctingForecast } from './useDuctingForecast';

const get = vi.hoisted(() => vi.fn());
vi.mock('../services/api', () => ({ default: { get } }));

function wrapper() {
  const client = new QueryClient();
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useDuctingForecast', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue({ success: true, data: { forecastHour: 6 } });
  });

  it('asks for the default area without a sourceId', async () => {
    const { result } = renderHook(() => useDuctingForecast(6, true), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(get).toHaveBeenCalledWith('/api/ducting/forecast?hoursAhead=6');
  });

  it("asks for one source's area with a sourceId", async () => {
    const { result } = renderHook(() => useDuctingForecast(6, true, 'src 1'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(get).toHaveBeenCalledWith('/api/ducting/forecast?hoursAhead=6&sourceId=src%201');
  });

  it('fetches nothing while disabled', () => {
    renderHook(() => useDuctingForecast(6, false, 'src-1'), { wrapper: wrapper() });
    expect(get).not.toHaveBeenCalled();
  });

  it('keys a scoped forecast apart from the default one', () => {
    expect(ductingForecastQueryKey(6)).toEqual(['ducting', 'forecast', 6]);
    expect(ductingForecastQueryKey(6, 'src-1')).toEqual(['ducting', 'forecast', 6, 'src-1']);
  });
});
