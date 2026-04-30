import { describe, it, expect } from 'vitest';
import { mergeNodeUpdate } from './mergeNodeUpdate';
import type { DeviceInfo } from '../types/device';

const baseNode: DeviceInfo = {
  nodeNum: 1234,
  user: { id: '!000004d2', longName: 'Test', shortName: 'T' },
  position: { latitude: 10, longitude: 20, altitude: 100 },
};

describe('mergeNodeUpdate', () => {
  it('rebuilds position from flat lat/lng/alt when override not active', () => {
    const merged = mergeNodeUpdate(baseNode, {
      latitude: 30,
      longitude: 40,
      altitude: 200,
    } as any);
    expect(merged.position).toEqual({ latitude: 30, longitude: 40, altitude: 200 });
  });

  it('falls back to existing altitude when update has no altitude', () => {
    const merged = mergeNodeUpdate(baseNode, {
      latitude: 30,
      longitude: 40,
    } as any);
    expect(merged.position).toEqual({ latitude: 30, longitude: 40, altitude: 100 });
  });

  it('preserves existing position when update has no lat/lng', () => {
    const merged = mergeNodeUpdate(baseNode, { snr: 5 } as any);
    expect(merged.position).toEqual({ latitude: 10, longitude: 20, altitude: 100 });
  });

  it('does NOT overwrite position when override is active on the merged node (regression: PR #2848 follow-up)', () => {
    const nodeWithOverride: DeviceInfo = {
      ...baseNode,
      positionOverrideEnabled: true,
      latitudeOverride: 50,
      longitudeOverride: 60,
      altitudeOverride: 500,
      position: { latitude: 50, longitude: 60, altitude: 500 },
    } as any;

    const merged = mergeNodeUpdate(nodeWithOverride, {
      latitude: 30,
      longitude: 40,
      altitude: 200,
    } as any);

    // Override coords must remain — incoming device GPS packet must NOT
    // displace the user-set override on the client side.
    expect(merged.position).toEqual({ latitude: 50, longitude: 60, altitude: 500 });
    expect((merged as any).positionOverrideEnabled).toBe(true);
  });

  it('respects override flag arriving in the update itself', () => {
    const merged = mergeNodeUpdate(baseNode, {
      positionOverrideEnabled: true,
      latitudeOverride: 50,
      longitudeOverride: 60,
      latitude: 30,
      longitude: 40,
    } as any);

    // Update enables override AND carries device GPS — override must win.
    expect(merged.position).toEqual({ latitude: 10, longitude: 20, altitude: 100 });
  });

  it('rebuilds position when override is enabled but coords are missing (incomplete override)', () => {
    const incomplete: DeviceInfo = {
      ...baseNode,
      positionOverrideEnabled: true,
      latitudeOverride: null,
      longitudeOverride: null,
    } as any;

    const merged = mergeNodeUpdate(incomplete, {
      latitude: 30,
      longitude: 40,
    } as any);

    expect(merged.position).toEqual({ latitude: 30, longitude: 40, altitude: 100 });
  });

  it('merges non-position fields normally', () => {
    const merged = mergeNodeUpdate(baseNode, { snr: 7.5, rssi: -80 } as any);
    expect(merged.snr).toBe(7.5);
    expect(merged.rssi).toBe(-80);
    expect(merged.position).toEqual(baseNode.position);
  });
});
