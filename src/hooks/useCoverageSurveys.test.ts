/**
 * useCoverageSurveys — #5277 P4b WP3.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import {
  useCoverageSurveys,
  useCreateSurvey,
  useUpdateSurvey,
  useStopSurvey,
  useDeleteSurvey,
  COVERAGE_SURVEYS_QUERY_KEY,
} from './useCoverageSurveys';
import type { CoverageSurveyDto } from '../types/coverage';

const fetchCoverageSurveys = vi.fn();
const createCoverageSurvey = vi.fn();
const updateCoverageSurvey = vi.fn();
const stopCoverageSurvey = vi.fn();
const deleteCoverageSurvey = vi.fn();

vi.mock('../services/analysisApi', () => ({
  fetchCoverageSurveys: (...args: unknown[]) => fetchCoverageSurveys(...args),
  createCoverageSurvey: (...args: unknown[]) => createCoverageSurvey(...args),
  updateCoverageSurvey: (...args: unknown[]) => updateCoverageSurvey(...args),
  stopCoverageSurvey: (...args: unknown[]) => stopCoverageSurvey(...args),
  deleteCoverageSurvey: (...args: unknown[]) => deleteCoverageSurvey(...args),
}));

function makeSurvey(overrides: Partial<CoverageSurveyDto> = {}): CoverageSurveyDto {
  return {
    id: 'survey-1',
    name: 'Test survey',
    senderId: '!aaaaaaaa',
    startAt: 1_700_000_000_000,
    endAt: null,
    receivers: null,
    intervalSec: null,
    notes: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    effectiveEndAt: 1_700_000_000_000,
    isLive: true,
    canEdit: true,
    createdByMe: true,
    ...overrides,
  };
}

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    client,
    wrapper: function Wrapper({ children }: { children: React.ReactNode }) {
      return createElement(QueryClientProvider, { client }, children);
    },
  };
}

describe('useCoverageSurveys hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches the survey list under the coverageReport query key', async () => {
    const survey = makeSurvey();
    fetchCoverageSurveys.mockResolvedValue([survey]);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useCoverageSurveys(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([survey]);
    expect(fetchCoverageSurveys).toHaveBeenCalledTimes(1);
  });

  it('useCreateSurvey invalidates the survey list on success', async () => {
    const survey = makeSurvey();
    createCoverageSurvey.mockResolvedValue(survey);
    fetchCoverageSurveys.mockResolvedValue([survey]);
    const { client, wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useCreateSurvey(), { wrapper });
    result.current.mutate({ name: 'New survey', senderId: '!aaaaaaaa', live: true });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(createCoverageSurvey).toHaveBeenCalledWith({ name: 'New survey', senderId: '!aaaaaaaa', live: true });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: COVERAGE_SURVEYS_QUERY_KEY });
  });

  it('useUpdateSurvey passes id + body through and invalidates on success', async () => {
    const survey = makeSurvey({ name: 'Renamed' });
    updateCoverageSurvey.mockResolvedValue(survey);
    const { client, wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateSurvey(), { wrapper });
    result.current.mutate({ id: 'survey-1', body: { name: 'Renamed' } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(updateCoverageSurvey).toHaveBeenCalledWith('survey-1', { name: 'Renamed' });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: COVERAGE_SURVEYS_QUERY_KEY });
  });

  it('useStopSurvey calls stopCoverageSurvey(id) and invalidates on success', async () => {
    const survey = makeSurvey({ endAt: 1_700_000_100_000, isLive: false });
    stopCoverageSurvey.mockResolvedValue(survey);
    const { client, wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useStopSurvey(), { wrapper });
    result.current.mutate('survey-1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(stopCoverageSurvey).toHaveBeenCalledWith('survey-1');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: COVERAGE_SURVEYS_QUERY_KEY });
  });

  it('useDeleteSurvey calls deleteCoverageSurvey(id) and invalidates on success', async () => {
    deleteCoverageSurvey.mockResolvedValue(undefined);
    const { client, wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useDeleteSurvey(), { wrapper });
    result.current.mutate('survey-1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(deleteCoverageSurvey).toHaveBeenCalledWith('survey-1');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: COVERAGE_SURVEYS_QUERY_KEY });
  });

  it('does not invalidate the survey list when a mutation fails', async () => {
    createCoverageSurvey.mockRejectedValue(new Error('boom'));
    const { client, wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useCreateSurvey(), { wrapper });
    result.current.mutate({ name: 'New survey', senderId: '!aaaaaaaa', live: true });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
