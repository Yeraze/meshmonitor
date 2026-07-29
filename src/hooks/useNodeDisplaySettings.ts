/**
 * The ten Node Display settings, source-scoped (epic #4412 Phase 3 WP1).
 *
 * Built on `useElevationEnabled`'s pattern: a bare (non-`{success,data}`
 * enveloped) `GET /api/settings` response, read through a TanStack query.
 *
 * Two surfaces:
 * - `useNodeDisplaySettings(sourceId)` — the ten values for ONE source.
 *   `sourceId === null` returns the hardcoded defaults and issues **no**
 *   network request (the interview's "no runtime global fallback" — see
 *   `nodeDisplayDefaults.ts`).
 * - `useMaxNodeAgeHoursAcross(sourceIds)` — the most-permissive
 *   `maxNodeAgeHours` across N sources (D3), for the two cross-source
 *   surfaces (Map Analysis, the Dashboard map) that merge nodes from
 *   multiple sources onto one view. Any single-value answer is wrong for
 *   someone; "never hide a node that a source-scoped view would show" is the
 *   only rule that cannot lose data.
 */
import { useQueries, useQuery } from '@tanstack/react-query';
import apiService from '../services/api';
import {
  NODE_DISPLAY_NUMERIC_DEFAULTS,
  NODE_DISPLAY_STRING_DEFAULTS,
  parseNodeDisplayNumber,
  parseNodeDisplayBoolean,
} from '../constants/nodeDisplayDefaults';
import type { NodeHopsCalculation } from '../contexts/SettingsContext';

export interface NodeDisplaySettings {
  maxNodeAgeHours: number;
  inactiveNodeThresholdHours: number;
  inactiveNodeCheckIntervalMinutes: number;
  inactiveNodeCooldownHours: number;
  localStatsIntervalMinutes: number;
  nodeHopsCalculation: NodeHopsCalculation;
  hideIncompleteNodes: boolean;
  nodeDimmingEnabled: boolean;
  nodeDimmingStartHours: number;
  nodeDimmingMinOpacity: number;
}

const VALID_NODE_HOPS_CALCULATIONS: readonly NodeHopsCalculation[] = [
  'nodeinfo',
  'traceroute',
  'messages',
];

function parseNodeHopsCalculation(raw: string | undefined): NodeHopsCalculation {
  if (raw && (VALID_NODE_HOPS_CALCULATIONS as readonly string[]).includes(raw)) {
    return raw as NodeHopsCalculation;
  }
  return NODE_DISPLAY_STRING_DEFAULTS.nodeHopsCalculation as NodeHopsCalculation;
}

/** Parse a raw `/api/settings` map into the ten values. Exported for testing. */
export function parseNodeDisplaySettings(
  raw: Record<string, string> | undefined,
): NodeDisplaySettings {
  return {
    maxNodeAgeHours: parseNodeDisplayNumber('maxNodeAgeHours', raw?.maxNodeAgeHours),
    inactiveNodeThresholdHours: parseNodeDisplayNumber(
      'inactiveNodeThresholdHours',
      raw?.inactiveNodeThresholdHours,
    ),
    inactiveNodeCheckIntervalMinutes: parseNodeDisplayNumber(
      'inactiveNodeCheckIntervalMinutes',
      raw?.inactiveNodeCheckIntervalMinutes,
    ),
    inactiveNodeCooldownHours: parseNodeDisplayNumber(
      'inactiveNodeCooldownHours',
      raw?.inactiveNodeCooldownHours,
    ),
    localStatsIntervalMinutes: parseNodeDisplayNumber(
      'localStatsIntervalMinutes',
      raw?.localStatsIntervalMinutes,
    ),
    nodeHopsCalculation: parseNodeHopsCalculation(raw?.nodeHopsCalculation),
    hideIncompleteNodes: parseNodeDisplayBoolean('hideIncompleteNodes', raw?.hideIncompleteNodes),
    nodeDimmingEnabled: parseNodeDisplayBoolean('nodeDimmingEnabled', raw?.nodeDimmingEnabled),
    nodeDimmingStartHours: parseNodeDisplayNumber(
      'nodeDimmingStartHours',
      raw?.nodeDimmingStartHours,
    ),
    nodeDimmingMinOpacity: parseNodeDisplayNumber(
      'nodeDimmingMinOpacity',
      raw?.nodeDimmingMinOpacity,
    ),
  };
}

function nodeDisplaySettingsQueryKey(sourceId: string | null) {
  return ['settings', 'node-display', sourceId] as const;
}

function fetchNodeDisplayRaw(sourceId: string | null): Promise<Record<string, string>> {
  const sourceQuery = sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : '';
  return apiService.get<Record<string, string>>(`/api/settings${sourceQuery}`);
}

/**
 * The ten Node Display values for ONE source.
 * `sourceId === null` → hardcoded defaults, and **no request is issued**
 * (`enabled: sourceId != null`) — the interview's "no runtime global
 * fallback".
 */
export function useNodeDisplaySettings(sourceId: string | null): NodeDisplaySettings {
  const { data } = useQuery({
    queryKey: nodeDisplaySettingsQueryKey(sourceId),
    queryFn: () => fetchNodeDisplayRaw(sourceId),
    staleTime: 60_000,
    enabled: sourceId != null,
  });
  return parseNodeDisplaySettings(data);
}

/**
 * Most-permissive `maxNodeAgeHours`: exported pure helper, per
 * `pickPrimarySource`'s convention (`useResolvedSourceId.ts`).
 * Empty list → the hardcoded default.
 */
export function maxAcross(values: number[]): number {
  if (values.length === 0) return NODE_DISPLAY_NUMERIC_DEFAULTS.maxNodeAgeHours;
  return Math.max(...values);
}

/**
 * Most-permissive `maxNodeAgeHours` across N sources, for cross-source
 * surfaces (D3). Empty list or all-loading → the hardcoded default. A
 * source that is still loading does not drag the max down — it is excluded
 * from the computation entirely rather than treated as its default value.
 */
export function useMaxNodeAgeHoursAcross(sourceIds: string[]): number {
  // Sorted + de-duplicated so the query set is stable across re-renders
  // (same discipline as useDashboardData.ts's `sourcesKey`).
  const stableIds = Array.from(new Set(sourceIds)).sort();

  const results = useQueries({
    queries: stableIds.map((id) => ({
      queryKey: nodeDisplaySettingsQueryKey(id),
      queryFn: () => fetchNodeDisplayRaw(id),
      staleTime: 60_000,
    })),
  });

  const loadedValues = results
    .filter((r) => r.data !== undefined)
    .map((r) => parseNodeDisplayNumber('maxNodeAgeHours', r.data?.maxNodeAgeHours));

  return maxAcross(loadedValues);
}
