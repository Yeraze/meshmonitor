/**
 * @vitest-environment jsdom
 *
 * ReticulumInfoView (#3960 Phase 1b WP5) — status/health panel driven purely
 * by the `status` prop (no fetching of its own). Covers: loading/empty
 * states, disconnected state, and the RNS/bridge version fields WP-B added
 * to `ReticulumStatus` (null → placeholder vs. present → the literal
 * string).
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReticulumInfoView } from './ReticulumInfoView';
import type { ReticulumStatus, ReticulumInterfaceRow } from '../../types/reticulum';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

function baseStatus(overrides: Partial<ReticulumStatus> = {}): ReticulumStatus {
  return {
    connected: true,
    mode: 'attach',
    interfaceCount: 2,
    destinationCount: 5,
    ...overrides,
  };
}

/** A ReticulumInterfaceRow with every live gauge null — override as needed. */
function makeIface(overrides: Partial<ReticulumInterfaceRow> = {}): ReticulumInterfaceRow {
  return {
    sourceId: 'src-1',
    interfaceName: 'iface',
    interfaceType: 'TCPClientInterface',
    interfaceHash: null,
    mode: 'full',
    status: 'up',
    online: true,
    bitrate: null,
    txBytes: 0,
    rxBytes: 0,
    lastSeenAt: 0,
    createdAt: 0,
    updatedAt: 0,
    frequency: null,
    bandwidth: null,
    spreadingFactor: null,
    codingRate: null,
    txPower: null,
    stAlock: null,
    ltAlock: null,
    radioState: null,
    deviceInfoJson: null,
    airtimeShort: null,
    airtimeLong: null,
    channelLoadShort: null,
    channelLoadLong: null,
    noiseFloor: null,
    interference: null,
    interferenceLastTs: null,
    interferenceLastDbm: null,
    cpuLoad: null,
    batteryState: null,
    batteryPercent: null,
    ...overrides,
  };
}

describe('ReticulumInfoView', () => {
  it('shows a loading message when status is null and loading is true', () => {
    render(<ReticulumInfoView status={null} loading />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows a no-status message when status is null and not loading', () => {
    render(<ReticulumInfoView status={null} />);
    expect(screen.getByText(/no status/i)).toBeInTheDocument();
  });

  it('renders the connected state, mode, and counts', () => {
    render(<ReticulumInfoView status={baseStatus()} />);
    expect(screen.getByTestId('reticulum-info-view')).toBeInTheDocument();
    expect(screen.getByTestId('reticulum-info-status-chip')).toHaveTextContent(/connected/i);
    expect(screen.getByTestId('reticulum-info-mode')).toHaveTextContent(/attach/i);
    expect(screen.getByTestId('reticulum-info-interface-count')).toHaveTextContent('2');
    expect(screen.getByTestId('reticulum-info-destination-count')).toHaveTextContent('5');
  });

  it('renders the disconnected state', () => {
    render(<ReticulumInfoView status={baseStatus({ connected: false, mode: undefined })} />);
    expect(screen.getByTestId('reticulum-info-status-chip')).toHaveTextContent(/disconnected/i);
    expect(screen.getByTestId('reticulum-info-mode')).toHaveTextContent(/unknown/i);
  });

  it('renders tcp_peer mode', () => {
    render(<ReticulumInfoView status={baseStatus({ mode: 'tcp_peer' })} />);
    expect(screen.getByTestId('reticulum-info-mode')).toHaveTextContent(/tcp peer/i);
  });

  it('shows placeholders when rnsVersion/bridgeVersion are absent', () => {
    render(<ReticulumInfoView status={baseStatus()} />);
    expect(screen.getByTestId('reticulum-info-rns-version')).toHaveTextContent('—');
    expect(screen.getByTestId('reticulum-info-bridge-version')).toHaveTextContent(/unknown/i);
  });

  it('shows the actual RNS/bridge version strings when present', () => {
    render(<ReticulumInfoView status={baseStatus({ rnsVersion: '0.8.1', bridgeVersion: '1.2.3' })} />);
    expect(screen.getByTestId('reticulum-info-rns-version')).toHaveTextContent('0.8.1');
    expect(screen.getByTestId('reticulum-info-bridge-version')).toHaveTextContent('1.2.3');
  });

  // ── Interface status card (#6120) ─────────────────────────────────────────

  it('hides the interface-status section entirely when no interface reports a gauge', () => {
    render(
      <ReticulumInfoView
        status={baseStatus()}
        interfaces={[makeIface({ interfaceName: 'AutoInterface', interfaceType: 'AutoInterface' })]}
      />,
    );
    expect(screen.queryByTestId('reticulum-info-interface-status')).toBeNull();
  });

  it('renders a status card and shows only the rows that have a value (hides empty rows)', () => {
    // An RNode interface that reports battery + channel load + noise floor, but
    // NOT airtime, interference, or CPU load — the absent fields must not render.
    render(
      <ReticulumInfoView
        status={baseStatus()}
        interfaces={[
          makeIface({
            interfaceName: 'RNode LoRa Interface',
            interfaceType: 'RNodeInterface',
            batteryPercent: 100,
            batteryState: 'discharging',
            channelLoadShort: 2.44,
            channelLoadLong: 1.15,
            noiseFloor: -109,
          }),
        ]}
      />,
    );

    expect(screen.getByTestId('reticulum-info-interface-status')).toBeInTheDocument();
    const card = screen.getByTestId('reticulum-info-iface-RNode LoRa Interface');
    expect(card).toBeInTheDocument();

    // Present rows render...
    expect(screen.getByTestId('reticulum-info-iface-RNode LoRa Interface-battery')).toHaveTextContent('100% (discharging)');
    expect(screen.getByTestId('reticulum-info-iface-RNode LoRa Interface-channel_load')).toHaveTextContent('2.44% (15s) · 1.15% (1h)');
    expect(screen.getByTestId('reticulum-info-iface-RNode LoRa Interface-noise_floor')).toHaveTextContent('-109 dBm');

    // ...absent ones do not.
    expect(screen.queryByTestId('reticulum-info-iface-RNode LoRa Interface-airtime')).toBeNull();
    expect(screen.queryByTestId('reticulum-info-iface-RNode LoRa Interface-interference')).toBeNull();
    expect(screen.queryByTestId('reticulum-info-iface-RNode LoRa Interface-cpu_load')).toBeNull();
  });

  it('skips interfaces that report nothing but still renders the one that does', () => {
    render(
      <ReticulumInfoView
        status={baseStatus()}
        interfaces={[
          makeIface({ interfaceName: 'AutoInterface', interfaceType: 'AutoInterface' }),
          makeIface({ interfaceName: 'RNode LoRa Interface', interfaceType: 'RNodeInterface', airtimeLong: 0.12 }),
        ]}
      />,
    );
    expect(screen.getByTestId('reticulum-info-iface-RNode LoRa Interface')).toBeInTheDocument();
    expect(screen.queryByTestId('reticulum-info-iface-AutoInterface')).toBeNull();
    expect(screen.getByTestId('reticulum-info-iface-RNode LoRa Interface-airtime')).toHaveTextContent('0.12% (1h)');
  });
});
