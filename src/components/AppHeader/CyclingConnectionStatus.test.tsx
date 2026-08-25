/**
 * @vitest-environment jsdom
 *
 * #4917: the header connection badge cycles Connected → Battery → Airtime for
 * the local node when connected and telemetry is available, and stays a plain
 * status badge otherwise.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { CyclingConnectionStatus } from './CyclingConnectionStatus';

// react-i18next is globally mocked in src/test/setup.ts (t(key) => key).

const ROTATE_MS = 5000;

function label(container: HTMLElement): string {
  return container.querySelector('.connection-status-label')?.textContent ?? '';
}

describe('CyclingConnectionStatus (#4917)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows only the status face when disconnected, and never rotates', () => {
    const { container } = render(
      <CyclingConnectionStatus
        connectionStatus="disconnected"
        connectionStatusText="Disconnected"
        webSocketConnected={false}
        metrics={{ batteryLevel: 85, voltage: 3.9, channelUtilization: 12, airUtilTx: 3.2 }}
        onClick={() => {}}
        title="t"
      />,
    );
    expect(label(container)).toBe('Disconnected');
    // Even after several intervals it stays put — battery/airtime require a
    // connected link.
    act(() => vi.advanceTimersByTime(ROTATE_MS * 3));
    expect(label(container)).toBe('Disconnected');
  });

  it('rotates Connected → Battery → Airtime → back when connected with telemetry', () => {
    const { container } = render(
      <CyclingConnectionStatus
        connectionStatus="connected"
        connectionStatusText="connected"
        webSocketConnected={true}
        metrics={{ batteryLevel: 85, voltage: 3.9, channelUtilization: 12, airUtilTx: 3.2 }}
        onClick={() => {}}
        title="t"
      />,
    );
    expect(label(container)).toBe('connected');

    act(() => vi.advanceTimersByTime(ROTATE_MS));
    expect(label(container)).toContain('85%');
    expect(label(container)).toContain('3.90V');

    act(() => vi.advanceTimersByTime(ROTATE_MS));
    expect(label(container)).toContain('12.0%'); // channel utilization
    expect(label(container)).toContain('3.2%');  // air util tx

    act(() => vi.advanceTimersByTime(ROTATE_MS));
    expect(label(container)).toBe('connected');
  });

  it('shows the plugged-in face when batteryLevel is 101', () => {
    const { container } = render(
      <CyclingConnectionStatus
        connectionStatus="connected"
        connectionStatusText="connected"
        webSocketConnected={true}
        metrics={{ batteryLevel: 101, voltage: 4.2 }}
        onClick={() => {}}
        title="t"
      />,
    );
    // Battery is the only extra face here (no airtime metrics).
    act(() => vi.advanceTimersByTime(ROTATE_MS));
    expect(label(container)).toContain('header.pluggedIn');
    expect(label(container)).toContain('4.20V');
    // Charging icon, not the plain battery icon.
    expect(container.querySelector('[data-ui-icon="batteryCharging"]')).toBeTruthy();
    expect(container.querySelector('.connection-status-label [data-ui-icon="battery"]')).toBeNull();

    // With only status + battery, it toggles back to status next tick.
    act(() => vi.advanceTimersByTime(ROTATE_MS));
    expect(label(container)).toBe('connected');
  });

  it('does not rotate when connected but no telemetry is present', () => {
    const { container } = render(
      <CyclingConnectionStatus
        connectionStatus="connected"
        connectionStatusText="connected"
        webSocketConnected={true}
        metrics={undefined}
        onClick={() => {}}
        title="t"
      />,
    );
    expect(label(container)).toBe('connected');
    act(() => vi.advanceTimersByTime(ROTATE_MS * 2));
    expect(label(container)).toBe('connected');
  });
});
