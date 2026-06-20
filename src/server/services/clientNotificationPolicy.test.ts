/**
 * Client Notification Policy Tests
 *
 * Covers the suppression/throttle policy and the firmware-2.8 protected-node-cap
 * refusal parser used to surface (and reconcile) FromRadio.ClientNotification.
 */

import { describe, it, expect } from 'vitest';
import {
  shouldSuppressToast,
  parseProtectedCapRefusal,
  toastTypeForLevel,
  ToastThrottle,
  NOTIFICATION_LEVEL,
  type ParsedClientNotification,
} from './clientNotificationPolicy.js';

const note = (over: Partial<ParsedClientNotification>): ParsedClientNotification => ({
  level: NOTIFICATION_LEVEL.WARNING,
  message: '',
  ...over,
});

describe('shouldSuppressToast', () => {
  it('suppresses the recurring power-save "sleeping for N interval" INFO spam', () => {
    expect(
      shouldSuppressToast(
        note({
          level: NOTIFICATION_LEVEL.INFO,
          message: 'Sending telemetry and sleeping for 900s interval in a moment',
        }),
      ),
    ).toBe(true);
    expect(
      shouldSuppressToast(
        note({
          level: NOTIFICATION_LEVEL.INFO,
          message: 'Sending position and sleeping for 300s interval in a moment',
        }),
      ),
    ).toBe(true);
  });

  it('suppresses key-verification handshake variants regardless of text', () => {
    expect(
      shouldSuppressToast(
        note({ message: 'Enter Security Number for Key Verification', isKeyVerification: true }),
      ),
    ).toBe(true);
  });

  it('suppresses empty/whitespace messages', () => {
    expect(shouldSuppressToast(note({ message: '' }))).toBe(true);
    expect(shouldSuppressToast(note({ message: '   ' }))).toBe(true);
  });

  it('allows valuable one-shot warnings through', () => {
    expect(
      shouldSuppressToast(
        note({
          message:
            'Remote device 0x12345678 has advertised your public key. This may indicate a compromised key.',
        }),
      ),
    ).toBe(false);
    expect(
      shouldSuppressToast(
        note({ message: 'Duty cycle limit exceeded. You can send again in 3 mins' }),
      ),
    ).toBe(false);
    expect(
      shouldSuppressToast(
        note({
          level: NOTIFICATION_LEVEL.WARNING,
          message: "Can't favorite 0xdeadbeef: protected-node limit (118) reached",
        }),
      ),
    ).toBe(false);
  });
});

describe('parseProtectedCapRefusal', () => {
  it('parses a favorite refusal into verb + nodeNum', () => {
    expect(parseProtectedCapRefusal("Can't favorite 0xdeadbeef: protected-node limit (118) reached")).toEqual({
      verb: 'favorite',
      nodeNum: 0xdeadbeef,
    });
  });

  it('parses an ignore refusal', () => {
    expect(parseProtectedCapRefusal("Can't ignore 0x0a1b2c3d: protected-node limit (118) reached")).toEqual({
      verb: 'ignore',
      nodeNum: 0x0a1b2c3d,
    });
  });

  it('is case-insensitive', () => {
    expect(parseProtectedCapRefusal("CAN'T FAVORITE 0xABCDEF01: PROTECTED-NODE LIMIT (118) REACHED")).toEqual({
      verb: 'favorite',
      nodeNum: 0xabcdef01,
    });
  });

  it('ignores the verify verb (not MeshMonitor-actionable)', () => {
    expect(parseProtectedCapRefusal("Can't verify 0xdeadbeef: protected-node limit (118) reached")).toBeNull();
  });

  it('returns null for unrelated messages (e.g. all 2.7.x notifications)', () => {
    expect(parseProtectedCapRefusal('Duty cycle limit exceeded. You can send again in 3 mins')).toBeNull();
    expect(parseProtectedCapRefusal('Sending telemetry and sleeping for 900s interval in a moment')).toBeNull();
    expect(parseProtectedCapRefusal('')).toBeNull();
  });
});

describe('toastTypeForLevel', () => {
  it('maps levels to severities', () => {
    expect(toastTypeForLevel(NOTIFICATION_LEVEL.CRITICAL)).toBe('error');
    expect(toastTypeForLevel(NOTIFICATION_LEVEL.ERROR)).toBe('error');
    expect(toastTypeForLevel(NOTIFICATION_LEVEL.WARNING)).toBe('warning');
    expect(toastTypeForLevel(NOTIFICATION_LEVEL.INFO)).toBe('info');
    expect(toastTypeForLevel(NOTIFICATION_LEVEL.UNSET)).toBe('info');
  });
});

describe('ToastThrottle', () => {
  it('collapses identical messages within the window (duty-cycle spam → one toast)', () => {
    const t = new ToastThrottle(60_000);
    const key = 'src1::Duty cycle limit exceeded. You can send again in 3 mins';
    expect(t.shouldEmit(key, 1_000)).toBe(true);
    expect(t.shouldEmit(key, 5_000)).toBe(false);
    expect(t.shouldEmit(key, 59_000)).toBe(false);
    // Past the window, it emits again.
    expect(t.shouldEmit(key, 62_000)).toBe(true);
  });

  it('treats different messages and different sources independently', () => {
    const t = new ToastThrottle(60_000);
    expect(t.shouldEmit('src1::A', 1_000)).toBe(true);
    expect(t.shouldEmit('src1::B', 1_000)).toBe(true);
    expect(t.shouldEmit('src2::A', 1_000)).toBe(true);
    // Re-emitting the same per-source key is throttled.
    expect(t.shouldEmit('src1::A', 2_000)).toBe(false);
  });
});
