/**
 * The root finder's offline geocoder wiring (#6336): the place is resolved
 * once at start, from the server-side position only, and never logged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../../../utils/logger.js';
import { RootFinderService } from './rootFinderService.js';
import type { Place } from './ladder.js';
import type { RootSamplerOptions, SamplerSnapshot } from './rootSampler.js';

class StubSampler {
  constructor(public readonly opts: RootSamplerOptions) {}
  async start() {}
  getStatus() {
    return 'sampling' as const;
  }
  snapshot(): SamplerSnapshot {
    return { status: 'sampling', elapsedMs: 0, durationMs: 60_000, regionFloor: false, heard: [] };
  }
  getEndedAt() {
    return null;
  }
  async cancel() {}
}

const PLACE: Place = { cc: 'US', subdivisionName: 'Washington', subdivisionIso: 'US-WA', city: 'Zzyzxville' };
const POS = { lat: 47.6062, lon: -122.3321 };

function make(geocoder: (pos: { lat: number; lon: number }) => Place | undefined) {
  return new RootFinderService({ createSampler: (o) => new StubSampler(o) as any, geocoder });
}

const params = (over: Record<string, unknown> = {}) => ({
  userId: 1,
  endpointKey: 'mqtt.example:1883:false',
  broker: { url: 'mqtt://mqtt.example:1883' },
  regionRoot: 'msh/US',
  ...over,
});

beforeEach(() => {
  for (const fn of Object.values(logger)) vi.mocked(fn).mockClear();
});

describe('RootFinderService geocoder', () => {
  it('resolves the place once at start and builds subdivision and city rows', () => {
    const geocoder = vi.fn(() => PLACE);
    const svc = make(geocoder);
    const { sampleId } = svc.start(params({ userPos: POS }));
    expect(geocoder).toHaveBeenCalledTimes(1);
    expect(geocoder).toHaveBeenCalledWith(POS);

    const view = svc.get(1, sampleId)!;
    svc.get(1, sampleId);
    expect(geocoder).toHaveBeenCalledTimes(1);
    expect(view.hasLocation).toBe(true);
    expect(view.ladder.map((r) => [r.kind, r.root])).toEqual(
      expect.arrayContaining([
        ['subdivision', 'msh/US/WA'],
        ['city', 'msh/US/WA/zzyzxville'],
      ]),
    );
  });

  it('does not call the geocoder without a position', () => {
    const geocoder = vi.fn(() => PLACE);
    const svc = make(geocoder);
    const { sampleId } = svc.start(params());
    expect(geocoder).not.toHaveBeenCalled();
    expect(svc.get(1, sampleId)!.ladder.map((r) => r.root)).toEqual(['msh/US']);
  });

  it('a caller-supplied place wins over the geocoder', () => {
    const geocoder = vi.fn(() => PLACE);
    const svc = make(geocoder);
    const own: Place = { cc: 'US', subdivisionName: 'Texas', subdivisionIso: 'US-TX' };
    const { sampleId } = svc.start(params({ userPos: POS, place: own }));
    expect(geocoder).not.toHaveBeenCalled();
    expect(svc.get(1, sampleId)!.ladder.map((r) => r.root)).toContain('msh/US/TX');
  });

  it('a geocoder that throws or finds nothing leaves the region-only ladder', () => {
    for (const geocoder of [
      () => {
        throw new Error('boom');
      },
      () => undefined,
    ]) {
      const svc = make(geocoder);
      const { sampleId } = svc.start(params({ userPos: POS }));
      const view = svc.get(1, sampleId)!;
      expect(view.ladder.map((r) => r.root)).toEqual(['msh/US']);
      expect(view.hasLocation).toBe(true);
    }
  });

  it('never logs the place or the position, and never returns them', () => {
    const svc = make(() => PLACE);
    const { sampleId } = svc.start(params({ userPos: POS }));
    const view = svc.get(1, sampleId)!;
    const logged = JSON.stringify(Object.values(logger).map((fn) => vi.mocked(fn).mock.calls));
    expect(logged).not.toMatch(/Zzyzx|Washington|US-WA|47\.6|122\.3/);
    const text = JSON.stringify(view);
    expect(text).not.toMatch(/"(lat|lon|lng|latitude|longitude|place|subdivisionName|subdivisionIso)"/);
    expect(text).not.toContain('47.6');
  });
});
