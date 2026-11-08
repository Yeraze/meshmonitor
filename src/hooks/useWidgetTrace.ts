/**
 * useWidgetTrace — one normalised "last trace to this node" for the Dashboard
 * Traceroute widget, whatever the source protocol (#6263 S6).
 *
 * - Meshtastic wraps `useTraceroutes()` (the poll cache) and parses the stored
 *   `route` / `snrTowards` JSON.
 * - MeshCore wraps P5's `GET /api/sources/:id/meshcore/hop-snr/latest-trace`.
 *   A MeshCore trace has a forward path only, so `back` is always null.
 *
 * Both return the same `WidgetTrace`, so the widget draws text hops and the
 * shared `RouteFlowMap` from one code path.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '../services/api';
import { useTraceroutes } from './useTraceroutes';
import type { PollTraceroute } from './usePoll';
import type { MapNodeInfo } from '../types/device';
import {
  parseSnapshotRoutePositions,
  hasReturnPath,
  isValidRouteNode,
  BROADCAST_ADDR,
} from '../utils/tracerouteSegments';

/** One stop on a trace: an endpoint or a relay. */
export interface WidgetTraceHop {
  /** Stable identity: `!hex` nodeId (Meshtastic) or lowercase public key / `h:<hash>` (MeshCore). */
  key: string;
  label: string;
  /** dB; null when unknown. */
  snr: number | null;
  lat: number | null;
  lon: number | null;
}

export interface WidgetTrace {
  /** ms epoch */
  timestamp: number;
  /** Sender -> relays -> target, endpoints included. */
  forward: WidgetTraceHop[];
  /** Return leg, or null when the trace has none. */
  back: WidgetTraceHop[] | null;
}

type WidgetNode = MapNodeInfo;

const nodeIdOf = (nodeNum: number): string => `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`;

const nodeLabel = (node: WidgetNode | undefined, fallback: string): string =>
  node?.user?.longName || node?.user?.shortName || fallback;

function nodeLatLon(node: WidgetNode | undefined): [number, number] | null {
  const p = node?.position;
  if (!p) return null;
  if (p.latitudeI && p.longitudeI) return [p.latitudeI / 1e7, p.longitudeI / 1e7];
  if (typeof p.latitude === 'number' && typeof p.longitude === 'number') return [p.latitude, p.longitude];
  return null;
}

/** Route JSON -> hops with /4-scaled SNR; reserved node numbers are dropped (BROADCAST_ADDR stays). */
function parseRoute(routeJson: string | null | undefined, snrJson?: string): { nodeNum: number; snr: number | null }[] {
  if (!routeJson || routeJson === 'null') return [];
  try {
    const route = JSON.parse(routeJson) as number[];
    const snrs = snrJson ? (JSON.parse(snrJson) as number[]) : [];
    const out: { nodeNum: number; snr: number | null }[] = [];
    route.forEach((nodeNum, idx) => {
      if (nodeNum === BROADCAST_ADDR || isValidRouteNode(nodeNum)) {
        out.push({ nodeNum, snr: snrs[idx] !== undefined ? snrs[idx] / 4 : null });
      }
    });
    return out;
  } catch {
    return [];
  }
}

/** Pure: a stored Meshtastic traceroute -> WidgetTrace. Names and positions come from `nodes`. */
export function buildMeshtasticWidgetTrace(tr: PollTraceroute, nodes: Map<string, WidgetNode>): WidgetTrace {
  const snapshot = parseSnapshotRoutePositions(tr.routePositions);
  const hop = (nodeNum: number, snr: number | null): WidgetTraceHop => {
    const id = nodeIdOf(nodeNum);
    const node = nodes.get(id);
    const pos = snapshot.get(nodeNum) ?? nodeLatLon(node);
    return {
      key: id,
      label: nodeNum === BROADCAST_ADDR ? 'Unknown' : nodeLabel(node, id),
      snr,
      lat: pos ? pos[0] : null,
      lon: pos ? pos[1] : null,
    };
  };
  const leg = (from: number, to: number, hops: { nodeNum: number; snr: number | null }[]): WidgetTraceHop[] => [
    hop(from, null),
    ...hops.map((h) => hop(h.nodeNum, h.snr)),
    hop(to, hops.length > 0 ? hops[hops.length - 1].snr : null),
  ];
  const fwd = parseRoute(tr.route, tr.snrTowards);
  const back = parseRoute(tr.routeBack, tr.snrBack);
  const hasReturn = hasReturnPath(back.map((h) => h.nodeNum), tr.snrBack);
  return {
    timestamp: tr.timestamp || tr.createdAt || 0,
    forward: leg(tr.fromNodeNum, tr.toNodeNum, fwd),
    back: hasReturn ? leg(tr.toNodeNum, tr.fromNodeNum, back) : null,
  };
}

/** Raw hop as `latest-trace` returns it. */
export interface LatestTraceHop {
  hopIndex: number;
  receiverPublicKey: string | null;
  receiverHash: string | null;
  snr: number;
}

