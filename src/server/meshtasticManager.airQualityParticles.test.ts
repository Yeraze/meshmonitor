/**
 * Regression test for air-quality particle telemetry ingestion.
 *
 * protobuf.js only camelCases an underscore followed by a *letter*, so the
 * AirQualityMetrics fields `particles_03um … particles_100um` (underscore before
 * a digit) stay snake_case on the decoded message. The serial/direct ingestion
 * path read them as `particles03um` (camelCase) → undefined → the particle data
 * was silently dropped and never graphed. Same quirk affects EnvironmentMetrics
 * `rainfall_1h` / `rainfall_24h`.
 *
 * These tests feed the processor a payload shaped exactly as protobuf.js decodes
 * it (snake_case for the digit fields) and assert the rows are stored under the
 * canonical camelCase telemetryType the UI graphs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInsertTelemetry = vi.fn();
const mockUpsertNode = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/database.js', () => ({
  default: {
    telemetry: { insertTelemetry: mockInsertTelemetry },
    nodes: { upsertNode: mockUpsertNode, getAllNodes: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Find the value stored for a given canonical telemetryType, or undefined. */
function storedValue(type: string): number | undefined {
  const call = mockInsertTelemetry.mock.calls.find((c) => c[0]?.telemetryType === type);
  return call?.[0]?.value;
}
function storedTypes(): string[] {
  return mockInsertTelemetry.mock.calls.map((c) => c[0]?.telemetryType);
}

describe('MeshtasticManager - air-quality particle telemetry (protobuf.js snake_case quirk)', () => {
  let manager: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await import('./meshtasticManager.js');
    manager = module.fallbackManager;
    // trackPKIEncryption hits other state/DB; not under test here.
    vi.spyOn(manager, 'trackPKIEncryption').mockResolvedValue(undefined);
  });

  const meshPacket = { from: 0x11111111, id: 42 };

  it('stores particle counts decoded under snake_case names as canonical camelCase types', async () => {
    // Shape matches protobuf.js output: particles_* stay snake_case, letter
    // fields (pm10Standard, co2Temperature) come through camelCased.
    await manager.processTelemetryMessageProtobuf(meshPacket, {
      time: 1781393171,
      airQualityMetrics: {
        pm10Standard: 0,
        particles_03um: 123,
        particles_05um: 35,
        particles_10um: 0,
        particles_25um: 0,
        particles_50um: 0,
        particles_100um: 0,
        co2Temperature: 23.96,
        co2Humidity: 49.72,
      },
    });

    expect(storedValue('particles03um')).toBe(123);
    expect(storedValue('particles05um')).toBe(35);
    // Zero is a real reading and must still be stored.
    expect(storedValue('particles10um')).toBe(0);
    expect(storedValue('particles25um')).toBe(0);
    expect(storedValue('particles50um')).toBe(0);
    expect(storedValue('particles100um')).toBe(0);
    // Letter fields keep working.
    expect(storedValue('co2Temperature')).toBeCloseTo(23.96, 2);
    expect(storedValue('co2Humidity')).toBeCloseTo(49.72, 2);
  });

  it('still works if a future decoder emits camelCase particle names', async () => {
    await manager.processTelemetryMessageProtobuf(meshPacket, {
      airQualityMetrics: { particles03um: 200, particles05um: 50 },
    });
    expect(storedValue('particles03um')).toBe(200);
    expect(storedValue('particles05um')).toBe(50);
  });

  it('stores the newer particles_40um / pm40_standard / pm_voc_idx fields now they have units (#3507)', async () => {
    // After #3506 unified serial ingest onto the canonical normalizer, adding a
    // unit in telemetryKeys.ts is all it takes for these to be ingested — even
    // the underscore-before-digit particles_40um.
    await manager.processTelemetryMessageProtobuf(meshPacket, {
      airQualityMetrics: { particles_40um: 17, pm40_standard: 8, pm_voc_idx: 142 },
    });
    expect(storedValue('particles40um')).toBe(17);
    expect(storedValue('pm40Standard')).toBe(8);
    expect(storedValue('pmVocIdx')).toBe(142);
  });

  it('stores rainfall_1h / rainfall_24h decoded under snake_case names', async () => {
    await manager.processTelemetryMessageProtobuf(meshPacket, {
      environmentMetrics: {
        temperature: 20,
        rainfall_1h: 2.5,
        rainfall_24h: 11.0,
      },
    });
    expect(storedValue('rainfall1h')).toBeCloseTo(2.5, 3);
    expect(storedValue('rainfall24h')).toBeCloseTo(11.0, 3);
  });

  it('does not store a particle type when neither name form is present', async () => {
    await manager.processTelemetryMessageProtobuf(meshPacket, {
      airQualityMetrics: { co2: 400 },
    });
    expect(storedTypes()).toContain('co2');
    expect(storedTypes()).not.toContain('particles03um');
  });
});
