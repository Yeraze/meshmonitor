/**
 * Waypoint type — mirrors the server's `Waypoint` row shape (see
 * `src/db/repositories/waypoints.ts`). Numeric fields are normalised to
 * `number`; nullable columns surface as `null`.
 */
export interface Waypoint {
  sourceId: string;
  waypointId: number;
  ownerNodeNum: number | null;
  latitude: number;
  longitude: number;
  /** Epoch seconds. `null` (or 0 on the wire) means "never expires". */
  expireAt: number | null;
  /** nodeNum that's allowed to edit; `null` = open to anyone. */
  lockedTo: number | null;
  name: string;
  description: string;
  iconCodepoint: number | null;
  iconEmoji: string | null;
  isVirtual: boolean;
  /**
   * Device channel slot (0-7) the waypoint is broadcast on. `null` on rows
   * created before #4341 — readers fall back to slot 0, the old behaviour.
   */
  channel: number | null;
  rebroadcastIntervalS: number | null;
  lastBroadcastAt: number | null;
  firstSeenAt: number;
  lastUpdatedAt: number;
}

export interface WaypointInput {
  lat: number;
  lon: number;
  name?: string;
  description?: string;
  /** Either an emoji string or a unicode codepoint number. */
  icon?: string | number | null;
  /** Epoch seconds; null = no expiry. */
  expire?: number | null;
  locked_to?: number | null;
  virtual?: boolean;
  /** Device channel slot (0-7) to broadcast on. Omitted = slot 0. */
  channel?: number | null;
  rebroadcast_interval_s?: number | null;
}
