/**
 * Dashboard data sources — abstraction layer that lets the per-source
 * Dashboard component render for either a Meshtastic or a MeshCore source.
 *
 * The Dashboard was originally built against Meshtastic-only assumptions
 * (`/api/nodes` endpoint, `user.id`-keyed node map, `getDeviceRoleName`
 * for role labels, custom widgets that depend on Meshtastic protocol
 * concepts). This module abstracts those bits so the same component can
 * back both source types — see issue #3139.
 *
 * The Meshtastic source preserves prior behaviour byte-for-byte and is
 * the default when no explicit data source is passed.
 */

import api from '../../services/api';
import { getDeviceRoleName } from '../../utils/deviceRole';
import type { NodeInfo } from './types';

/**
 * Shape of the data the per-source Dashboard needs from its source. Each
 * implementation knows how to fetch and adapt its native node shape into
 * the common `NodeInfo` type the Dashboard renders against.
 */
export interface DashboardDataSource {
  /** Identifier for testing / debug logs. */
  readonly kind: 'meshtastic' | 'meshcore' | 'reticulum';

  /** Fetch the source's nodes and return them as `NodeInfo`s. */
  fetchNodes: (sourceId: string | null) => Promise<NodeInfo[]>;

  /** Extract the dedup / lookup key (matches `FavoriteChart.nodeId`). */
  nodeKey: (node: NodeInfo) => string | undefined;

  /** Human-readable display name; falls back to `fallbackId` when node is unknown. */
  getDisplayName: (node: NodeInfo | undefined, fallbackId: string) => string;

  /** Device-role label for the filter dropdown, or null if the node has no role. */
  getRoleName: (node: NodeInfo | undefined) => string | null;

  /** Telemetry types that should show the solar overlay on by default. */
  readonly solarDefaultTypes: ReadonlySet<string>;

  /** Whether the "Add Widget" button is exposed. Custom widgets are Meshtastic-only today. */
  readonly showCustomWidgets: boolean;

  /** Whether the device-role filter dropdown is shown. */
  readonly showRoleFilter: boolean;
}

// ---------------------------------------------------------------------------
// Meshtastic data source (default)
// ---------------------------------------------------------------------------

const MESHTASTIC_SOLAR_DEFAULT_ON_TYPES = new Set<string>([
  'batteryLevel', 'voltage',
  'ch1Voltage', 'ch1Current',
  'ch2Voltage', 'ch2Current',
  'ch3Voltage', 'ch3Current',
  'ch4Voltage', 'ch4Current',
  'ch5Voltage', 'ch5Current',
  'ch6Voltage', 'ch6Current',
  'ch7Voltage', 'ch7Current',
  'ch8Voltage', 'ch8Current',
  'temperature', 'humidity', 'pressure',
]);

export const meshtasticDashboardSource: DashboardDataSource = {
  kind: 'meshtastic',
  fetchNodes: async (sourceId) => {
    const sourceQuery = sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : '';
    return api.get<NodeInfo[]>(`/api/nodes${sourceQuery}`);
  },
  nodeKey: (node) => node.user?.id,
  getDisplayName: (node, fallbackId) =>
    node?.user?.longName || node?.user?.shortName || fallbackId,
  getRoleName: (node) => {
    const role = node?.user?.role;
    if (role === undefined || role === null) return null;
    return getDeviceRoleName(role);
  },
  solarDefaultTypes: MESHTASTIC_SOLAR_DEFAULT_ON_TYPES,
  showCustomWidgets: true,
  showRoleFilter: true,
};

// ---------------------------------------------------------------------------
// MeshCore data source
// ---------------------------------------------------------------------------

/**
 * Raw shape returned by `GET /api/sources/:id/meshcore/nodes` (the
 * registered serverside `MeshCoreNode`). Kept as a local type — we
 * deliberately don't import the server's interface so this module stays
 * frontend-only.
 */
interface RawMeshCoreNode {
  publicKey: string;
  name: string;
  advType: number; // 0=unknown, 1=companion, 2=repeater, 3=room server
  lastHeard?: number;
  rssi?: number;
  snr?: number;
  latitude?: number;
  longitude?: number;
}

