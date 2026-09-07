/**
 * @vitest-environment jsdom
 *
 * Traffic Management config section — v2.8 "non-zero implies enabled" schema (#5123).
 *
 * Meshtastic protobufs commit d4f7ddb1 removed nine TrafficManagementConfig
 * fields and reserved their tags. MeshMonitor kept rendering controls for all
 * of them, which silently did nothing on 2.8 firmware — the exact firmware the
 * section is gated to. These tests pin the surviving surface so those controls
 * can't come back.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TrafficManagementConfigSection from './TrafficManagementConfigSection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

vi.mock('../../hooks/useSaveBar', () => ({ useSaveBar: vi.fn() }));

const renderSection = (overrides: Record<string, unknown> = {}) => {
  const setters = {
    setPositionMinIntervalSecs: vi.fn(),
    setNodeinfoDirectResponseMaxHops: vi.fn(),
    setRateLimitWindowSecs: vi.fn(),
    setRateLimitMaxPackets: vi.fn(),
    setUnknownPacketThreshold: vi.fn(),
  };
  render(
    <TrafficManagementConfigSection
      positionMinIntervalSecs={0}
      nodeinfoDirectResponseMaxHops={0}
      rateLimitWindowSecs={0}
      rateLimitMaxPackets={0}
      unknownPacketThreshold={0}
      isDisabled={false}
      isSaving={false}
      onSave={vi.fn().mockResolvedValue(undefined)}
      {...setters}
      {...overrides}
    />
  );
  return setters;
};

describe('TrafficManagementConfigSection (v2.8 schema)', () => {
  it('renders exactly the five retained uint32 knobs', () => {
    renderSection();
    for (const id of [
      'positionMinIntervalSecs',
      'nodeinfoDirectResponseMaxHops',
      'rateLimitWindowSecs',
      'rateLimitMaxPackets',
      'unknownPacketThreshold',
    ]) {
      const input = document.getElementById(id) as HTMLInputElement | null;
      expect(input, `#${id} should render`).not.toBeNull();
      expect(input!.type).toBe('number');
    }
  });

  it('renders none of the nine removed controls', () => {
    renderSection();
    // Removed by protobufs d4f7ddb1 — reserved tags, ignored by 2.8 firmware.
    for (const id of [
      'trafficManagementEnabled',
      'positionDedupEnabled',
      'positionPrecisionBits',
      'nodeinfoDirectResponse',
      'rateLimitEnabled',
      'dropUnknownEnabled',
      'exhaustHopTelemetry',
      'exhaustHopPosition',
      'routerPreserveHops',
    ]) {
      expect(document.getElementById(id), `#${id} should be gone`).toBeNull();
    }
    // No checkbox at all: this section has no on/off toggles any more.
    expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(0);
  });

  it('shows every knob even when all values are 0 (0 is a real, editable state)', () => {
    // The old UI hid each group behind its own enable checkbox, so a config
    // with everything off rendered as an empty section. Under the new schema
    // 0 IS "off", and the user has to be able to type a value to turn it on.
    renderSection();
    expect((document.getElementById('rateLimitMaxPackets') as HTMLInputElement).value).toBe('0');
    expect((document.getElementById('unknownPacketThreshold') as HTMLInputElement).value).toBe('0');
  });

  it('explains that 0 disables and that precision comes from the channel', () => {
    renderSection();
    expect(screen.getByText(/leave it at 0 to turn that feature off/i)).toBeTruthy();
    expect(screen.getByText(/Position Precision setting/i)).toBeTruthy();
  });

  it('propagates edits through the numeric setters', () => {
    const setters = renderSection();
    fireEvent.change(document.getElementById('rateLimitWindowSecs')!, { target: { value: '60' } });
    expect(setters.setRateLimitWindowSecs).toHaveBeenCalledWith(60);
    // Clearing the field must land on 0 ("disabled"), never NaN.
    fireEvent.change(document.getElementById('rateLimitWindowSecs')!, { target: { value: '' } });
    expect(setters.setRateLimitWindowSecs).toHaveBeenLastCalledWith(0);
  });

  it('surfaces the firmware gate when the device is below 2.8.0', () => {
    renderSection({ isDisabled: true });
    expect(screen.getByText(/requires Meshtastic firmware 2.8.0 or newer/i)).toBeTruthy();
    expect((document.getElementById('rateLimitWindowSecs') as HTMLInputElement).disabled).toBe(true);
  });
});
