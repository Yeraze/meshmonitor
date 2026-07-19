/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DashboardNodePopup from './DashboardNodePopup';

vi.mock('../../contexts/SettingsContext', () => ({
  useDisplaySettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));

// The global setup.ts mock for react-i18next ignores `options.defaultValue`
// (it only interpolates `{{token}}` placeholders into the raw key), so it
// can't produce real English text for the family's `t(key, { defaultValue })`
// calls. Override locally — mirrors src/components/map/popups/sections.test.tsx
// — so these assertions exercise the same English copy a real render would
// produce (#4047 Phase 5 WP2: DashboardNodePopup gains i18n, English output
// stays byte-identical).
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      arg2?: string | Record<string, unknown>,
      arg3?: Record<string, unknown>,
    ) => {
      let options: Record<string, unknown> | undefined;
      let defaultValue: string | undefined;
      if (typeof arg2 === 'string') {
        defaultValue = arg2;
        options = arg3;
      } else {
        options = arg2;
        defaultValue = typeof options?.defaultValue === 'string' ? options.defaultValue : undefined;
      }
      let out = defaultValue ?? key;
      if (options) {
        for (const [k, v] of Object.entries(options)) {
          out = out.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
        }
      }
      return out;
    },
  }),
}));

const pos = { lat: 35.12345, lng: -80.6789 };

describe('DashboardNodePopup', () => {
  it('renders name, short name, node ID, role, hardware, and hops from flat fields', () => {
    render(
      <DashboardNodePopup
        pos={pos}
        node={{
          nodeNum: 42,
          nodeId: '!0000002a',
          longName: 'Tower Node',
          shortName: 'TWR',
          role: 2,
          hwModel: 9,
          hopsAway: 3,
          lastHeard: Math.floor(Date.now() / 1000) - 120,
        }}
      />,
    );
    expect(screen.getByText('Tower Node')).toBeInTheDocument();
    expect(screen.getByText('TWR')).toBeInTheDocument();
    expect(screen.getByText('!0000002a')).toBeInTheDocument();
    expect(screen.getByText('3 hops')).toBeInTheDocument();
    // Coordinates always shown
    expect(screen.getByText('35.12345, -80.67890')).toBeInTheDocument();
  });

  it('falls back to nested user/position fields', () => {
    render(
      <DashboardNodePopup
        pos={pos}
        node={{
          nodeNum: 7,
          user: { id: '!00000007', longName: 'Nested Node', shortName: 'NST' },
          position: { altitude: 120 },
          hopsAway: 0,
        }}
      />,
    );
    expect(screen.getByText('Nested Node')).toBeInTheDocument();
    expect(screen.getByText('NST')).toBeInTheDocument();
    expect(screen.getByText('!00000007')).toBeInTheDocument();
    expect(screen.getByText('0 hops')).toBeInTheDocument();
    expect(screen.getByText('120m')).toBeInTheDocument();
  });

  it('renders the per-source list with protocol badges on the unified view', () => {
    render(
      <DashboardNodePopup
        pos={pos}
        node={{
          nodeNum: 100,
          longName: 'Shared Node',
          sources: [
            { sourceId: 'a', sourceName: 'Tower Alpha', protocol: 'Meshtastic' },
            { sourceId: 'b', sourceName: 'Core Bravo', protocol: 'MeshCore' },
          ],
        }}
      />,
    );
    expect(screen.getByText('Seen by 2 sources')).toBeInTheDocument();
    expect(screen.getByText('Tower Alpha')).toBeInTheDocument();
    expect(screen.getByText('Core Bravo')).toBeInTheDocument();
    expect(screen.getByText('Meshtastic')).toBeInTheDocument();
    expect(screen.getByText('MeshCore')).toBeInTheDocument();
  });

  it('calls onSourceSelect with the source and node id when a source row is clicked', () => {
    const onSourceSelect = vi.fn();
    render(
      <DashboardNodePopup
        pos={pos}
        onSourceSelect={onSourceSelect}
        node={{
          nodeNum: 100,
          nodeId: '!00000064',
          longName: 'Shared Node',
          sources: [
            { sourceId: 'a', sourceName: 'Tower Alpha', protocol: 'Meshtastic' },
            { sourceId: 'b', sourceName: 'Core Bravo', protocol: 'MeshCore' },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByText('Core Bravo'));
    expect(onSourceSelect).toHaveBeenCalledWith(
      { sourceId: 'b', sourceName: 'Core Bravo', protocol: 'MeshCore' },
      '!00000064',
    );
  });

  it('renders source rows as disabled (non-clickable) when no onSourceSelect is given', () => {
    render(
      <DashboardNodePopup
        pos={pos}
        node={{
          nodeNum: 100,
          longName: 'Shared Node',
          sources: [{ sourceId: 'a', sourceName: 'Tower Alpha', protocol: 'Meshtastic' }],
        }}
      />,
    );
    const row = screen.getByText('Tower Alpha').closest('button');
    expect(row).toBeDisabled();
  });

  it('omits the sources section for single-source nodes', () => {
    render(
      <DashboardNodePopup
        pos={pos}
        node={{ nodeNum: 1, longName: 'Solo Node' }}
      />,
    );
    expect(screen.queryByText(/Seen by/)).not.toBeInTheDocument();
  });

  it('renders raw (unrounded) SNR and the raw battery percentage, matching the pre-family formatting', () => {
    render(
      <DashboardNodePopup
        pos={pos}
        node={{ nodeNum: 1, longName: 'Solo Node', snr: 4.567, batteryLevel: 101 }}
      />,
    );
    // SignalItems renders the raw value (no snrDecimals passed) — no toFixed
    // rounding — and Dashboard never special-cases 101 as "Plugged In"
    // (that's a NodePopup/chat-overlay-only behavior, not carried over here).
    expect(screen.getByText('4.567 dB')).toBeInTheDocument();
    expect(screen.getByText('101%')).toBeInTheDocument();
  });

  it('composes grid items in the family\'s canonical order — an approved visible change (#4047 Phase 5 WP2): Hardware now precedes Hops, and SNR now precedes Battery', () => {
    const { container } = render(
      <DashboardNodePopup
        pos={pos}
        node={{
          nodeNum: 42,
          nodeId: '!0000002a',
          longName: 'Tower Node',
          role: 2,
          hwModel: 9,
          hopsAway: 3,
          snr: 5,
          batteryLevel: 80,
          altitude: 10,
        }}
      />,
    );
    const icons = Array.from(container.querySelectorAll('.node-popup-icon [data-ui-icon]')).map(el => el.getAttribute('data-ui-icon'));
    // ID, Role, Hardware, Hops, SNR, Battery, Altitude, Position — vs. the
    // pre-Phase-5 order of ID, Role, Hops, Hardware, Battery, SNR, Altitude.
    expect(icons).toEqual(['identity', 'user', 'monitor', 'link', 'wifi', 'battery', 'altitude', 'location']);
  });
});
