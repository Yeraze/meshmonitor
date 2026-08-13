/**
 * Reticulum frontend types (epic #3960, Phase 1b WP1).
 *
 * Mirrors the server-side shapes rather than importing them, matching the
 * existing frontend/backend boundary convention (see `AtakContact` in
 * `./atakContact.ts` and the `RawMeshCoreNode` local type in
 * `src/components/Dashboard/dataSources.ts`) — the client/server contract is
 * plain JSON over `/api/sources/:id/reticulum/*`, not a shared TS import.
 *
 * Authoritative sources for these shapes:
 *  - `ReticulumDestinationRow` / `ReticulumInterfaceRow`: `src/db/repositories/reticulum.ts`
 *  - `GET /status` payload shape: `src/server/routes/reticulumRoutes.ts`
 *  - `rnsVersion`/`bridgeVersion`: WP-B (cached from the bridge's last
 *    `welcome`/`status` frame in `ReticulumManager`) — optional here because
 *    WP-B may land after this file; older servers simply omit them.
 */

/** Connectivity mode for a Reticulum source (see `src/server/reticulumConfig.ts`). */
export type ReticulumMode = 'attach' | 'tcp_peer';

/** `GET /api/sources/:id/reticulum/status` payload (inside the `{success,data}` envelope). */
export interface ReticulumStatus {
  connected: boolean;
  /** Undefined when the source config couldn't be resolved (non-fatal). */
  mode?: ReticulumMode;
  interfaceCount: number;
  destinationCount: number;
  /** RNS daemon version string, cached from the bridge's last welcome/status frame (WP-B). */
  rnsVersion?: string;
  /** meshmonitor-rns-bridge version string, cached from the same frame (WP-B). */
  bridgeVersion?: string;
}

/**
 * One row from `GET /api/sources/:id/reticulum/destinations` (mirrors the
 * server's `ReticulumDestinationRow`, `src/db/repositories/reticulum.ts`).
 * "Announce rate" is deliberately NOT a field here — the build spec (§2)
 * calls for it to be derived in the UI as
 * `announceCount / (lastSeen - firstSeen)`, not persisted.
 */
export interface ReticulumDestinationRow {
  id?: number;
  sourceId: string;
  destinationHash: string;
  identityHash: string | null;
  appName: string | null;
  aspects: string | null;
  displayName: string | null;
  appDataB64: string | null;
  hops: number | null;
  nextHopInterface: string | null;
  rssi: number | null;
  snr: number | null;
  quality: number | null;
  announceCount: number;
  firstSeen: number;
  lastSeen: number;
  lastAnnounceAt: number | null;
  isFavorite: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * One row from `GET /api/sources/:id/reticulum/interfaces` (mirrors the
 * server's `ReticulumInterfaceRow`, `src/db/repositories/reticulum.ts`).
 * R1 (interface gauges DESCOPE, Phase 1b build spec §0): deliberately
 * excludes Phase-3-only fields like airtime/channel-load/noise-floor/battery
 * — those don't exist on `reticulum_interfaces` yet.
 */
export interface ReticulumInterfaceRow {
  id?: number;
  sourceId: string;
  interfaceName: string;
  interfaceType: string | null;
  interfaceHash: string | null;
  mode: string | null;
  status: string;
  online: boolean;
  bitrate: number | null;
  txBytes: number;
  rxBytes: number;
  lastSeenAt: number;
  createdAt: number;
  updatedAt: number;
}

/** Sub-toolbar view identifiers for `ReticulumPage`/`ReticulumSubToolbar` (WP2). */
export type ReticulumView = 'destinations' | 'interfaces' | 'info' | 'settings';
