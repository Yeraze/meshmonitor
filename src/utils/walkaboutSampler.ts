/**
 * Walkabout client sampler (#5891 P1, spec §2.9). Pure: no timers, no DOM.
 * Applies the same accuracy and spacing rules as the server so the phone does
 * not send fixes the server would drop.
 */
import {
  WALKABOUT_MAX_ACCURACY_M,
  WALKABOUT_MAX_SAMPLES_PER_POST,
  WALKABOUT_MIN_SAMPLE_SPACING_MS,
  WALKABOUT_CLOCK_RESET_MS,
} from './walkabout.js';
import type { WalkaboutSampleInput } from '../types/walkabout.js';

export interface WalkaboutFix {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: number;
}

export type WalkaboutOffer = 'queued' | 'too-soon' | 'inaccurate';

export interface WalkaboutSampler {
  offer(fix: WalkaboutFix): WalkaboutOffer;
  takeBatch(nowMs: number): WalkaboutSampleInput[];
  requeue(batch: WalkaboutSampleInput[]): void;
  pending(): number;
}

export function createWalkaboutSampler(): WalkaboutSampler {
  // Fixes wait here; ageMs is computed at send time, so a requeued fix is re-aged.
  let fixes: WalkaboutFix[] = [];
  let lastAcceptedAt: number | null = null;

  const newest = (list: WalkaboutFix[]) => list.slice(-WALKABOUT_MAX_SAMPLES_PER_POST);

  return {
    offer(fix) {
      if (!(fix.accuracy <= WALKABOUT_MAX_ACCURACY_M)) return 'inaccurate';
      if (lastAcceptedAt !== null) {
        const delta = fix.timestamp - lastAcceptedAt;
        // A clock reset far backwards rebases; a small step back is a duplicate.
        const reset = delta <= -WALKABOUT_CLOCK_RESET_MS;
        if (!reset && delta < WALKABOUT_MIN_SAMPLE_SPACING_MS) return 'too-soon';
      }
      lastAcceptedAt = fix.timestamp;
      fixes = newest([...fixes, fix]);
      return 'queued';
    },
    takeBatch(nowMs) {
      const batch = fixes.map((f) => ({
        latitude: f.latitude,
        longitude: f.longitude,
        accuracyM: f.accuracy,
        deviceFixAt: f.timestamp,
        ageMs: Math.max(0, nowMs - f.timestamp),
      }));
      fixes = [];
      return batch;
    },
    requeue(batch) {
      const back = batch.map((s) => ({
        latitude: s.latitude,
        longitude: s.longitude,
        accuracy: s.accuracyM,
        timestamp: s.deviceFixAt,
      }));
      fixes = newest([...back, ...fixes]);
    },
    pending() {
      return fixes.length;
    },
  };
}
