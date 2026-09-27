/**
 * Recorded-shape ADS-B feed bodies for tests (#5374). Both feeds answered the
 * 2026-09-27 live check over Miami with `{ ac, msg, now, total, ctime, ptime }`;
 * these mirror that shape (callsigns padded with trailing spaces, `alt_baro`
 * sometimes "ground"). Values are illustrative, not a copy of live traffic.
 */

/** adsb.lol `/v2/point/{lat}/{lon}/{nm}`. */
export const ADSB_LOL_FIXTURE = {
  ac: [
    {
      hex: 'a3f1c2',
      type: 'adsb_icao',
      flight: 'AAL1498 ',
      r: 'N316RK',
      t: 'B38M',
      alt_baro: 9800,
      alt_geom: 9850,
      gs: 312.4,
      track: 271.3,
      baro_rate: 1856,
      squawk: '4512',
      category: 'A3',
      lat: 25.81,
      lon: -80.3,
      nic: 8,
      seen_pos: 0.4,
      seen: 0.1,
      rssi: -12.3,
    },
    {
      hex: 'a0b1c2',
      type: 'adsb_icao',
      flight: 'N123AB  ',
      r: 'N123AB',
      t: 'C172',
      alt_baro: 'ground',
      gs: 4,
      track: 90,
      lat: 25.79,
      lon: -80.29,
      seen_pos: 2.1,
      seen: 1.0,
    },
    {
      hex: 'ac9d01',
      type: 'adsb_icao',
      flight: 'DAL455  ',
      r: 'N901DA',
      t: 'A321',
      alt_baro: 35000,
      alt_geom: 35500,
      gs: 480,
      track: 10,
      lat: 25.9,
      lon: -80.2,
      seen_pos: 0.8,
      seen: 0.2,
    },
  ],
  msg: 'No error',
  now: 1_790_500_000_000,
  total: 3,
  ctime: 1_790_500_000_000,
  ptime: 3,
};

/** adsb.fi `/api/v3/lat/{lat}/lon/{lon}/dist/{nm}` — same aircraft, same shape. */
export const ADSB_FI_FIXTURE = {
  ac: [
    {
      hex: 'a3f1c2',
      type: 'adsb_icao',
      flight: 'AAL1498 ',
      r: 'N316RK',
      t: 'B38M',
      alt_baro: 9800,
      alt_geom: 9850,
      gs: 312.4,
      track: 271.3,
      lat: 25.81,
      lon: -80.3,
      seen_pos: 0.5,
      seen: 0.2,
    },
  ],
  msg: 'No error',
  now: 1_790_500_000_000,
  total: 1,
  ctime: 1_790_500_000_000,
  ptime: 1,
};

/** Nothing in range: readsb sends an empty list. */
export const ADSB_EMPTY_FIXTURE = { ac: [], msg: 'No error', now: 1_790_500_000_000, total: 0, ctime: 0, ptime: 0 };
