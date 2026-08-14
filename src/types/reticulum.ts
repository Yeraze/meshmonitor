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
  /**
   * Latest Sideband `SID_LOCATION` sample (Phase 3, migration 144).
   * Peer-shared per-source; LATEST-ONLY overwrite (no history). Null when
   * this destination has never shared a position.
   */
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  speed: number | null;
  bearing: number | null;
  accuracy: number | null;
  /** ms epoch of the latest position sample; null when never observed. */
  positionUpdatedAt: number | null;
}

/**
 * One row from `GET /api/sources/:id/reticulum/interfaces` (mirrors the
 * server's `ReticulumInterfaceRow`, `src/db/repositories/reticulum.ts`).
 * R1 (interface gauges DESCOPE, Phase 1b build spec §0): deliberately
 * excludes Phase-3-only fields like airtime/channel-load/noise-floor/battery
 * — those don't exist on `reticulum_interfaces` yet.
 * Phase 3 (migration 145) adds the own-mode radio-config + device-info
 * columns below — null for attach/tcp_peer sources, which never write them.
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
  /** Own-mode RNode radio config (Phase 3, migration 145). Null for attach/tcp_peer. */
  frequency: number | null;
  bandwidth: number | null;
  spreadingFactor: number | null;
  codingRate: number | null;
  txPower: number | null;
  stAlock: number | null;
  ltAlock: number | null;
  radioState: boolean | null;
  /** Loose JSON text — read-only RNode board/firmware info (R2). */
  deviceInfoJson: string | null;
}

/** Sub-toolbar view identifiers for `ReticulumPage`/`ReticulumSubToolbar` (WP2; 'dms' added Phase 2 WP5; 'map'/'configuration' added Phase 3). */
export type ReticulumView = 'destinations' | 'interfaces' | 'map' | 'dms' | 'info' | 'configuration' | 'settings';

/**
 * LXMF message lifecycle state (Reticulum epic #3960, Phase 2 WP2/WP3).
 * Canonical definition — `src/db/repositories/reticulum.ts` re-exports this
 * rather than redeclaring it, so server and frontend can't drift (both
 * consume the same union; the server/frontend type-boundary convention still
 * holds for the interface *shapes* like `ReticulumMessageRow`, which remain
 * independently declared, see the module comment above).
 */
export type ReticulumMessageState = 'draft' | 'outbound' | 'sending' | 'sent' | 'delivered' | 'failed';

/**
 * LXMF delivery method (Reticulum epic #3960, Phase 2 WP2/WP3). Includes
 * `'paper'` (offline/manual transfer) to match the wire protocol's
 * `LxmfMethod` (`src/server/reticulumProtocol.ts` — kept as its own type
 * there since it also carries wire-message fields, but its value set MUST
 * match this one). Canonical definition — see `ReticulumMessageState` above.
 */
export type ReticulumMessageMethod = 'opportunistic' | 'direct' | 'propagated' | 'paper';

/**
 * One row from the (Phase 3+) `GET /api/sources/:id/reticulum/messages*`
 * endpoints (mirrors the server's `ReticulumMessageRow`,
 * `src/db/repositories/reticulum.ts`). `id` is the composite key
 * `${sourceId}_${lxmHashHex}` (see the `messages.id` row-id convention).
 *
 * Phase 2 scope: UTF-8 text `content`/`title` + attachment **metadata** in
 * `fields` (name/type/size/ref) — raw blob transfer over the WS is deferred.
 */
export interface ReticulumMessageRow {
  id: string;
  sourceId: string;
  fromHash: string;
  toHash: string;
  title: string | null;
  content: string | null;
  timestamp: number;
  receivedAt: number | null;
  createdAt: number;
  state: ReticulumMessageState;
  method: ReticulumMessageMethod | null;
  signatureValidated: boolean;
  ratcheted: boolean;
  /** JSON string — replies/reactions/thread markers + attachment metadata. */
  fields: string | null;
  replyToHash: string | null;
  threadHash: string | null;
  rssi: number | null;
  snr: number | null;
  quality: number | null;
}

/**
 * One entry from `GET /api/sources/:id/reticulum/messages` (conversations
 * list — mirrors the server's `ReticulumConversationSummary`,
 * `src/db/repositories/reticulum.ts`). `peerHash` identifies the other
 * party; a message row belongs to this conversation when its `fromHash` OR
 * `toHash` equals `peerHash` — LXMF conversations are always exactly two
 * parties, so that's enough to tell direction within one conversation
 * without needing to know this source's own destination hash (`fromHash ===
 * peerHash` is inbound, `toHash === peerHash` is outbound).
 */
export interface ReticulumConversation {
  peerHash: string;
  lastMessage: ReticulumMessageRow;
  messageCount: number;
}

/**
 * `GET /api/sources/:id/reticulum/identity` payload (mirrors the server's
 * `get_identity` reply shape, `src/server/reticulumManager.ts`). PUBLIC info
 * only (R2/R5) — there is deliberately no field for the private key anywhere
 * on this type; see the R5 backup note surfaced in `ReticulumDmsView`.
 */
export interface ReticulumIdentity {
  destinationHash: string | null;
  displayName: string | null;
}