const MESHCORE_ADV_TYPE_LABELS: Record<number, string> = {
  0: 'Unknown',
  1: 'Companion',
  2: 'Repeater',
  3: 'Room Server',
};

// LPP env-sensor types that warrant the solar overlay. Status counters
// (uptime, packets, rssi/snr) don't benefit from a solar curve.
const MESHCORE_SOLAR_DEFAULT_ON_TYPES = new Set<string>([
  // Multi-channel battery / voltage / current
  ...['ch1', 'ch2', 'ch3', 'ch4', 'ch5', 'ch6', 'ch7', 'ch8'].flatMap((ch) => [
    `mc_battery_volts_${ch}`,
    `mc_voltage_${ch}`,
    `mc_current_${ch}`,
  ]),
  // Environmental sensors (single-channel typical, but support up to 4)
  ...['ch1', 'ch2', 'ch3', 'ch4'].flatMap((ch) => [
    `mc_temperature_${ch}`,
    `mc_humidity_${ch}`,
    `mc_pressure_${ch}`,
  ]),
]);

export const meshcoreDashboardSource: DashboardDataSource = {
  kind: 'meshcore',
  fetchNodes: async (sourceId) => {
    if (!sourceId) return [];
    // MeshCore nodes are served per-source, not globally.
    const response = await api.get<{ data?: RawMeshCoreNode[] } | RawMeshCoreNode[]>(
      `/api/sources/${encodeURIComponent(sourceId)}/meshcore/nodes`,
    );
    const raw: RawMeshCoreNode[] = Array.isArray(response)
      ? response
      : (response?.data ?? []);
    return raw.map((mc): NodeInfo => ({
      // MeshCore has no integer nodeNum — leave 0; the Dashboard's
      // chart-rendering path doesn't use nodeNum directly, only for
      // custom-widget machinery we hide for MeshCore.
      nodeNum: 0,
      user: {
        id: mc.publicKey,
        longName: mc.name,
        shortName: mc.name?.slice(0, 4),
        role: mc.advType,
      },
      lastHeard: mc.lastHeard,
      snr: mc.snr,
      rssi: mc.rssi,
      position:
        mc.latitude != null && mc.longitude != null
          ? { latitude: mc.latitude, longitude: mc.longitude }
          : undefined,
    }));
  },
  nodeKey: (node) => node.user?.id,
  getDisplayName: (node, fallbackId) =>
    node?.user?.longName || node?.user?.shortName || fallbackId,
  getRoleName: (node) => {
    const advType = node?.user?.role;
    if (advType === undefined || advType === null) return null;
    const key = typeof advType === 'number' ? advType : Number(advType);
    return MESHCORE_ADV_TYPE_LABELS[key] ?? null;
  },
  solarDefaultTypes: MESHCORE_SOLAR_DEFAULT_ON_TYPES,
  // MeshCore has no equivalent for Meshtastic's nodeStatus / traceroute /
  // hopDistribution / distanceDistribution custom widgets.
  showCustomWidgets: false,
  showRoleFilter: true,
};

// ---------------------------------------------------------------------------
// Reticulum data source (#3960 Phase 1b WP1)
// ---------------------------------------------------------------------------

/**
 * Raw shape returned by `GET /api/sources/:id/reticulum/interfaces` (mirrors
 * the server's `ReticulumInterfaceRow`, `src/db/repositories/reticulum.ts`).
 * Kept as a local type — like `RawMeshCoreNode` above, this module
 * deliberately doesn't import server types so it stays frontend-only.
 */
interface RawReticulumInterface {
  interfaceName: string;
  interfaceType: string | null;
  mode: string | null;
  status: string;
  online: boolean;
  bitrate: number | null;
  txBytes: number;
  rxBytes: number;
  lastSeenAt: number;
}

/**
 * Synthetic node-id for a Reticulum interface's throughput-history telemetry
 * rows. MUST equal `reticulumInterfaceNodeId()` in
 * `src/server/services/reticulumTelemetry.ts` — the server-side function
 * that actually derives the `telemetry.nodeId` these history rows are keyed
 * on (§3e of the Phase 1b build spec). Re-declared rather than imported to
 * keep this module frontend-only, matching the MeshCore adapter's
 * convention above.
 */
