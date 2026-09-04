import { describe, it, expect } from 'vitest';
import {
  evaluateFirmware28Silence,
  FIRMWARE_28_SILENCE_THRESHOLD_MS,
  FIRMWARE_28_ACTIVE_WINDOW_MS,
  type Firmware28SilenceInput,
} from './firmware28Silence';

const NOW = 1_800_000_000_000; // fixed clock; every case is relative to this
const HOUR = 60 * 60 * 1000;

/** Heard 1 hour ago — comfortably inside the active window. */
const FRESHLY_HEARD_SECONDS = Math.floor((NOW - HOUR) / 1000);

function input(overrides: Partial<Firmware28SilenceInput> = {}): Firmware28SilenceInput {
  return {
    firmwareVersion: '2.8.0.abcdef',
    lastHeard: FRESHLY_HEARD_SECONDS,
    positionTimestamp: NOW - 2 * FIRMWARE_28_SILENCE_THRESHOLD_MS,
    telemetryTimestamp: NOW - 2 * FIRMWARE_28_SILENCE_THRESHOLD_MS,
    ...overrides,
  };
}

describe('evaluateFirmware28Silence', () => {
  it('fires when a 2.8 node is still heard but position and telemetry are stale', () => {
    const notice = evaluateFirmware28Silence(input(), NOW);
    expect(notice).not.toBeNull();
    expect(notice!.positionSilent).toBe(true);
    expect(notice!.telemetrySilent).toBe(true);
    expect(notice!.positionSilentForMs).toBe(2 * FIRMWARE_28_SILENCE_THRESHOLD_MS);
    expect(notice!.telemetrySilentForMs).toBe(2 * FIRMWARE_28_SILENCE_THRESHOLD_MS);
  });

  it('says nothing for a pre-2.8 node that is equally silent', () => {
    expect(evaluateFirmware28Silence(input({ firmwareVersion: '2.7.11.aabbcc' }), NOW)).toBeNull();
  });

  it('says nothing for an active 2.8 node', () => {
    const notice = evaluateFirmware28Silence(
      input({ positionTimestamp: NOW - HOUR, telemetryTimestamp: NOW - HOUR }),
      NOW,
    );
    expect(notice).toBeNull();
  });

  it('says nothing when the firmware version is unknown (fail open)', () => {
    expect(evaluateFirmware28Silence(input({ firmwareVersion: undefined }), NOW)).toBeNull();
    expect(evaluateFirmware28Silence(input({ firmwareVersion: null }), NOW)).toBeNull();
    expect(evaluateFirmware28Silence(input({ firmwareVersion: '' }), NOW)).toBeNull();
    expect(evaluateFirmware28Silence(input({ firmwareVersion: 'unknown' }), NOW)).toBeNull();
  });

  describe('silence threshold boundary', () => {
    it('fires exactly at the threshold', () => {
      const notice = evaluateFirmware28Silence(
        input({
          positionTimestamp: NOW - FIRMWARE_28_SILENCE_THRESHOLD_MS,
          telemetryTimestamp: null,
        }),
        NOW,
      );
      expect(notice).not.toBeNull();
      expect(notice!.positionSilent).toBe(true);
      expect(notice!.telemetrySilent).toBe(false);
    });

    it('stays quiet one millisecond short of the threshold', () => {
      const notice = evaluateFirmware28Silence(
        input({
          positionTimestamp: NOW - FIRMWARE_28_SILENCE_THRESHOLD_MS + 1,
          telemetryTimestamp: NOW - FIRMWARE_28_SILENCE_THRESHOLD_MS + 1,
        }),
        NOW,
      );
      expect(notice).toBeNull();
    });
  });

  describe('active window boundary', () => {
    it('fires when the node was heard exactly at the edge of the window', () => {
      const lastHeard = Math.floor((NOW - FIRMWARE_28_ACTIVE_WINDOW_MS) / 1000);
      expect(evaluateFirmware28Silence(input({ lastHeard }), NOW)).not.toBeNull();
    });

    it('says nothing once the node has dropped off the mesh entirely', () => {
      const lastHeard = Math.floor((NOW - FIRMWARE_28_ACTIVE_WINDOW_MS - HOUR) / 1000);
      expect(evaluateFirmware28Silence(input({ lastHeard }), NOW)).toBeNull();
    });

    it('says nothing when we have never heard the node', () => {
      expect(evaluateFirmware28Silence(input({ lastHeard: undefined }), NOW)).toBeNull();
      expect(evaluateFirmware28Silence(input({ lastHeard: null }), NOW)).toBeNull();
    });
  });

  describe('"previously sending" requirement', () => {
    it('does not blame a node that never sent position', () => {
      const notice = evaluateFirmware28Silence(
        input({ positionTimestamp: undefined, telemetryTimestamp: undefined }),
        NOW,
      );
      expect(notice).toBeNull();
    });

    it('reports only the half that actually went quiet', () => {
      const notice = evaluateFirmware28Silence(
        input({ positionTimestamp: undefined }),
        NOW,
      );
      expect(notice).not.toBeNull();
      expect(notice!.positionSilent).toBe(false);
      expect(notice!.telemetrySilent).toBe(true);
      expect(notice!.positionSilentForMs).toBeNull();
    });
  });

  describe('non-broadcast positions', () => {
    it('ignores the position clause for a manually overridden position', () => {
      const notice = evaluateFirmware28Silence(
        input({ positionIsOverride: true, telemetryTimestamp: undefined }),
        NOW,
      );
      expect(notice).toBeNull();
    });

    it('ignores the position clause for a trilaterated estimate', () => {
      const notice = evaluateFirmware28Silence(
        input({ positionIsEstimated: true, telemetryTimestamp: undefined }),
        NOW,
      );
      expect(notice).toBeNull();
    });

    it('still reports telemetry silence on an overridden-position node', () => {
      const notice = evaluateFirmware28Silence(input({ positionIsOverride: true }), NOW);
      expect(notice).not.toBeNull();
      expect(notice!.positionSilent).toBe(false);
      expect(notice!.telemetrySilent).toBe(true);
    });
  });

  it('accepts firmware above 2.8 including a numerically larger minor', () => {
    expect(evaluateFirmware28Silence(input({ firmwareVersion: '2.10.0' }), NOW)).not.toBeNull();
    expect(evaluateFirmware28Silence(input({ firmwareVersion: '3.0.0' }), NOW)).not.toBeNull();
  });

  it('ignores non-finite timestamps rather than treating them as ancient', () => {
    const notice = evaluateFirmware28Silence(
      input({ positionTimestamp: Number.NaN, telemetryTimestamp: Number.NaN }),
      NOW,
    );
    expect(notice).toBeNull();
  });
});
