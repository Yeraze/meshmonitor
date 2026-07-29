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
import { paddedHexId, type TracerouteStripGraph } from './tracerouteStrip';
import type { TracerouteStripNodeMeta } from '../components/traceroute/TracerouteStrip';
import { getEffectiveHops } from './nodeHops';
import { getNodeTypeCategory } from './nodeTypeCategory';
import { getRoleName } from './nodeHelpers';
import { toNodeCardModel } from '../components/map/popups/nodeCardModel';

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
    // One meta entry per nodeNum: the same node can appear as several
    // StripNodes (an in-leg loop, or occurrences across the forward/spine/
    // return lanes), and they all render from the same metadata.
    if (meta.has(nodeNum)) continue;

    const node = byNodeNum.get(nodeNum);
    if (!node) continue; // no map entry — component renders the unknown placeholder

    const shortName = node.user?.shortName?.trim() || paddedHexId(nodeNum).slice(-4);
    const longName = node.user?.longName?.trim() || null;
    const roleLabel = getRoleName(node.user?.role);
    const nodeId = node.user?.id || paddedHexId(nodeNum);
    // Display id vs. actionable id. `nodeId` falls back to a synthesised hex
    // string so the card always shows something; `userId` is present ONLY when
    // the node really has a user record, because it is what
    // `setSelectedDMNode` keys the details panel off
    // (MessagesTab: `nodes.find(n => n.user?.id === selectedDMNode)`).
    // A synthesised id there opens an empty panel.
    const userId = node.user?.id || undefined;
    const category = getNodeTypeCategory(node);
    const hops = getEffectiveHops(node, opts.hopsCalculation, opts.traceroutes, opts.currentNodeNum);
    const unmessagable = !!node.isUnmessagable;

    // The hover popup renders the same card the Map page shows, so build its
    // view-model here rather than in the component: this adapter is the only
    // layer that holds a `DeviceInfo`, and keeping the conversion here is what
    // lets `TracerouteStrip` stay a pure function of plain data.
    const pos =
      node.position?.latitude != null && node.position?.longitude != null
        ? { lat: node.position.latitude, lng: node.position.longitude }
        : undefined;
    const card = toNodeCardModel(node, 'meshtastic', { effectiveHops: hops, pos });

    meta.set(nodeNum, {
      nodeNum,
      shortName,
      longName,
      roleLabel,
      nodeId,
      userId,
      category,
      hops,
      unmessagable,
      card,
      pos,
    });
  }

  return meta;
}
