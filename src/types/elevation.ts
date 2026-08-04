/**
 * Client mirror of the Phase-1 elevation backend's response payload
 * (Terrain Link Profile epic #4111). Kept in sync with
 * `src/server/services/elevationService.ts`'s `ProfileSample`/`ProfileResult`
 * but defined independently since the frontend never imports server code.
 */

/** One elevation sample from `POST /api/elevation/profile`. */
export interface ElevationSample {
  distance: number;
  lat: number;
  lng: number;
  elevation: number | null;
}

/** Full profile payload returned (post-envelope-unwrap) by the elevation route. */
export interface ElevationProfile {
  distanceMeters: number;
  provider: string;
  samples: ElevationSample[];
}

/** Mirror of elevationService `TestResult` for the settings Test button (#4111 P3). */
export interface ElevationTestResult {
  success: boolean;
  detectedType: string;
  sampleElevation: number | null;
  latencyMs: number;
  httpStatus?: number;
  error?: string;
}

/**
 * Client mirror of `sourceRoutes.ts`'s server-side `SourceRadioSummary`
 * (#4111 P3 WP-1) — the public, non-secret per-source radio field on
 * `GET /api/sources`. Center frequency / region is inherently public RF
 * information (broadcast over the air), so this is safe on the anonymous
 * sources list.
 */
export interface SourceRadioSummary {
  frequencyMhz: number | null;
  /** Meshtastic only. */
  regionName?: string;
  /** Meshtastic only — drives RX-sensitivity auto-seed. */
  modemPreset?: number;
  /** Meshtastic only. Fail-open true (matches firmware default) when the field is unset. */
  txEnabled?: boolean;
  /** Meshtastic only. `network.enabledProtocols & UDP_BROADCAST` — a LAN peer relays our sends (#4394). */
  udpRelayEnabled?: boolean;
  /**
   * Whether sends from this source have any path onto the mesh. Meshtastic:
   * `txEnabled || udpRelayEnabled`. MeshCore: `!receiveOnly`. Consumers gating
   * "can this source send?" must read THIS, not `txEnabled` alone (#4394).
   */
  canTransmit?: boolean;
  /** MeshCore only (#4547). True when the source is configured strictly receive-only. */
  receiveOnly?: boolean;
}

/**
 * Frontend mirror of `src/server/services/elevationProvider.ts`'s
 * `DEFAULT_TERRARIUM_URL` (#4111 P3 WP-3 follow-up). The server module can't
 * be imported client-side, so this is duplicated by hand — keep both values
 * in sync if the default source ever changes. Used by the Settings tab's
 * elevation Test button so testing an empty source-URL field probes the same
 * URL the backend actually falls back to (`elevationProvider.ts`'s
 * `sourceUrl && sourceUrl.trim().length > 0 ? sourceUrl.trim() : DEFAULT_TERRARIUM_URL`),
 * instead of sending an empty `url` and surfacing the route's 400 validation
 * error.
 */
export const DEFAULT_TERRARIUM_URL =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
