/**
 * `NodeCardModel` — the shared shape every popup-family section renders from,
 * plus `toNodeCardModel`, the single normalizer that maps a raw Meshtastic
 * node (flat unified-API shape OR nested `DeviceInfo`) or a raw MeshCore
 * contact into that shape.
 *
 * See docs/internal/dev-notes/MAP_CONSOLIDATION_P5_SPEC.md §2.3 (D6).
 *
 * `toNodeCardModel` is a plain function (no hooks) so it can run outside a
 * component. It therefore CANNOT call `useTranslation()`; the one string it
 * would otherwise want to translate — the "Node {{nodeNum}}" header fallback
 * used when a node has no name — is accepted as a pre-rendered
 * `opts.nodeFallbackLabel` instead. Consumers that want the translated
 * fallback (today only `NodePopup`, the chat overlay) build it with their own
 * `t('node_popup.node_fallback', { nodeNum })` and pass it in; consumers that
 * don't (NodesTab, DashboardNodePopup, MapAnalysis — today's non-i18n
 * `Node ${nodeNum}` behavior) simply omit it and get the same plain string.
 */
import { useMemo } from 'react';
import type { DbTraceroute } from '../../../services/database';
import { getHardwareModelName, getRoleName, parseNodeId, TRACEROUTE_DISPLAY_HOURS } from '../../../utils/nodeHelpers';

/** A single source that reported this node, attached by mergeUnifiedSourceData. */
export interface NodeSourceRef {
  sourceId: string;
  sourceName: string;
  protocol: 'Meshtastic' | 'MeshCore';
}

export interface NodeCardMeshCoreDetails {
  publicKey: string;
  rssi?: number;
  snr?: number;
  pathLen?: number | null;
  outPath?: string;
  /** Raw epoch-ms `lastSeen` as reported by the contact record. Prefer the
   *  model's top-level `lastHeard` (epoch seconds, unit-normalized across
   *  variants) for display via `LastHeardFooter`; this is kept for parity
   *  with the spec's literal field list / any consumer that wants the raw
   *  value. */
  lastSeen?: number;
}

export interface NodeCardModel {
  longName: string;
  shortName?: string;
  nodeId?: string;
  nodeNum?: number;
  roleName?: string | null;
  hwModelName?: string | null;
  hops?: number | null;
  snr?: number | null;
  battery?: number | null;
  altitude?: number | null;
  /** Meshtastic position precision (0-32 bits). Rendered as a human accuracy
   *  estimate ("~91 m") via `formatPrecisionAccuracy`; 0/null hidden. (#4176) */
  positionPrecisionBits?: number | null;
  /** Meshtastic `Position.location_source` (LocSource enum): 0=UNSET, 1=MANUAL,
   *  2=INTERNAL GPS, 3=EXTERNAL GPS. 0/null hidden. (#4176) */
  positionLocationSource?: number | null;
  position?: { lat: number; lng: number };
  /** Epoch SECONDS, normalized across variants (MeshCore's `lastSeen` is raw
   *  epoch-ms and is divided down when building this field). */
  lastHeard?: number | null;
  sources?: NodeSourceRef[];
  meshcore?: NodeCardMeshCoreDetails;
}

export type NodeCardVariant = 'meshtastic' | 'meshcore';

