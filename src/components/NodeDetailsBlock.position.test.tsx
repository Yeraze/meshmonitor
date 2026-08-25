/**
 * @vitest-environment jsdom
 *
 * Regression tests for issue #4130 — the Node Details block renders a node's
 * latitude/longitude and elevation as plain text (so a bogus fix like 0,0 is
 * visible without opening a map).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import NodeDetailsBlock from './NodeDetailsBlock';
import type { DeviceInfo } from '../types/device';

// The block reads channels/current-node/settings/map-context via hooks; stub
// them so the component renders standalone. `t(key, def)` returns the provided
// default (falling back to the key) so label lookups don't need a real bundle —
// the assertions below target the language-independent coordinate/elevation
// values, not the labels.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, def?: string) => def ?? key }),
}));
vi.mock('../hooks/useServerData', () => ({
  useChannels: () => ({ channels: [] }),
  useDeviceConfig: () => ({ currentNodeId: null }),
}));
let mockDistanceUnit: 'km' | 'mi' = 'km';
vi.mock('../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ nodeHopsCalculation: 'client', distanceUnit: mockDistanceUnit }),
}));
vi.mock('../contexts/MapContext', () => ({
  useMapContext: () => ({ traceroutes: [] }),
}));
vi.mock('./NodeDetailsBlock.css', () => ({}));

const baseNode: DeviceInfo = {
  nodeNum: 123,
  user: { id: '!0000007b', longName: 'Node', shortName: 'N', role: 'CLIENT' },
};

describe('NodeDetailsBlock position/elevation (#4130)', () => {
  it('renders latitude/longitude and elevation text when the node has a position', () => {
    render(
      <NodeDetailsBlock
        node={{ ...baseNode, position: { latitude: 35.123456, longitude: -80.654321, altitude: 120 } }}
      />,
    );
    expect(screen.getByText('Position')).toBeInTheDocument();
    // 5-decimal rounding, matching the map popup's PositionItem.
    expect(screen.getByText('35.12346, -80.65432')).toBeInTheDocument();
    expect(screen.getByText('Elevation')).toBeInTheDocument();
    expect(screen.getByText('120m')).toBeInTheDocument();
  });

  it('omits elevation when altitude is absent but still shows coordinates', () => {
    render(
      <NodeDetailsBlock node={{ ...baseNode, position: { latitude: 0, longitude: 0 } }} />,
    );
    // A bogus 0,0 fix is exactly what this feature exists to make visible.
    expect(screen.getByText('0.00000, 0.00000')).toBeInTheDocument();
    expect(screen.queryByText('Elevation')).not.toBeInTheDocument();
  });

  it('renders neither Position nor Elevation when the node has no position', () => {
    render(<NodeDetailsBlock node={baseNode} />);
    expect(screen.queryByText('Position')).not.toBeInTheDocument();
    expect(screen.queryByText('Elevation')).not.toBeInTheDocument();
  });
});

/**
 * Issue #4432 — an estimated position used to be indistinguishable from a real
 * GPS fix once it reached the client. The pill states the provenance and the ±
 * radius states how far off it may be.
 */
