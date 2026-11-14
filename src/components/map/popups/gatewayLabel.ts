/**
 * #6386: resolve a gateway's raw `!xxxxxxxx` id to the human name the viewer
 * already knows, for the "Colour nodes by gateway" legend and the popup's
 * "via N gateways" chips.
 *
 * Display-only. The colour domain, ring colours and every stored field stay
 * keyed on the raw id, so a gateway keeps its colour when its name changes.
 *
 * Names come only from the viewer's own merged node list, so a gateway the
 * viewer cannot see resolves to its hex id and no name leaks across sources.
 * Resolution happens at render time (not in mergeUnifiedSourceData) so a
 * gateway whose NodeInfo arrives later shows its name on the next poll.
 */
import { createContext, useContext } from 'react';
import { isPlaceholderLongName, isPlaceholderShortName } from '../../../utils/nodeFieldBlanks';

export interface GatewayName {
  longName: string | null;
  shortName: string | null;
}

/** nodeNum → known, non-placeholder names. */
export type GatewayNameIndex = Map<number, GatewayName>;

export interface GatewayLabel {
  /** The raw gateway id, e.g. `!04e36b84`. */
  id: string;
  longName: string | null;
  shortName: string | null;
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hexNodeId(nodeNum: number): string {
  return `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`;
}

/** Parse `!04e36b84` (or bare hex) to its nodeNum; null when it isn't one. */
export function parseGatewayNodeNum(gatewayId: string): number | null {
  const m = /^!?([0-9a-f]{1,8})$/i.exec(gatewayId.trim());
  if (!m) return null;
  return parseInt(m[1], 16) >>> 0;
}

/**
 * Build the nodeNum → names index from merged nodes. Accepts both the flat
 * merged shape (`longName`) and the `user.longName` shape. Placeholder names
 * (`Node !aabbccdd`, last-4-hex short names) count as unknown.
 */
export function buildGatewayNameIndex(nodes: readonly unknown[]): GatewayNameIndex {
  const index: GatewayNameIndex = new Map();
  for (const raw of nodes) {
    const n = raw as {
      nodeNum?: unknown;
      longName?: unknown;
      shortName?: unknown;
      user?: { longName?: unknown; shortName?: unknown } | null;
    } | null;
    if (!n) continue;
    const num = Number(n.nodeNum);
    if (!Number.isFinite(num) || num <= 0) continue;
    const nodeNum = num >>> 0;
    const nodeId = hexNodeId(nodeNum);
    let longName = cleanName(n.longName ?? n.user?.longName);
    let shortName = cleanName(n.shortName ?? n.user?.shortName);
    if (longName && isPlaceholderLongName(longName)) longName = null;
    if (shortName && isPlaceholderShortName(shortName, nodeId)) shortName = null;
    if (!longName && !shortName) continue;
    const prev = index.get(nodeNum);
    index.set(nodeNum, {
      longName: prev?.longName ?? longName,
      shortName: prev?.shortName ?? shortName,
    });
  }
  return index;
}

export function resolveGatewayLabel(
  gatewayId: string,
  gatewayNodeNum: number | null | undefined,
  index: GatewayNameIndex | null | undefined,
): GatewayLabel {
  const num =
    gatewayNodeNum != null && Number.isFinite(Number(gatewayNodeNum))
      ? Number(gatewayNodeNum) >>> 0
      : parseGatewayNodeNum(gatewayId);
  const names = num != null ? index?.get(num) : undefined;
  return {
    id: gatewayId,
    longName: names?.longName ?? null,
    shortName: names?.shortName ?? null,
  };
}

/** Legend text: `Long Name (!04e36b84)`, or just the id when the name is unknown. */
export function gatewayLegendText(label: GatewayLabel): string {
  const name = label.longName ?? label.shortName;
  return name ? `${name} (${label.id})` : label.id;
}

/** Chip text: short name, else long name, else the raw id. */
export function gatewayChipText(label: GatewayLabel): string {
  return label.shortName ?? label.longName ?? label.id;
}

/**
 * Supplies the name index to popups rendered under a map. Null (the default)
 * means "no names known", so popups outside a provider show raw ids as before.
 */
export const GatewayNameContext = createContext<GatewayNameIndex | null>(null);

export function useGatewayNameIndex(): GatewayNameIndex | null {
  return useContext(GatewayNameContext);
}
