import { describe, it, expect } from 'vitest';
import { createWalkaboutSampler } from './walkaboutSampler';

const fix = (timestamp: number, accuracy = 10) => ({ latitude: 1, longitude: 2, accuracy, timestamp });

describe('walkaboutSampler', () => {
  it('spaces fixes by exactly 5 s on the fix timestamp', () => {
    const s = createWalkaboutSampler();
    expect(s.offer(fix(1_000))).toBe('queued');
    expect(s.offer(fix(5_999))).toBe('too-soon');
    expect(s.offer(fix(6_000))).toBe('queued');
  });

  it('refuses accuracy over 100 m and accepts exactly 100 m', () => {
    const s = createWalkaboutSampler();
    expect(s.offer(fix(1_000, 100.5))).toBe('inaccurate');
    expect(s.offer(fix(1_000, 100))).toBe('queued');
    expect(s.pending()).toBe(1);
  });

  it('does not let a refused fix move the spacing baseline', () => {
    const s = createWalkaboutSampler();
    s.offer(fix(1_000));
    expect(s.offer(fix(6_000, 500))).toBe('inaccurate');
    expect(s.offer(fix(6_000))).toBe('queued');
  });

  it('rebases after the phone clock jumps far backwards', () => {
    const s = createWalkaboutSampler();
    s.offer(fix(1_000_000));
    expect(s.offer(fix(990_000))).toBe('too-soon');
    expect(s.offer(fix(900_000))).toBe('queued');
  });

  it('takeBatch returns at most 4, newest last, with deviceFixAt and ageMs', () => {
    const s = createWalkaboutSampler();
    for (let i = 0; i < 6; i++) s.offer(fix(10_000 + i * 5_000));
    const batch = s.takeBatch(50_000);
    expect(batch).toHaveLength(4);
    expect(batch.map((b) => b.deviceFixAt)).toEqual([20_000, 25_000, 30_000, 35_000]);
    expect(batch[3]).toMatchObject({ accuracyM: 10, ageMs: 15_000, latitude: 1, longitude: 2 });
    expect(s.takeBatch(60_000)).toEqual([]);
  });

  it('requeue puts failed samples back, keeps the newest 4, and re-ages them', () => {
    const s = createWalkaboutSampler();
    s.offer(fix(10_000));
    s.offer(fix(15_000));
    const failed = s.takeBatch(16_000);
    s.offer(fix(20_000));
    s.offer(fix(25_000));
    s.offer(fix(30_000));
    s.requeue(failed);
    const batch = s.takeBatch(40_000);
    expect(batch.map((b) => b.deviceFixAt)).toEqual([15_000, 20_000, 25_000, 30_000]);
    expect(batch[0].ageMs).toBe(25_000);
  });
});
