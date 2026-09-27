/**
 * Public ADS-B feeds MeshMonitor can ask "which aircraft is at this spot?"
 * (#5374). Shared by the server client (`adsbFeedClient.ts`), the flight-match
 * route (flight link + credit) and the Settings UI (select + terms line).
 *
 * v1 ships two feeds. airplanes.live was in the spec, but it answered HTTP 403
 * to an anonymous request during the implementation-time check, so it is left
 * out until a key or registration path is confirmed.
 */

export type AdsbFeedId = 'adsb.lol' | 'adsb.fi';

export const ADSB_FEED_IDS: readonly AdsbFeedId[] = ['adsb.lol', 'adsb.fi'];

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
};

export function isAdsbFeed(v: unknown): v is AdsbFeedId {
  return typeof v === 'string' && (ADSB_FEED_IDS as readonly string[]).includes(v);
}

/** The feed for a stored setting value; anything unknown falls back to the default. */
export function resolveAdsbFeed(v: unknown): AdsbFeedInfo {
  return ADSB_FEEDS[isAdsbFeed(v) ? v : DEFAULT_ADSB_FEED];
}
