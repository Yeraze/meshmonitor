/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useTranslationSettings, useTranslationEnabled } from './useTranslationSettings';
import apiService from '../services/api';

vi.mock('../services/api', () => ({
  default: {
    get: vi.fn(),
  },
}));

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

describe('useTranslationSettings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('defaults to enabled: false when translationEnabled is absent or false', async () => {
    vi.mocked(apiService.get).mockResolvedValue({ translationEnabled: 'false' });
    const { result } = renderHook(() => useTranslationSettings(), { wrapper });
    await waitFor(() => expect(result.current.enabled).toBe(false));
  });

  it('returns enabled: true when translationEnabled is "true"', async () => {
    vi.mocked(apiService.get).mockResolvedValue({
      translationEnabled: 'true',
      translationDefaultLanguage: 'es',
      translationDefaultOutgoingLanguage: 'de',
    });
    const { result } = renderHook(() => useTranslationSettings(), { wrapper });
    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
      expect(result.current.defaultLanguage).toBe('es');
      expect(result.current.defaultOutgoingLanguage).toBe('de');
    });
  });

  it('useTranslationEnabled returns boolean matching translationEnabled', async () => {
    vi.mocked(apiService.get).mockResolvedValue({ translationEnabled: 'true' });
    const { result } = renderHook(() => useTranslationEnabled(), { wrapper });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('defaults to false when settings map is empty', async () => {
    vi.mocked(apiService.get).mockResolvedValue({});
    const { result } = renderHook(() => useTranslationEnabled(), { wrapper });
    await waitFor(() => expect(apiService.get).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });
});
