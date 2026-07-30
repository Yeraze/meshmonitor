import { describe, it, expect } from 'vitest';
import { meshcoreLastHeardMs, meshcoreAgeCutoffMs, isWithinMeshcoreAge } from './meshcoreAge';

describe('meshcoreAge', () => {
  describe('meshcoreLastHeardMs', () => {
    it('prefers lastHeard (ms) over lastSeen and lastAdvert', () => {
      expect(
        meshcoreLastHeardMs({ lastHeard: 1_700_000_000_000, lastSeen: 1_600_000_000_000, lastAdvert: 1_500_000_000 }),
      ).toBe(1_700_000_000_000);
    });

    it('uses lastSeen (ms) when lastHeard is absent', () => {
      expect(meshcoreLastHeardMs({ lastSeen: 1_600_000_000_000, lastAdvert: 1_500_000_000 })).toBe(
        1_600_000_000_000,
      );
    });

    it('converts lastAdvert (s) to ms when lastHeard and lastSeen are absent', () => {
      expect(meshcoreLastHeardMs({ lastAdvert: 1_700_000_000 })).toBe(1_700_000_000_000);
    });

    it('leaves an already-ms lastAdvert unchanged (magnitude guard)', () => {
      expect(meshcoreLastHeardMs({ lastAdvert: 1_700_000_000_000 })).toBe(1_700_000_000_000);
    });

    it('returns null when all fields are absent, null, or 0', () => {
      expect(meshcoreLastHeardMs({})).toBeNull();
      expect(meshcoreLastHeardMs({ lastHeard: null, lastSeen: null, lastAdvert: null })).toBeNull();
      expect(meshcoreLastHeardMs({ lastHeard: 0, lastSeen: 0, lastAdvert: 0 })).toBeNull();
    });
  });

  describe('meshcoreAgeCutoffMs', () => {
    it('subtracts maxAgeHours (in ms) from nowMs', () => {
      expect(meshcoreAgeCutoffMs(24, 1_000_000_000_000)).toBe(1_000_000_000_000 - 86_400_000);
    });
  });

  describe('isWithinMeshcoreAge', () => {
    it('is true exactly at the cutoff and false one ms before it', () => {
      const cutoffMs = 1_000_000_000_000;
      expect(isWithinMeshcoreAge({ lastHeard: cutoffMs }, cutoffMs)).toBe(true);
      expect(isWithinMeshcoreAge({ lastHeard: cutoffMs - 1 }, cutoffMs)).toBe(false);
    });

    it('excludes a row with no resolvable timestamp', () => {
      expect(isWithinMeshcoreAge({}, 1_000_000_000_000)).toBe(false);
    });

    it('unit-confusion guard: a lastSeen 2h ago in ms passes a 24h cutoff', () => {
      const nowMs = 1_700_000_000_000;
      const cutoffMs = meshcoreAgeCutoffMs(24, nowMs);
      const twoHoursAgoMs = nowMs - 2 * 3600 * 1000;
      // If this value were wrongly treated as seconds, it would resolve to a
      // year-1970-ish instant and fail the cutoff. It must pass.
      expect(isWithinMeshcoreAge({ lastSeen: twoHoursAgoMs }, cutoffMs)).toBe(true);
    });
  });
});
