/**
 * useTracerouteConfirmedLinks — reciprocal links confirmed by traceroute
 * (#5580), the sibling overlay of the cross-source "heard here" edges.
 *
 * One fetch of `/api/analysis/cross-source-links/traceroute-confirmed`.
 * Disabled (no request at all) while either map toggle is off. The server has
 * already applied the nodes + traceroute read rule and the position privacy
 * gates, so every returned link is drawable as-is.
 *
 * Refreshes once a minute while enabled: an HTTP poll of stored traceroutes.
 * It never asks a node for a traceroute.
 */
import { useMemo } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { fetchTracerouteConfirmedLinks } from '../services/analysisApi';
import type { TracerouteConfirmedLinkDto, TracerouteConfirmedLinksResponse } from '../types/crossSourceLinks';
import type { Line3DFeature } from '../components/map/Base3DMap';
import { tracerouteConfirmedLinkStyle } from '../utils/crossSourceLinkStyle';

export const TRACEROUTE_CONFIRMED_LINKS_REFETCH_MS = 60_000;

export interface UseTracerouteConfirmedLinksArgs {
  enabled: boolean;
  /** Limit to these sources; empty = every source the caller may read. */
  sources: string[];
  lookbackHours: number;
}

export function useTracerouteConfirmedLinks(
  args: UseTracerouteConfirmedLinksArgs,
): UseQueryResult<TracerouteConfirmedLinksResponse> {
  return useQuery({
    queryKey: ['analysis', 'tracerouteConfirmedLinks', args.sources, args.lookbackHours],
    enabled: args.enabled,
    refetchInterval: args.enabled ? TRACEROUTE_CONFIRMED_LINKS_REFETCH_MS : false,
    queryFn: ({ signal }) =>
      fetchTracerouteConfirmedLinks({
        sources: args.sources,
        sinceMs: args.lookbackHours > 0 ? Date.now() - args.lookbackHours * 3_600_000 : 0,
        signal,
      }),
  });
}

/** Confirmed links -> Base3DMap line features (same style as the 2D layer, no arrowheads). */
export function tracerouteConfirmedLinksTo3DLines(
  links: TracerouteConfirmedLinkDto[],
  nowMs: number,
  windowMs: number,
): Line3DFeature[] {
  return links.map((link) => {
    const style = tracerouteConfirmedLinkStyle(link, nowMs, windowMs);
    return {
      key: `trc:${link.key}`,
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
export function use3DTracerouteConfirmedLines(args: UseTracerouteConfirmedLinksArgs): Line3DFeature[] {
  const { data } = useTracerouteConfirmedLinks(args);
  return useMemo(
    () =>
      args.enabled && data
        ? tracerouteConfirmedLinksTo3DLines(data.links, Date.now(), Math.max(1, Date.now() - data.sinceMs))
        : [],
    [args.enabled, data],
  );
}
