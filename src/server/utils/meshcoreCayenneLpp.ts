/**
 * Cayenne-LPP decoder for MeshCore telemetry responses (#6389).
 *
 * MeshCore firmware encodes telemetry with the ElectronicCats CayenneLPP
 * library. Every record is `[channel:u8][type:u8][payload]`, and the payload
 * size is fixed by the type, with no length byte. A decoder that does not know
 * a type cannot find where the next record starts, so it has to stop there.
 *
 * The pinned meshcore.js `CayenneLpp.parse()` knows only about a dozen types,
 * so it stopped at the first altitude (121) record a BME280/BMP280 repeater
 * sends after its pressure reading, and every sensor after it (INA3221
 * voltage/current/power, ...) was lost. This decoder knows every fixed-size
 * type in the firmware library, so only a truly unknown or variable-length
 * type (polyline) ends the parse.
 *
 * Value scaling follows the meshcore.js parser for the types it already
 * decoded (e.g. voltage/current read as signed), so stored history keeps the
 * same meaning. Types it did not decode follow the firmware library's
 * `CayenneLPP.h` sizes and multipliers.
 */

export interface CayenneLppRecord {
  channel: number;
  type: number;
  value: number | Record<string, number>;
}

/** Cayenne-LPP type ids, from ElectronicCats `CayenneLPP.h`. */
export const LPP = {
  DIGITAL_INPUT: 0,
  DIGITAL_OUTPUT: 1,
  ANALOG_INPUT: 2,
  ANALOG_OUTPUT: 3,
  GENERIC_SENSOR: 100,
  LUMINOSITY: 101,
  PRESENCE: 102,
  TEMPERATURE: 103,
  RELATIVE_HUMIDITY: 104,
  ACCELEROMETER: 113,
  BAROMETRIC_PRESSURE: 115,
  VOLTAGE: 116,
  CURRENT: 117,
  FREQUENCY: 118,
  PERCENTAGE: 120,
  ALTITUDE: 121,
  CONCENTRATION: 125,
  POWER: 128,
  DISTANCE: 130,
  ENERGY: 131,
  DIRECTION: 132,
  UNIXTIME: 133,
  GYROMETER: 134,
  COLOUR: 135,
  GPS: 136,
  SWITCH: 142,
} as const;

type Decoder = { size: number; read: (b: Uint8Array, o: number) => CayenneLppRecord['value'] };

const u8 = (b: Uint8Array, o: number) => b[o];
const u16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const i16 = (b: Uint8Array, o: number) => {
  const v = u16(b, o);
  return v & 0x8000 ? v - 0x10000 : v;
};
const i24 = (b: Uint8Array, o: number) => {
  const v = (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
  return v & 0x800000 ? v - 0x1000000 : v;
};
const u32 = (b: Uint8Array, o: number) =>
  ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);

const xyz = (scale: number) => (b: Uint8Array, o: number) => ({
  x: i16(b, o) / scale,
  y: i16(b, o + 2) / scale,
  z: i16(b, o + 4) / scale,
});

const DECODERS: Record<number, Decoder> = {
  [LPP.DIGITAL_INPUT]: { size: 1, read: u8 },
  [LPP.DIGITAL_OUTPUT]: { size: 1, read: u8 },
  [LPP.ANALOG_INPUT]: { size: 2, read: (b, o) => i16(b, o) / 100 },
  [LPP.ANALOG_OUTPUT]: { size: 2, read: (b, o) => i16(b, o) / 100 },
  [LPP.GENERIC_SENSOR]: { size: 4, read: u32 },
  // meshcore.js read luminosity as signed; kept for history continuity.
  [LPP.LUMINOSITY]: { size: 2, read: i16 },
  [LPP.PRESENCE]: { size: 1, read: u8 },
  [LPP.TEMPERATURE]: { size: 2, read: (b, o) => i16(b, o) / 10 },
  [LPP.RELATIVE_HUMIDITY]: { size: 1, read: (b, o) => u8(b, o) / 2 },
  [LPP.ACCELEROMETER]: { size: 6, read: xyz(1000) },
  [LPP.BAROMETRIC_PRESSURE]: { size: 2, read: (b, o) => u16(b, o) / 10 },
  // Firmware encodes voltage/current unsigned; meshcore.js reads them signed
  // so a negative (reverse) reading survives. Kept for history continuity.
  [LPP.VOLTAGE]: { size: 2, read: (b, o) => i16(b, o) / 100 },
  [LPP.CURRENT]: { size: 2, read: (b, o) => i16(b, o) / 1000 },
  [LPP.FREQUENCY]: { size: 4, read: u32 },
  [LPP.PERCENTAGE]: { size: 1, read: u8 },
  [LPP.ALTITUDE]: { size: 2, read: i16 },
  [LPP.CONCENTRATION]: { size: 2, read: u16 },
  [LPP.POWER]: { size: 2, read: u16 },
  [LPP.DISTANCE]: { size: 4, read: (b, o) => u32(b, o) / 1000 },
  [LPP.ENERGY]: { size: 4, read: (b, o) => u32(b, o) / 1000 },
  [LPP.DIRECTION]: { size: 2, read: u16 },
  [LPP.UNIXTIME]: { size: 4, read: u32 },
  [LPP.GYROMETER]: { size: 6, read: xyz(100) },
  [LPP.COLOUR]: { size: 3, read: (b, o) => ({ r: b[o], g: b[o + 1], b: b[o + 2] }) },
  [LPP.GPS]: {
    size: 9,
    read: (b, o) => ({
      latitude: i24(b, o) / 10000,
      longitude: i24(b, o + 3) / 10000,
      altitude: i24(b, o + 6) / 100,
    }),
  },
  [LPP.SWITCH]: { size: 1, read: u8 },
};

/**
 * Decode a Cayenne-LPP payload. Stops (keeping everything decoded so far) at
 * a `00 00` channel/type pair (firmware pads the reply), at an unknown or
 * variable-length type, or at a record cut short by the end of the buffer.
 */
export function parseCayenneLpp(input: Uint8Array | ArrayLike<number>): CayenneLppRecord[] {
  const bytes = input instanceof Uint8Array ? input : Uint8Array.from(input);
  const out: CayenneLppRecord[] = [];
  let o = 0;
  while (bytes.length - o >= 2) {
    const channel = bytes[o];
    const type = bytes[o + 1];
    if (channel === 0 && type === 0) break;
    const dec = DECODERS[type];
    if (!dec || o + 2 + dec.size > bytes.length) break;
    out.push({ channel, type, value: dec.read(bytes, o + 2) });
    o += 2 + dec.size;
  }
  return out;
}
