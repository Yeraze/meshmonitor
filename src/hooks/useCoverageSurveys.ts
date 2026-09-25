/**
 * useCoverageSurveys — TanStack Query hooks for Coverage Report saved
 * surveys (#5277 P4b WP3, COVERAGE_P4_SPEC.md §2b.7). Thin wrappers over the
 * `src/services/analysisApi.ts` survey fetchers, which already unwrap
 * `body.data` for the `ok()`-enveloped `/api/analysis/coverage/surveys*`
 * routes (built in parallel, WP2).
 *
 * Query key: `['analysis', 'coverageReport', 'surveys']` — under the same
 * `coverageReport` namespace `useCoverageData.ts` uses (deliberately not
 * `['analysis', 'coverage', ...]`, which the unrelated coverage-grid heatmap
 * owns). One key, not parameterised: the list is small (caps of 50/user,
 * 500 total, U4) and server-filtered by visibility, so there is no per-filter
 * cache to keep separate — every mutation below invalidates the same key.
 *
 * Kept in its own file rather than folded into `useCoverageData.ts` per the
 * P4b WP ownership split (COVERAGE_P4_SPEC.md §4): P4a's file owns no server
 * route that didn't exist before P4b.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  fetchCoverageSurveys,
  createCoverageSurvey,
  updateCoverageSurvey,
  stopCoverageSurvey,
  deleteCoverageSurvey,
} from '../services/analysisApi';
import type {
  CoverageSurveyDto,
  CreateCoverageSurveyBody,
  UpdateCoverageSurveyBody,
} from '../types/coverage';

export const COVERAGE_SURVEYS_QUERY_KEY = ['analysis', 'coverageReport', 'surveys'] as const;

export function useCoverageSurveys(): UseQueryResult<CoverageSurveyDto[]> {
  return useQuery({
    queryKey: COVERAGE_SURVEYS_QUERY_KEY,
    queryFn: ({ signal }) => fetchCoverageSurveys({ signal }),
  });
}

export function useCreateSurvey(): UseMutationResult<CoverageSurveyDto, unknown, CreateCoverageSurveyBody> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCoverageSurveyBody) => createCoverageSurvey(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: COVERAGE_SURVEYS_QUERY_KEY });
    },
  });
}

export interface UpdateSurveyArgs {
  id: string;
  body: UpdateCoverageSurveyBody;
}

export function useUpdateSurvey(): UseMutationResult<CoverageSurveyDto, unknown, UpdateSurveyArgs> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: UpdateSurveyArgs) => updateCoverageSurvey(id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: COVERAGE_SURVEYS_QUERY_KEY });
    },
  });
}

export function useStopSurvey(): UseMutationResult<CoverageSurveyDto, unknown, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => stopCoverageSurvey(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: COVERAGE_SURVEYS_QUERY_KEY });
    },
  });
}

export function useDeleteSurvey(): UseMutationResult<void, unknown, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteCoverageSurvey(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: COVERAGE_SURVEYS_QUERY_KEY });
    },
  });
}