/** Resolve a hop to a known node: the full key, else a hash prefix that matches exactly one node. */
function resolveMeshCoreHop(hop: LatestTraceHop, nodes: Map<string, WidgetNode>): { id: string; node?: WidgetNode } {
  if (hop.receiverPublicKey) {
    const id = hop.receiverPublicKey.toLowerCase();
    return { id, node: nodes.get(id) };
  }
  const hash = (hop.receiverHash ?? '').toLowerCase();
  const matches: string[] = [];
  for (const id of nodes.keys()) {
    if (id.toLowerCase().startsWith(hash)) matches.push(id);
  }
  if (hash && matches.length === 1) return { id: matches[0].toLowerCase(), node: nodes.get(matches[0]) };
  return { id: `h:${hash}` };
}

/** Pure: a MeshCore `latest-trace` -> WidgetTrace (forward path only). */
export function buildMeshCoreWidgetTrace(
  trace: { timestamp: number; hops: LatestTraceHop[] },
  nodes: Map<string, WidgetNode>,
  currentNodeId: string | null,
  targetNodeId: string,
): WidgetTrace {
  const toHop = (id: string, node: WidgetNode | undefined, snr: number | null, fallback: string): WidgetTraceHop => {
    const pos = nodeLatLon(node);
    return { key: id, label: nodeLabel(node, fallback), snr, lat: pos ? pos[0] : null, lon: pos ? pos[1] : null };
  };
  const forward: WidgetTraceHop[] = [];
  if (currentNodeId) {
    const id = currentNodeId.toLowerCase();
    forward.push(toHop(id, nodes.get(currentNodeId) ?? nodes.get(id), null, id.slice(0, 8)));
  }
  // Rows with no receiver are the link into our own radio.
  const hops = trace.hops
    .filter((h) => h.receiverPublicKey || h.receiverHash)
    .sort((a, b) => a.hopIndex - b.hopIndex);
  for (const h of hops) {
    const r = resolveMeshCoreHop(h, nodes);
    forward.push(toHop(r.id, r.node, h.snr, r.id.startsWith('h:') ? `#${r.id.slice(2)}` : r.id.slice(0, 8)));
  }
  const target = targetNodeId.toLowerCase();
  const last = forward[forward.length - 1];
  if (!last || last.key !== target) {
    forward.push(toHop(target, nodes.get(targetNodeId) ?? nodes.get(target), null, target.slice(0, 8)));
  }
  return { timestamp: trace.timestamp, forward, back: null };
}

interface LatestTraceResponse {
  data?: { trace?: { timestamp: number; hops?: LatestTraceHop[] } | null };
}

export interface UseWidgetTraceOptions {
  sourceId: string | null | undefined;
  targetNodeId: string | null;
  currentNodeId: string | null;
  nodes: Map<string, WidgetNode>;
}

export function useWidgetTrace(
  kind: 'meshtastic' | 'meshcore' | 'reticulum',
  { sourceId, targetNodeId, currentNodeId, nodes }: UseWidgetTraceOptions,
): { trace: WidgetTrace | null; isLoading: boolean } {
  // Both hooks run every render (rules of hooks); the one that does not match
  // `kind` is inert.
  const { traceroutes, isLoading: pollLoading } = useTraceroutes();

  const meshcoreEnabled = kind === 'meshcore' && !!sourceId && !!targetNodeId;
  const stored = useQuery({
    queryKey: ['widgetTrace', sourceId, targetNodeId] as const,
    queryFn: async () => {
      const res = await api.get<LatestTraceResponse>(
        `/api/sources/${encodeURIComponent(sourceId as string)}/meshcore/hop-snr/latest-trace?publicKey=${encodeURIComponent(targetNodeId as string)}`,
      );
      return res?.data?.trace ?? null;
    },
    enabled: meshcoreEnabled,
    staleTime: 30_000,
    retry: false,
  });

  return useMemo(() => {
    if (kind === 'meshtastic') {
      if (!targetNodeId) return { trace: null, isLoading: false };
      const tr = traceroutes.find((x) => x.toNodeId === targetNodeId || x.fromNodeId === targetNodeId);
      return { trace: tr ? buildMeshtasticWidgetTrace(tr, nodes) : null, isLoading: pollLoading };
    }
    if (kind === 'meshcore') {
      const raw = stored.data;
      if (!meshcoreEnabled || !raw) return { trace: null, isLoading: meshcoreEnabled && stored.isLoading };
      return {
        trace: buildMeshCoreWidgetTrace(
          { timestamp: raw.timestamp, hops: raw.hops ?? [] },
          nodes,
          currentNodeId,
          targetNodeId as string,
        ),
        isLoading: false,
      };
    }
    return { trace: null, isLoading: false };
  }, [kind, targetNodeId, traceroutes, nodes, pollLoading, stored.data, stored.isLoading, meshcoreEnabled, currentNodeId]);
}