describe('NodeDetailsBlock position source pill (#4432)', () => {
  const withPosition = (extra: Partial<DeviceInfo>): DeviceInfo => ({
    ...baseNode,
    position: { latitude: 35.1, longitude: -80.6 },
    ...extra,
  });

  beforeEach(() => {
    mockDistanceUnit = 'km';
  });

  it('labels a device-reported fix GPS', () => {
    render(<NodeDetailsBlock node={withPosition({})} />);
    expect(screen.getByText('GPS')).toBeInTheDocument();
    expect(screen.queryByText('Estimated')).not.toBeInTheDocument();
    expect(screen.queryByText('Override')).not.toBeInTheDocument();
  });

  it('labels a trilaterated position Estimated and shows its ± radius', () => {
    render(
      <NodeDetailsBlock
        node={withPosition({ positionIsEstimated: true, positionEstimateUncertaintyKm: 2.4 })}
      />,
    );
    expect(screen.getByText('Estimated')).toBeInTheDocument();
    expect(screen.getByText('±2.4 km')).toBeInTheDocument();
    expect(screen.queryByText('GPS')).not.toBeInTheDocument();
  });

  it('converts the estimate radius to miles when that unit is selected', () => {
    mockDistanceUnit = 'mi';
    render(
      <NodeDetailsBlock
        node={withPosition({ positionIsEstimated: true, positionEstimateUncertaintyKm: 2.4 })}
      />,
    );
    expect(screen.getByText('±1.5 mi')).toBeInTheDocument();
  });

  it('shows Estimated with no radius when uncertainty is unknown', () => {
    render(<NodeDetailsBlock node={withPosition({ positionIsEstimated: true })} />);
    expect(screen.getByText('Estimated')).toBeInTheDocument();
    expect(screen.queryByText(/^±/)).not.toBeInTheDocument();
  });

  // A degenerate 0 km estimate must render nothing, not "±0 m" — the latter
  // would read as a claim of perfect accuracy on a trilaterated guess.
  it('shows Estimated with no radius for a degenerate 0 km uncertainty', () => {
    render(
      <NodeDetailsBlock
        node={withPosition({ positionIsEstimated: true, positionEstimateUncertaintyKm: 0 })}
      />,
    );
    expect(screen.getByText('Estimated')).toBeInTheDocument();
    expect(screen.queryByText(/^±/)).not.toBeInTheDocument();
  });

  // An override wins outright in enhanceNodeForClient, so it must never be
  // labelled estimated even if a stale estimate flag rides along.
  it('labels a manually placed position Override, with no error bar', () => {
    render(
      <NodeDetailsBlock
        node={withPosition({ positionIsOverride: true, positionIsEstimated: true })}
      />,
    );
    expect(screen.getByText('Override')).toBeInTheDocument();
    expect(screen.queryByText('Estimated')).not.toBeInTheDocument();
    expect(screen.queryByText(/^±/)).not.toBeInTheDocument();
  });

  // Sub-kilometre radii stay in metres — "±0.4 km" would be worse than useless.
  it('shows the precision-derived ± radius in metres for a coarse GPS fix', () => {
    // 16 precision bits = a 2^16 * 1e-7 deg cell ≈ 728 m, so half is ≈ ±364 m.
    render(<NodeDetailsBlock node={withPosition({ positionPrecisionBits: 16 })} />);
    expect(screen.getByText('GPS')).toBeInTheDocument();
    expect(screen.getByText('±364 m')).toBeInTheDocument();
  });

  it('shows the precision-derived ± radius in km for a very coarse GPS fix', () => {
    // 10 bits ≈ a 46.6 km cell, so half is ≈ ±23 km.
    render(<NodeDetailsBlock node={withPosition({ positionPrecisionBits: 10 })} />);
    expect(screen.getByText('±23 km')).toBeInTheDocument();
  });

  it('shows no radius for a full-precision GPS fix', () => {
    render(<NodeDetailsBlock node={withPosition({ positionPrecisionBits: 32 })} />);
    expect(screen.getByText('GPS')).toBeInTheDocument();
    expect(screen.queryByText(/^±/)).not.toBeInTheDocument();
  });
});

/**
 * #4498 — the Position badge showed a generic "GPS" for every real fix. The
 * protobuf's LocSource has been decoded and stored since #4176, but PR #4188
 * wired it only into the map popups, never this card.
 */
