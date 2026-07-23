/**
 * ATAK contact type — mirrors the server's `AtakContactRow` shape (see
 * `src/db/repositories/atakContacts.ts`), plus the `stale` flag the
 * `GET /api/sources/:id/atak/contacts` route decorates each row with
 * (ATAK/CoT Phase 2, issue #3691).
 */
export interface AtakContact {
  uid: string;
  sourceId: string;
  nodeNum: number | null;
  callsign: string | null;
  deviceCallsign: string | null;
  /** Team enum int (0-14); null when the PLI carried no Group. */
  team: number | null;
  /** MemberRole enum int (0-8); null when the PLI carried no Group. */
  role: number | null;
  /** Percent (0-100); null when the PLI carried no Status. */
  battery: number | null;
  /** Decimal degrees; null when the position was bogus (e.g. Null Island). */
  latitude: number | null;
  longitude: number | null;
  /** HAE meters. */
  altitude: number | null;
  /** Meters/second. */
  speed: number | null;
  /** Degrees. */
  course: number | null;
  /** Ms epoch of the latest PLI. */
  lastSeen: number;
  /** Ms epoch first seen. */
  createdAt: number;
  /** True when no fresh PLI has arrived within `ATAK_CONTACT_STALE_MS` (server-computed). */
  stale: boolean;
}
