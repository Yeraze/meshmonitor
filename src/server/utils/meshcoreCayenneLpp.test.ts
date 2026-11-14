import { describe, it, expect } from 'vitest';
import { parseCayenneLpp, LPP } from './meshcoreCayenneLpp.js';

describe('parseCayenneLpp (#6389)', () => {
  it('keeps decoding past an altitude record (BME280 + INA3221 repeater)', () => {
    const bytes = [
      1, LPP.VOLTAGE, 0x01, 0x9a, // 4.10 V
      2, LPP.TEMPERATURE, 0x00, 0xe1, // 22.5 °C
      2, LPP.RELATIVE_HUMIDITY, 0x5a, // 45 %
      2, LPP.BAROMETRIC_PRESSURE, 0x27, 0xab, // 1015.5 hPa
      2, LPP.ALTITUDE, 0x00, 0x7b, // 123 m
      3, LPP.VOLTAGE, 0x04, 0xd8, // 12.40 V
      3, LPP.CURRENT, 0x01, 0xf4, // 0.5 A
      3, LPP.POWER, 0x00, 0x06, // 6 W
    ];
    expect(parseCayenneLpp(bytes)).toEqual([
      { channel: 1, type: LPP.VOLTAGE, value: 4.1 },
      { channel: 2, type: LPP.TEMPERATURE, value: 22.5 },
      { channel: 2, type: LPP.RELATIVE_HUMIDITY, value: 45 },
      { channel: 2, type: LPP.BAROMETRIC_PRESSURE, value: 1015.5 },
      { channel: 2, type: LPP.ALTITUDE, value: 123 },
      { channel: 3, type: LPP.VOLTAGE, value: 12.4 },
      { channel: 3, type: LPP.CURRENT, value: 0.5 },
      { channel: 3, type: LPP.POWER, value: 6 },
    ]);
  });

  it('decodes signed altitude, analog input, frequency, distance and energy', () => {
    const bytes = [
      1, LPP.ALTITUDE, 0xff, 0xf6, // -10 m
      1, LPP.ANALOG_INPUT, 0xff, 0x9c, // -1.00
      1, LPP.FREQUENCY, 0x00, 0x00, 0x03, 0xe8, // 1000 Hz
      1, LPP.DISTANCE, 0x80, 0x00, 0x00, 0x00, // 2147483.648 m (unsigned)
      1, LPP.ENERGY, 0x00, 0x00, 0x04, 0xd2, // 1.234
    ];
    expect(parseCayenneLpp(bytes).map((r) => r.value)).toEqual([-10, -1, 1000, 2147483.648, 1.234]);
  });

  it('decodes GPS and three-axis records as objects', () => {
    const bytes = [
      1, LPP.GPS, 0x05, 0x46, 0x4f, 0xff, 0x0c, 0x3d, 0x00, 0x27, 0x10, // 34.5679, -6.2403, 100 m
      1, LPP.ACCELEROMETER, 0x03, 0xe8, 0xfc, 0x18, 0x00, 0x00,
    ];
    const recs = parseCayenneLpp(bytes);
    expect(recs[0].value).toEqual({ latitude: 34.5679, longitude: -6.2403, altitude: 100 });
    expect(recs[1].value).toEqual({ x: 1, y: -1, z: 0 });
  });

  it('stops at padding, unknown types and truncated records, keeping prior records', () => {
    expect(parseCayenneLpp([1, LPP.PERCENTAGE, 50, 0, 0, 1, LPP.PERCENTAGE, 60])).toHaveLength(1);
    expect(parseCayenneLpp([1, LPP.PERCENTAGE, 50, 1, 250, 1, LPP.PERCENTAGE, 60])).toHaveLength(1);
    expect(parseCayenneLpp([1, LPP.PERCENTAGE, 50, 1, LPP.FREQUENCY, 0x00, 0x01])).toHaveLength(1);
    expect(parseCayenneLpp(new Uint8Array([]))).toEqual([]);
  });
});
