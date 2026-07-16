import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockResolveProvider = vi.hoisted(() => vi.fn());
const mockDetectProviderType = vi.hoisted(() => vi.fn());

vi.mock('./elevationProvider.js', () => ({
  resolveProvider: mockResolveProvider,
  detectProviderType: mockDetectProviderType,
}));

import { calculateDistance } from '../../utils/distance.js';
import { SsrfBlockedError } from '../utils/ssrfGuard.js';
import { stripSecretSettings } from '../constants/settings.js';
import {
  computeProfile,
  testSource,
  MIN_SAMPLES,
  MAX_SAMPLES,
  DEFAULT_SAMPLES,
  MAX_PATH_KM,
  type ProfileResult,
} from './elevationService.js';

/** A stub ElevationProvider whose sample() returns a fixed elevation for every point. */
function stubProvider(type: 'terrarium' | 'json', elevationForEach: (i: number) => number | null) {
  return {
    type,
    sample: vi.fn(async (points: Array<{ lat: number; lng: number }>) =>
      points.map((_, i) => elevationForEach(i))
    ),
  };
}

beforeEach(() => {
  mockResolveProvider.mockReset();
  mockDetectProviderType.mockReset();
  mockDetectProviderType.mockReturnValue('terrarium');
});

describe('computeProfile', () => {
  const pointA = { lat: 39.7392, lng: -104.9903 }; // Denver
  const pointB = { lat: 39.7555, lng: -104.9942 }; // ~1.8km north

  it('happy path: correct sample count, endpoints, distanceMeters, and monotonic distances', async () => {
    const provider = stubProvider('terrarium', () => 1234);
    mockResolveProvider.mockReturnValue(provider);

    const result = (await computeProfile({ pointA, pointB }, undefined)) as ProfileResult;

    expect('code' in result).toBe(false);
    expect(result.samples).toHaveLength(DEFAULT_SAMPLES);
    expect(result.samples[0].lat).toBeCloseTo(pointA.lat, 6);
    expect(result.samples[0].lng).toBeCloseTo(pointA.lng, 6);
    expect(result.samples[result.samples.length - 1].lat).toBeCloseTo(pointB.lat, 6);
    expect(result.samples[result.samples.length - 1].lng).toBeCloseTo(pointB.lng, 6);

    const expectedKm = calculateDistance(pointA.lat, pointA.lng, pointB.lat, pointB.lng);
    expect(result.distanceMeters).toBeCloseTo(expectedKm * 1000, 3);
    expect(result.provider).toBe('terrarium');

    let prevDistance = -1;
    for (const s of result.samples) {
      expect(s.distance).toBeGreaterThanOrEqual(prevDistance);
      prevDistance = s.distance;
    }
    expect(result.samples[result.samples.length - 1].distance).toBeCloseTo(
      result.distanceMeters,
      3
    );
  });

  it('rejects out-of-range latitude with INVALID_COORDINATES', async () => {
    const result = await computeProfile(
      { pointA: { lat: 95, lng: 0 }, pointB },
      undefined
    );
    expect(result).toMatchObject({ code: 'INVALID_COORDINATES', status: 400 });
    expect(mockResolveProvider).not.toHaveBeenCalled();
  });

  it('rejects out-of-range longitude with INVALID_COORDINATES', async () => {
    const result = await computeProfile(
      { pointA, pointB: { lat: 0, lng: 200 } },
      undefined
    );
    expect(result).toMatchObject({ code: 'INVALID_COORDINATES', status: 400 });
  });

  it('rejects NaN coordinates with INVALID_COORDINATES', async () => {
    const result = await computeProfile(
      { pointA: { lat: Number.NaN, lng: 0 }, pointB },
      undefined
    );
    expect(result).toMatchObject({ code: 'INVALID_COORDINATES', status: 400 });
  });

  it('rejects identical points with IDENTICAL_POINTS', async () => {
    const result = await computeProfile({ pointA, pointB: { ...pointA } }, undefined);
    expect(result).toMatchObject({ code: 'IDENTICAL_POINTS', status: 400 });
    expect(mockResolveProvider).not.toHaveBeenCalled();
  });

  it('rejects a path longer than MAX_PATH_KM with PATH_TOO_LONG', async () => {
    // ~667km apart (6 degrees latitude).
    const far = { lat: pointA.lat + 6, lng: pointA.lng };
    const distanceKm = calculateDistance(pointA.lat, pointA.lng, far.lat, far.lng);
    expect(distanceKm).toBeGreaterThan(MAX_PATH_KM);

    const result = await computeProfile({ pointA, pointB: far }, undefined);
    expect(result).toMatchObject({ code: 'PATH_TOO_LONG', status: 400 });
    expect(mockResolveProvider).not.toHaveBeenCalled();
  });

  it('clamps a requested sample count below MIN_SAMPLES up to MIN_SAMPLES', async () => {
    mockResolveProvider.mockReturnValue(stubProvider('terrarium', () => 0));
    const result = (await computeProfile(
      { pointA, pointB, samples: 5 },
      undefined
    )) as ProfileResult;
    expect(result.samples).toHaveLength(MIN_SAMPLES);
  });

  it('clamps a requested sample count above MAX_SAMPLES down to MAX_SAMPLES', async () => {
    mockResolveProvider.mockReturnValue(stubProvider('terrarium', () => 0));
    const result = (await computeProfile(
      { pointA, pointB, samples: 10_000 },
      undefined
    )) as ProfileResult;
    expect(result.samples).toHaveLength(MAX_SAMPLES);
  });

  it('uses DEFAULT_SAMPLES when samples is omitted', async () => {
    mockResolveProvider.mockReturnValue(stubProvider('terrarium', () => 0));
    const result = (await computeProfile({ pointA, pointB }, undefined)) as ProfileResult;
    expect(result.samples).toHaveLength(DEFAULT_SAMPLES);
  });

  it('surfaces void samples as elevation:null rather than an error', async () => {
    const provider = stubProvider('terrarium', (i) => (i % 2 === 0 ? null : 42));
    mockResolveProvider.mockReturnValue(provider);

    const result = (await computeProfile({ pointA, pointB }, undefined)) as ProfileResult;
    expect(result.samples[0].elevation).toBeNull();
    expect(result.samples[1].elevation).toBe(42);
  });

  it('passes the sourceUrl through to resolveProvider', async () => {
    mockResolveProvider.mockReturnValue(stubProvider('json', () => 1));
    await computeProfile({ pointA, pointB }, 'https://api.example.com/v1/dem');
    expect(mockResolveProvider).toHaveBeenCalledWith('https://api.example.com/v1/dem');
  });
});

