/**
 * Resolves a neighbor-link `SelectedTarget` into a `LinkEndpoint` pair, for
 * the Map Analysis inspector's terrain integration (epic #3826, Phase 1,
 * WP-1). Pure and react-free — consumes the unified node list already held
 * by `AnalysisInspectorPanel` (no new fetch).
 *
 * `SelectedTarget` (neighbor variant) carries only identifiers (nodeNum/
 * neighborNum or publicKey/neighborPublicKey) — not coordinates. This module
 * does the lookup against the unified node list plus the cross-source
 * position fallback the neighbor-link layers use (#3792), and shapes the
 * result into the exact `LinkEndpoint` fields `MapAnalysisCanvas`'s
 * `linkEndpointCandidates` produces, so `useAutoRadioDefaults` and the Link
 * Profile drawer treat it identically to a toolbar-picked endpoint.
 *
 * See docs/internal/dev-notes/NEIGHBOR_LINK_TERRAIN_SPEC.md §3.1.
 */
import type { LinkEndpoint } from '../../utils/linkProfile';
import type { SelectedTarget } from './MapAnalysisContext';
import { resolveNodeLatLng, type MaybePositionedNode } from './nodePositionUtil';

/** Minimal node shape the resolver needs (subset of useAnalysisNodes' NodeRecord). */
export interface EndpointNodeRecord extends MaybePositionedNode {
  nodeNum?: number;
  sourceId?: string;
  isMeshCore?: boolean;
  publicKey?: string | null;
  longName?: string | null;
  shortName?: string | null;
  sources?: Array<{ sourceId: string }>;
}

export interface NeighborEndpoints {
  a: LinkEndpoint;
  b: LinkEndpoint;
}

interface ResolvedNode {
  node: EndpointNodeRecord;
  latLng: [number, number];
}

/**
 * Finds the first positioned node matching `matches`, preferring one whose
 * `sourceId` equals `preferredSourceId` (the edge's reporting source) but
 * falling back to any other positioned match (#3792 cross-source fallback —
 * mirrors `NeighborLinksLayer`'s `positionByKey` → `positionByNode` pattern).
 * Unpositioned matches (no resolvable lat/lng) are skipped entirely.
 */
function findPositionedNode(
  nodes: EndpointNodeRecord[],
  matches: (n: EndpointNodeRecord) => boolean,
  preferredSourceId: string | undefined,
): ResolvedNode | null {
  let preferred: ResolvedNode | null = null;
  let fallback: ResolvedNode | null = null;
  for (const node of nodes) {
    if (!matches(node)) continue;
    const latLng = resolveNodeLatLng(node);
    if (!latLng) continue;
    if (preferredSourceId !== undefined && node.sourceId === preferredSourceId) {
      if (!preferred) preferred = { node, latLng };
    } else if (!fallback) {
      fallback = { node, latLng };
    }
  }
  return preferred ?? fallback;
}

function buildEndpoint(resolved: ResolvedNode, isMeshCore: boolean): LinkEndpoint {
  const { node, latLng } = resolved;
  return {
    id: isMeshCore
      ? `${node.sourceId ?? ''}:${node.publicKey ?? ''}`
      : `${node.sourceId ?? ''}:${node.nodeNum}`,
    lat: latLng[0],
    lng: latLng[1],
    isNode: true,
    sourceId: node.sourceId,
    sourceIds: node.sources?.map((s) => s.sourceId) ?? (node.sourceId ? [node.sourceId] : []),
    nodeNum: node.nodeNum,
    isMeshCore,
    label: node.shortName ?? undefined,
  };
}

/**
 * Build a LinkEndpoint pair for a selected neighbor link, or null when either
 * endpoint cannot be resolved to a rendered position. Meshtastic links key on
 * nodeNum with the #3792 cross-source fallback; MeshCore links key on
 * publicKey.
 */
export function resolveNeighborEndpoints(
  selected: SelectedTarget,
  nodes: EndpointNodeRecord[],
): NeighborEndpoints | null {
  if (selected.type !== 'neighbor') return null;

  const isMeshCore = !!selected.publicKey;

  const resolvedA = isMeshCore
    ? findPositionedNode(
        nodes,
        (n) => !!n.isMeshCore && n.publicKey === selected.publicKey,
        selected.sourceId,
      )
    : findPositionedNode(nodes, (n) => n.nodeNum === selected.nodeNum, selected.sourceId);

  const resolvedB = isMeshCore
    ? findPositionedNode(
        nodes,
        (n) => !!n.isMeshCore && n.publicKey === selected.neighborPublicKey,
        selected.sourceId,
      )
    : findPositionedNode(nodes, (n) => n.nodeNum === selected.neighborNum, selected.sourceId);

  if (!resolvedA || !resolvedB) return null;

  return {
    a: buildEndpoint(resolvedA, isMeshCore),
    b: buildEndpoint(resolvedB, isMeshCore),
  };
}