function reticulumInterfaceNodeId(interfaceName: string): string {
  return `rns:iface:${interfaceName}`;
}

/**
 * Raw shape returned by `GET /api/sources/:id/reticulum/destinations` (mirrors
 * the server's `ReticulumDestinationRow`). Only the fields this adapter reads.
 */
interface RawReticulumDestination {
  destinationHash: string;
  displayName: string | null;
  appName: string | null;
  isFavorite: boolean;
  lastSeen: number;
  positionUpdatedAt: number | null;
}

/**
 * Synthetic node-id for a Reticulum destination's Sideband sensor-history
 * rows. MUST equal `reticulumDestinationNodeId()` in
 * `src/server/services/reticulumTelemetry.ts` (Phase 3 WP4) — the server keys
 * the shared `telemetry` rows on this exact string. Re-declared, not imported,
 * to keep this module frontend-only (matches the interface helper above).
 */
function reticulumDestinationNodeId(destinationHash: string): string {
  return `rns:dest:${destinationHash}`;
}

export const reticulumDashboardSource: DashboardDataSource = {
  kind: 'reticulum',
  fetchNodes: async (sourceId) => {
    if (!sourceId) return [];
    // Reticulum data is served per-source, not globally. Interfaces carry
    // throughput history; destinations carry Sideband sensor/position history
    // (Phase 3). Fetch both so the Dashboard lists the peers actually sharing
    // telemetry with this identity.
    const base = `/api/sources/${encodeURIComponent(sourceId)}/reticulum`;
    const [ifaceRes, destRes] = await Promise.all([
      api.get<{ data?: RawReticulumInterface[] } | RawReticulumInterface[]>(`${base}/interfaces`),
      api.get<{ data?: RawReticulumDestination[] } | RawReticulumDestination[]>(`${base}/destinations`)
        .catch(() => [] as RawReticulumDestination[]),
    ]);
    const interfaces: RawReticulumInterface[] = Array.isArray(ifaceRes)
      ? ifaceRes
      : (ifaceRes?.data ?? []);
    const destinations: RawReticulumDestination[] = Array.isArray(destRes)
      ? destRes
      : (destRes?.data ?? []);

    const interfaceNodes = interfaces.map((iface): NodeInfo => ({
      // Reticulum interfaces have no integer nodeNum — leave 0, matching the
      // MeshCore adapter's convention; the Dashboard's nodeNum-dependent
      // custom-widget machinery is hidden via showCustomWidgets below.
      nodeNum: 0,
      user: {
        id: reticulumInterfaceNodeId(iface.interfaceName),
        longName: iface.interfaceName,
        shortName: iface.interfaceName?.slice(0, 4),
      },
      lastHeard: iface.lastSeenAt,
    }));

    // Only surface destinations that actually share telemetry with us — those
    // with a Sideband position, or explicit favorites (peers the user tracks).
    // Announced-only destinations would flood the list with no history to show.
    const destinationNodes = destinations
      .filter(d => d.positionUpdatedAt != null || d.isFavorite)
      .map((d): NodeInfo => ({
        nodeNum: 0,
        user: {
          id: reticulumDestinationNodeId(d.destinationHash),
          longName: d.displayName || d.appName || d.destinationHash.slice(0, 12),
          shortName: d.destinationHash.slice(0, 4),
        },
        lastHeard: d.positionUpdatedAt ?? d.lastSeen,
      }));

    return [...interfaceNodes, ...destinationNodes];
  },
  nodeKey: (node) => node.user?.id,
  getDisplayName: (node, fallbackId) =>
    node?.user?.longName || node?.user?.shortName || fallbackId,
  // R3 (Phase 1b build spec §0): nodeTypeCategory / role concept is a no-op
  // this phase — Reticulum interfaces have no analogous role field.
  getRoleName: () => null,
  // R1 (Phase 1b build spec §0): interface gauges besides bitrate/tx/rx are
  // descoped, and none of the persisted fields warrant a solar overlay.
  solarDefaultTypes: new Set<string>(),
  showCustomWidgets: false,
  showRoleFilter: false,
};
