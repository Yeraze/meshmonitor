/**
 * Traceroute Visual Strip — `DeviceInfo[] -> Map<nodeNum, meta>` adapter
 * (issue #4381 WP4).
 *
 * Thin adapter kept out of `TracerouteStrip.tsx` (which takes plain data, no
 * `DeviceInfo`) and out of `src/utils/tracerouteStrip.ts` (which stays
 * `DeviceInfo`-free per its own module banner). See
 * docs/internal/dev-notes/TRACEROUTE_VISUAL_STRIP_SPEC.md §5.1.
 */
import type { DeviceInfo } from '../types/device';
import type { NodeHopsCalculation } from '../contexts/SettingsContext';
import type { TracerouteStripGraph } from './tracerouteStrip';
import type { TracerouteStripNodeMeta } from '../components/traceroute/TracerouteStrip';
import { getEffectiveHops } from './nodeHops';
import { getNodeTypeCategory } from './nodeTypeCategory';
import { getRoleName } from './nodeHelpers';

/** Structural subset of a traceroute row — the same shape `getEffectiveHops`
 *  needs for its `'traceroute'` calculation mode. */
export interface TracerouteStripMetaTraceroute {
  fromNodeNum: number;
  toNodeNum: number;
  route: string | null;
  routeBack: string | null;
}

export interface BuildStripNodeMetaOptions {
  hopsCalculation: NodeHopsCalculation;
  traceroutes: TracerouteStripMetaTraceroute[];
  currentNodeNum: number | null;
}

/** "!a1b2c3d4" fallback node id — padded hex, matching `TracerouteStrip.tsx`'s
 *  own placeholder-node fallback. */
function paddedHexId(nodeNum: number): string {
  return `!${nodeNum.toString(16).padStart(8, '0')}`;
}

/**
 * Build the `nodeNum -> TracerouteStripNodeMeta` lookup the strip needs to
 * render, for exactly the node numbers appearing in `graph`.
 *
 * Indexes `nodes` into a `Map` once, then looks up only `graph.nodes` — O(n +
 * m), never an O(n·m) `find` per hop (spec §5.1, asserted by a perf-smoke
 * test).
 */
export function buildStripNodeMeta(
  graph: TracerouteStripGraph,
  nodes: DeviceInfo[],
  opts: BuildStripNodeMetaOptions,
): Map<number, TracerouteStripNodeMeta> {
  const byNodeNum = new Map<number, DeviceInfo>();
  for (const node of nodes) {
    if (typeof node.nodeNum === 'number') {
      byNodeNum.set(node.nodeNum, node);
    }
  }

  const meta = new Map<number, TracerouteStripNodeMeta>();

  for (const stripNode of graph.nodes) {
    const nodeNum = stripNode.nodeNum;
    if (meta.has(nodeNum)) continue; // dedup across row0/row1 occurrences

    const node = byNodeNum.get(nodeNum);
    if (!node) continue; // no map entry — component renders the unknown placeholder

    const shortName = node.user?.shortName?.trim() || paddedHexId(nodeNum).slice(-4);
    const longName = node.user?.longName?.trim() || null;
    const roleLabel = getRoleName(node.user?.role);
    const nodeId = node.user?.id || paddedHexId(nodeNum);
    const category = getNodeTypeCategory(node);
    const hops = getEffectiveHops(node, opts.hopsCalculation, opts.traceroutes, opts.currentNodeNum);
    const unmessagable = !!node.isUnmessagable;

    meta.set(nodeNum, {
      nodeNum,
      shortName,
      longName,
      roleLabel,
      nodeId,
      category,
      hops,
      unmessagable,
    });
  }

  return meta;
}
