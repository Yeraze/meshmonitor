/**
 * Public ADS-B feeds MeshMonitor can ask "which aircraft is at this spot?"
 * (#5374). Shared by the server client (`adsbFeedClient.ts`), the flight-match
 * route (flight link + credit) and the Settings UI (select + terms line).
 *
 * v1 ships two feeds. airplanes.live was in the spec, but it answered HTTP 403
 * to an anonymous request during the implementation-time check, so it is left
 * out until a key or registration path is confirmed.
 *
 * OpenSky Network (#5877) takes a bounding box, answers with positional arrays
 * and needs an OAuth2 client-credentials account, so a feed can override how
 * its request is built (`buildRequest`), how its body is read (`parse`) and
 * how it authenticates (`auth`). The readsb feeds keep the defaults.
 */
import type { AdsbAircraft } from './adsbMatch.js';
import { openSkyStatesUrl, parseOpenSkyStates, OPENSKY_RETRY_AFTER_HEADER } from './openSky.js';

export type AdsbFeedId = 'adsb.lol' | 'adsb.fi' | 'opensky';

export const ADSB_FEED_IDS: readonly AdsbFeedId[] = ['adsb.lol', 'adsb.fi', 'opensky'];

export const DEFAULT_ADSB_FEED: AdsbFeedId = 'adsb.lol';

export interface AdsbFeedInfo {
  id: AdsbFeedId;
  /** Display name, also the credit line ("Data: adsb.lol"). */
  name: string;
  /** Point query: every aircraft within `nm` nautical miles of (lat, lon). */
  pointUrl(lat: number, lon: number, nm: number): string;
  /** The aircraft on the feed's own map. */
  flightUrl(hex: string): string;
  /** Short terms-of-use line for the Settings UI. */
  terms: string;
  /** Credit line name when it differs from `name` ("Data: <credit>"). */
  credit?: string;
  /**
   * How the client authenticates. `'api-key'` (default): the shared
   * `adsb_api_token`, as `X-API-Key`, when one is set. `'oauth2'`: a Bearer
   * token from the feed's own client credentials; the shared key is never sent.
   */
  auth?: 'api-key' | 'oauth2';
  /** Request for a point query. Default: GET `pointUrl(lat, lon, nm)` with no extra headers. */
  buildRequest?(lat: number, lon: number, nm: number): { url: string; headers: Record<string, string> };
  /** Aircraft out of the response body. Default: the readsb `ac[]` parser. Throws on a bad body. */
  parse?(body: unknown): AdsbAircraft[];
  /**
   * Header with a 429's retry delay in seconds. When set and present, the
   * service pauses this feed for that long instead of the fixed backoff.
   */
  retryAfterHeader?: string;
}

function coord(v: number): string {
  // 4 decimals is ~11 m: plenty for a radius of several km, and it keeps the
  // exact node position out of the outbound URL.
  return v.toFixed(4);
}

export const ADSB_FEEDS: Readonly<Record<AdsbFeedId, AdsbFeedInfo>> = {
  'adsb.lol': {
    id: 'adsb.lol',
    name: 'adsb.lol',
    pointUrl: (lat, lon, nm) => `https://api.adsb.lol/v2/point/${coord(lat)}/${coord(lon)}/${nm}`,
    flightUrl: (hex) => `https://adsb.lol/?icao=${encodeURIComponent(hex)}`,
    terms: 'Open data under the ODbL.',
  },
  'adsb.fi': {
    id: 'adsb.fi',
    name: 'adsb.fi',
    pointUrl: (lat, lon, nm) =>
      `https://opendata.adsb.fi/api/v3/lat/${coord(lat)}/lon/${coord(lon)}/dist/${nm}`,
    flightUrl: (hex) => `https://globe.adsb.fi/?icao=${encodeURIComponent(hex)}`,
    terms: 'For personal, non-commercial use only.',
  },
  opensky: {
    id: 'opensky',
    name: 'OpenSky Network',
    credit: 'The OpenSky Network',
    pointUrl: (lat, lon, nm) => openSkyStatesUrl(lat, lon, nm),
    buildRequest: (lat, lon, nm) => ({ url: openSkyStatesUrl(lat, lon, nm), headers: {} }),
    parse: parseOpenSkyStates,
    auth: 'oauth2',
    retryAfterHeader: OPENSKY_RETRY_AFTER_HEADER,
    flightUrl: (hex) => `https://map.opensky-network.org/?icao=${encodeURIComponent(hex)}`,
    terms: 'Non-commercial and research use only. Credit: The OpenSky Network.',
  },
};

/** The credit line shown with a match ("Data: adsb.lol"). */
export function adsbFeedCredit(feed: AdsbFeedInfo): string {
  return `Data: ${feed.credit ?? feed.name}`;
}

export function isAdsbFeed(v: unknown): v is AdsbFeedId {
  return typeof v === 'string' && (ADSB_FEED_IDS as readonly string[]).includes(v);
}

/** The feed for a stored setting value; anything unknown falls back to the default. */
export function resolveAdsbFeed(v: unknown): AdsbFeedInfo {
  return ADSB_FEEDS[isAdsbFeed(v) ? v : DEFAULT_ADSB_FEED];
}
