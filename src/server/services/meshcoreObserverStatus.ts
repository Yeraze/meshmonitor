/**
 * MeshCore Analyzer Observer status types (#5014 Phase 1 WP1).
 *
 * Types only — deliberately has no imports and no runtime logic. Split out of
 * `meshcoreObserverPublisher.ts` (which value-imports the credential store,
 * the token minter and `package.json`) so the new `GET /observer/status`
 * route (WP4) can depend on the shape without pulling the publisher in, and
 * so WP3 (publisher) and WP4 (routes) can be built in parallel without
 * touching the same file. `meshcoreObserverPublisher.ts` re-exports both
 * types from here, so every existing import site keeps working unchanged.
 *
 * See docs/internal/dev-notes/MESHMAPPER_OBSERVER_PHASE1_SPEC.md §5.1.
 */

/** Per-broker Analyzer Observer connection status (#5014 Phase 1). */
export interface MeshCoreObserverBrokerStatus {
  /** Stable identity. Same value as NormalizedObserverBroker.key. */
  key: string;
  /** Normalized broker URL. Non-secret, but see the strip rule in §5.4. */
  url: string;
  label: string | null;
  authMode: 'token' | 'password';
  tokenAudience: string | null;
  /** This broker has every field its auth mode requires. */
  configured: boolean;
  /** Its credential exists and decrypts under the current SESSION_SECRET. */
  keyStored: boolean;
  connected: boolean;
  publishes: number;
  /** Packets dropped because THIS broker's socket was down. */
  dropped: number;
  lastPublishAt: number | null;
  /** Token-redacted. */
  lastError: string | null;
  /** Unix SECONDS. Null in password mode. */
  tokenExpiresAt: number | null;
}

/**
 * Aggregate Analyzer Observer status for a source. Every field below the
 * `brokers` array existed pre-#5014 and keeps its meaning for a
 * single-broker source: the aggregation rules (§5.1) are chosen so a
 * single-broker source produces exactly the values it produces today.
 */
export interface MeshCoreObserverStatus {
  /** ANY broker configured. */
  configured: boolean;
  /** brokers[0].authMode. Legacy field, kept for existing consumers. */
  authMode: 'token' | 'password';
  /** ANY broker's credential present and decryptable. */
  keyStored: boolean;
  /** ANY broker connected. */
  connected: boolean;
  /** SUM over brokers. */
  publishes: number;
  /** SUM over brokers. */
  dropped: number;
  /** MAX over brokers (most recent). */
  lastPublishAt: number | null;
  /** Most recently set non-null broker lastError. Token-redacted. */
  lastError: string | null;
  /** MIN over non-null broker values (earliest expiry). */
  tokenExpiresAt: number | null;

  // ---- new (#5014 Phase 1) ----
  brokers: MeshCoreObserverBrokerStatus[];
}