describe('testSource', () => {
  it('reports success with detectedType, sampleElevation, and latencyMs on a working provider', async () => {
    mockDetectProviderType.mockReturnValue('terrarium');
    mockResolveProvider.mockReturnValue(stubProvider('terrarium', () => 8848));

    const result = await testSource('https://example.com/{z}/{x}/{y}.png');

    expect(result.success).toBe(true);
    expect(result.detectedType).toBe('terrarium');
    expect(result.sampleElevation).toBe(8848);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports failure with an error when the provider returns no data', async () => {
    mockDetectProviderType.mockReturnValue('json');
    mockResolveProvider.mockReturnValue(stubProvider('json', () => null));

    const result = await testSource('https://api.example.com/v1/dem');

    expect(result.success).toBe(false);
    expect(result.detectedType).toBe('json');
    expect(result.sampleElevation).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it('reports failure with an error when the provider throws SsrfBlockedError', async () => {
    mockDetectProviderType.mockReturnValue('json');
    mockResolveProvider.mockReturnValue({
      type: 'json',
      sample: vi.fn(async () => {
        throw new SsrfBlockedError('blocked target', 'private');
      }),
    });

    const result = await testSource('http://169.254.169.254/dem');

    expect(result.success).toBe(false);
    expect(result.error).toBe('blocked target');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('uses the supplied probe coordinate when provided', async () => {
    mockDetectProviderType.mockReturnValue('terrarium');
    const provider = stubProvider('terrarium', () => 100);
    mockResolveProvider.mockReturnValue(provider);

    const probe = { lat: 1, lng: 2 };
    await testSource('https://example.com/{z}/{x}/{y}.png', probe);

    expect(provider.sample).toHaveBeenCalledWith([probe]);
  });
});

describe('secrecy guard: elevationSourceUrl is server-only (#4111)', () => {
  it('strips elevationSourceUrl but keeps elevationEnabled for non-admin callers', () => {
    const stripped = stripSecretSettings(
      { elevationSourceUrl: 'https://api.example.com/v1/dem?key=secret', elevationEnabled: 'true' },
      false
    );
    expect(stripped).not.toHaveProperty('elevationSourceUrl');
    expect(stripped.elevationEnabled).toBe('true');
  });

  it('returns both keys unmodified for admin callers', () => {
    const stripped = stripSecretSettings(
      { elevationSourceUrl: 'https://api.example.com/v1/dem?key=secret', elevationEnabled: 'true' },
      true
    );
    expect(stripped.elevationSourceUrl).toBe('https://api.example.com/v1/dem?key=secret');
    expect(stripped.elevationEnabled).toBe('true');
  });
});