describe('NodeDetailsBlock position source badge (#4498)', () => {
  const positioned = { latitude: 35.1, longitude: -80.6 };

  it.each([
    [2, 'Internal GPS'],
    [3, 'External GPS'],
    [1, 'Manual'],
  ])('names the source when the device reported LocSource %i', (src, label) => {
    render(<NodeDetailsBlock node={{ ...baseNode, position: positioned, positionLocationSource: src }} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it.each([
    ['unset (0)', 0],
    ['absent', undefined],
  ])('keeps the generic "GPS" wording when the source is %s', (_label, src) => {
    render(<NodeDetailsBlock node={{ ...baseNode, position: positioned, positionLocationSource: src }} />);
    expect(screen.getByText('GPS')).toBeInTheDocument();
  });

  it('still says "Override" for a manually placed pin, not the LocSource', () => {
    // positionIsOverride is MeshMonitor's own concept and outranks whatever the
    // device last reported.
    render(
      <NodeDetailsBlock
        node={{ ...baseNode, position: positioned, positionIsOverride: true, positionLocationSource: 2 }}
      />,
    );
    expect(screen.getByText('Override')).toBeInTheDocument();
    expect(screen.queryByText('Internal GPS')).toBeNull();
  });
});

describe('NodeDetailsBlock position accuracy "Exact" (#4498)', () => {
  const positioned = { latitude: 35.1, longitude: -80.6 };

  it('labels a full-precision fix Exact', () => {
    render(<NodeDetailsBlock node={{ ...baseNode, position: positioned, positionPrecisionBits: 32 }} />);
    expect(screen.getByText('Exact')).toBeInTheDocument();
  });

  it('labels a user override Exact', () => {
    render(<NodeDetailsBlock node={{ ...baseNode, position: positioned, positionIsOverride: true }} />);
    expect(screen.getByText('Exact')).toBeInTheDocument();
  });

  it('says NOTHING when precision is unreported — unknown is not exact', () => {
    // The load-bearing case. hasAccuracyCell() is false for full precision, for
    // an override, AND for unset/zero bits; only the first two are genuinely
    // exact. Claiming "Exact" here would assert something the device never told
    // us.
    for (const bits of [undefined, null, 0]) {
      const { unmount } = render(
        <NodeDetailsBlock node={{ ...baseNode, position: positioned, positionPrecisionBits: bits as never }} />,
      );
      expect(screen.queryByText('Exact')).toBeNull();
      unmount();
    }
  });

  it('shows the error bar rather than Exact for an imprecise fix', () => {
    render(<NodeDetailsBlock node={{ ...baseNode, position: positioned, positionPrecisionBits: 16 }} />);
    expect(screen.queryByText('Exact')).toBeNull();
    expect(screen.getByText(/±/)).toBeInTheDocument();
  });
});

/**
 * Issue #4662 — the Position card surfaces a rx-time timestamp separate from
 * the generic "Last Heard" so users can tell a stale fix apart from a stale
 * node. `t()` in this test returns the default string verbatim (interpolation
 * skipped), so the assertion targets the stable tooltip via `title=`.
 */
describe('NodeDetailsBlock position timestamp (#4662)', () => {
  const positioned = { latitude: 35.1, longitude: -80.6 };
  const tooltip = 'When this node last reported its position (server receive time)';

  it('renders the "Updated…" line with the position tooltip when positionTimestamp is set', () => {
    render(
      <NodeDetailsBlock
        node={{ ...baseNode, position: positioned, positionTimestamp: Date.now() - 3600_000 }}
      />,
    );
    const el = screen.getByTitle(tooltip);
    expect(el).toBeInTheDocument();
    expect(el.textContent).toMatch(/Updated/);
  });

  it('omits the "Updated…" line when positionTimestamp is absent', () => {
    render(<NodeDetailsBlock node={{ ...baseNode, position: positioned }} />);
    expect(screen.queryByTitle(tooltip)).toBeNull();
  });

  it('does not render the "Updated…" line without a position, even if positionTimestamp is set', () => {
    render(<NodeDetailsBlock node={{ ...baseNode, positionTimestamp: Date.now() }} />);
    expect(screen.queryByText('Position')).toBeNull();
    expect(screen.queryByTitle(tooltip)).toBeNull();
  });
});
