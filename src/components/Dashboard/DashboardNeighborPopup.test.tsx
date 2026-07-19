/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import DashboardNeighborPopup from './DashboardNeighborPopup';

const recent = Date.now() - 2 * 60 * 1000; // 2 minutes ago (ms)

describe('DashboardNeighborPopup', () => {
  it('exposes BOTH directions of a bidirectional link (issue #3777)', () => {
    render(
      <DashboardNeighborPopup
        link={{
          nodeNum: 10,
          neighborNodeNum: 20,
          nodeName: 'Alpha',
          neighborName: 'Bravo',
          bidirectional: true,
          transportClass: 'rf',
          snr: 5.25,
          timestamp: recent,
          reverseSnr: -2.5,
          reverseTimestamp: recent,
        }}
      />,
    );

    // Header shows both endpoints with a bidirectional indicator.
    const title = screen.getByText((_, element) => element?.classList.contains('node-popup-title') ?? false);
    expect(title).toHaveTextContent(/Alpha.*Bravo/);
    expect(title.querySelector('[data-ui-icon="bidirectional"]')).toBeInTheDocument();
    expect(screen.getByText(/Bidirectional/)).toBeInTheDocument();

    // Forward direction: Alpha → Bravo with its own SNR.
    expect(screen.getByText(/Alpha to Bravo: SNR 5\.25 dB/)).toBeInTheDocument();
    // Reverse direction: Bravo → Alpha with the reverse SNR (would be lost
    // without the reverse-data backfill).
    expect(screen.getByText(/Bravo to Alpha: SNR -2\.50 dB/)).toBeInTheDocument();
  });

  it('shows a single direction and a one-way indicator when not bidirectional', () => {
    render(
      <DashboardNeighborPopup
        link={{
          nodeNum: 1,
          neighborNodeNum: 2,
          nodeName: 'Solo',
          neighborName: 'Mate',
          bidirectional: false,
          transportClass: 'mqtt',
          snr: 8,
          timestamp: recent,
          reverseSnr: null,
        }}
      />,
    );

    // Exact match targets the header title (the SNR row's text is longer).
    const title = screen.getByText((_, element) => element?.classList.contains('node-popup-title') ?? false);
    expect(title).toHaveTextContent(/Solo.*Mate/);
    expect(title.querySelector('[data-ui-icon="forward"]')).toBeInTheDocument();
    expect(screen.getByText(/One-way · MQTT/)).toBeInTheDocument();
    expect(screen.getByText(/Solo to Mate: SNR 8\.00 dB/)).toBeInTheDocument();
    // No reverse row when there's no reverse data.
    expect(screen.queryByText(/Mate to Solo/)).not.toBeInTheDocument();
  });

  it('renders an em dash when a direction has no SNR', () => {
    render(
      <DashboardNeighborPopup
        link={{
          nodeNum: 3,
          neighborNodeNum: 4,
          nodeName: 'X',
          neighborName: 'Y',
          bidirectional: true,
          transportClass: 'rf',
          snr: null,
          timestamp: recent,
          reverseSnr: 1.5,
          reverseTimestamp: recent,
        }}
      />,
    );

    expect(screen.getByText(/X to Y: SNR —/)).toBeInTheDocument();
    expect(screen.getByText(/Y to X: SNR 1\.50 dB/)).toBeInTheDocument();
  });
});