export interface ToNodeCardModelOptions {
  /** Consumer-computed effective hop count (e.g. NodesTab's `getEffectiveHops`).
   *  Takes priority over the raw node's `hopsAway` when provided. */
  effectiveHops?: number;
  /** Map coordinates to surface via `PositionItem` (Dashboard/MapAnalysis pass
   *  the Leaflet marker's `pos`; nodes without a caller-supplied position
   *  don't get a `position` field on the model). */
  pos?: { lat: number; lng: number };
  /** Pre-rendered "Node {{nodeNum}}" fallback (see file header comment).
   *  Defaults to the plain `Node ${nodeNum}` string used by the non-i18n
   *  renderers when omitted. */
  nodeFallbackLabel?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Coerce a field that may live on the flat node or its nested `user` — the
 *  same flat-or-nested coalescing `DashboardNodePopup`'s old local `pick()`
 *  did, generalized to also cover a strictly-nested `DeviceInfo` (where the
 *  flat key is simply always absent). */
function pick<T>(node: Record<string, unknown>, flatKey: string, userKey: string): T | undefined {
  const flat = node[flatKey];
  if (flat !== undefined && flat !== null) return flat as T;
  const user = node.user;
  if (!isRecord(user)) return undefined;
  const nested = user[userKey];
  return nested === null ? undefined : (nested as T | undefined);
}

function toMeshtasticModel(raw: unknown, opts?: ToNodeCardModelOptions): NodeCardModel {
  const node = isRecord(raw) ? raw : {};
  const nodeNum = typeof node.nodeNum === 'number' ? node.nodeNum : undefined;

  const longName = pick<string>(node, 'longName', 'longName')
    ?? opts?.nodeFallbackLabel
    ?? (nodeNum !== undefined ? `Node ${nodeNum}` : 'Unknown');
  const shortName = pick<string>(node, 'shortName', 'shortName');
  const nodeId = pick<string>(node, 'nodeId', 'id');

  const roleRaw = pick<number | string>(node, 'role', 'role');
  const roleName = roleRaw !== undefined ? getRoleName(roleRaw) : null;

  const hwModel = pick<number>(node, 'hwModel', 'hwModel');
  const hwModelName = hwModel !== undefined ? getHardwareModelName(hwModel) : null;

  const hopsAway = typeof node.hopsAway === 'number' ? node.hopsAway : undefined;
  const hops = opts?.effectiveHops ?? hopsAway ?? null;

  const snr = typeof node.snr === 'number' ? node.snr : null;

  const deviceMetrics = isRecord(node.deviceMetrics) ? node.deviceMetrics : undefined;
  const battery = typeof node.batteryLevel === 'number'
    ? node.batteryLevel
    : (typeof deviceMetrics?.batteryLevel === 'number' ? deviceMetrics.batteryLevel : null);

  const positionRaw = isRecord(node.position) ? node.position : undefined;
  const altitude = typeof node.altitude === 'number'
    ? node.altitude
    : (typeof positionRaw?.altitude === 'number' ? positionRaw.altitude : null);

  const lastHeard = typeof node.lastHeard === 'number' ? node.lastHeard : null;

  // Position accuracy + source live flat on the DeviceInfo (surfaced by the
  // server's mapDbNodeToDeviceInfo / dbNodeMapper). Display-only (#4176).
  const positionPrecisionBits = typeof node.positionPrecisionBits === 'number' ? node.positionPrecisionBits : null;
  const positionLocationSource = typeof node.positionLocationSource === 'number' ? node.positionLocationSource : null;

  const sources = Array.isArray(node.sources) ? (node.sources as NodeSourceRef[]) : undefined;

  return {
    longName,
    shortName,
    nodeId,
    nodeNum,
    roleName,
    hwModelName,
    hops,
    snr,
    battery,
    altitude,
    positionPrecisionBits,
    positionLocationSource,
    position: opts?.pos,
    lastHeard,
    sources,
  };
}

function toMeshCoreModel(raw: unknown): NodeCardModel {
  const c = isRecord(raw) ? raw : {};
  const publicKey = typeof c.publicKey === 'string' ? c.publicKey : '';
  const advName = typeof c.advName === 'string' ? c.advName : undefined;
  const name = typeof c.name === 'string' ? c.name : undefined;
  const rssi = typeof c.rssi === 'number' ? c.rssi : undefined;
  const snr = typeof c.snr === 'number' ? c.snr : undefined;
  const pathLen = typeof c.pathLen === 'number' ? c.pathLen : null;
  const outPath = typeof c.outPath === 'string' ? c.outPath : undefined;
  const lastSeen = typeof c.lastSeen === 'number' ? c.lastSeen : undefined;

  return {
    longName: advName || name || 'MeshCore',
    nodeId: publicKey || undefined,
    lastHeard: lastSeen !== undefined ? Math.floor(lastSeen / 1000) : null,
    meshcore: { publicKey, rssi, snr, pathLen, outPath, lastSeen },
  };
}

/**
 * Normalize a raw Meshtastic node or MeshCore contact into the shared
 * `NodeCardModel` the popup-family sections render from.
 */
export function toNodeCardModel(
  raw: unknown,
  variant: NodeCardVariant,
  opts?: ToNodeCardModelOptions,
): NodeCardModel {
  return variant === 'meshcore' ? toMeshCoreModel(raw) : toMeshtasticModel(raw, opts);
}

/**
 * Find the most recent traceroute (successful or failed) between two nodes
 * within the shared display window, newest first. Ports the identical logic
 * that lived inline in both `NodePopup` (L59 useMemo) and
 * `MapNodePopupContent` (L58 IIFE) into one memoized hook.
 */
export function useRecentTraceroute(
  traceroutes: DbTraceroute[] | undefined,
  currentNodeId: string | null | undefined,
  targetNodeId: string | null | undefined,
): DbTraceroute | null {
  return useMemo(() => {
    if (!traceroutes || !currentNodeId || !targetNodeId || currentNodeId === targetNodeId) {
      return null;
    }

    const currentNodeNum = parseNodeId(currentNodeId);
    const targetNodeNum = parseNodeId(targetNodeId);
    if (currentNodeNum === null || targetNodeNum === null) return null;

    const cutoff = Date.now() - TRACEROUTE_DISPLAY_HOURS * 60 * 60 * 1000;

    const relevant = traceroutes
      .filter(tr => {
        const isRelevant =
          (tr.fromNodeNum === currentNodeNum && tr.toNodeNum === targetNodeNum) ||
          (tr.fromNodeNum === targetNodeNum && tr.toNodeNum === currentNodeNum);
        return isRelevant && tr.timestamp >= cutoff;
      })
      .sort((a, b) => b.timestamp - a.timestamp);

    return relevant.length > 0 ? relevant[0] : null;
  }, [traceroutes, currentNodeId, targetNodeId]);
}
