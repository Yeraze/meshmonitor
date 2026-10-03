/**
 * useCrossSourceLinks — cross-source "heard here" map edges (#5561).
 *
 * One fetch of `/api/analysis/cross-source-links` for the given sources and
 * lookback. Disabled (no request at all) while the map toggle is off. The
 * server already applies the two-source read rule and the position privacy
 * gates, so every returned edge is drawable as-is.
 *
 * Refreshes once a minute while enabled: an HTTP poll of an aggregate table,
 * nothing touches the mesh.
 */
import { useMemo } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { fetchCrossSourceLinks } from '../services/analysisApi';
import type { CrossSourceLinkDto, CrossSourceLinksResponse } from '../types/crossSourceLinks';
import type { Line3DFeature } from '../components/map/Base3DMap';
import { crossSourceLinkStyle } from '../utils/crossSourceLinkStyle';

export const CROSS_SOURCE_LINKS_REFETCH_MS = 60_000;

export interface UseCrossSourceLinksArgs {
  enabled: boolean;
  /** Keep edges touching one of these sources; empty = every readable source. */
  sources: string[];
  lookbackHours: number;
}

export function useCrossSourceLinks(args: UseCrossSourceLinksArgs): UseQueryResult<CrossSourceLinksResponse> {
  return useQuery({
    queryKey: ['analysis', 'crossSourceLinks', args.sources, args.lookbackHours],
    enabled: args.enabled,
    refetchInterval: args.enabled ? CROSS_SOURCE_LINKS_REFETCH_MS : false,
    queryFn: ({ signal }) =>
      fetchCrossSourceLinks({
        sources: args.sources,
        sinceMs: args.lookbackHours > 0 ? Date.now() - args.lookbackHours * 3_600_000 : 0,
        signal,
      }),
  });
}

/** Map edges -> Base3DMap line features (same styling rules as the 2D layer). */
export function crossSourceLinksTo3DLines(
  links: CrossSourceLinkDto[],
  nowMs: number,
  windowMs: number,
): Line3DFeature[] {
  return links.map((link) => {
    const style = crossSourceLinkStyle(link, nowMs, windowMs);
    return {
      key: `xs:${link.key}`,
      from: link.from,
      to: link.to,
      color: style.color,
      opacity: style.opacity,
      width: style.weight,
      dash: style.dash3d,
    };
  });
}

/** 3D lines for a host map; empty (and no fetch) while disabled. */
export function use3DCrossSourceLines(args: UseCrossSourceLinksArgs): Line3DFeature[] {
  const { data } = useCrossSourceLinks(args);
  return useMemo(
    () =>
      args.enabled && data
        ? crossSourceLinksTo3DLines(data.links, Date.now(), Math.max(1, Date.now() - data.sinceMs))
        : [],
    [args.enabled, data],
  );
}
