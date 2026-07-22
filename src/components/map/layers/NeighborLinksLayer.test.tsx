/**
 * @vitest-environment jsdom
 *
 * Descriptor→polyline mapping, `pathOptions`/`className`/`eventHandlers`
 * passthrough, arrow gating, and popup/tooltip render-prop mounting for the
 * shared neighbor-link layer (#4047 Phase 7 WP2). `react-leaflet` is mocked
 * (mirrors `TraceroutePathsLayer.test.tsx`) — this suite proves the layer's
 * *contract*, not real Leaflet rendering. Browser validation against every
 * consumer map is the binding gate for that (MAP_CONSOLIDATION_P7_SPEC.md
 * §7.5).
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NeighborLinksLayer, type NeighborLinkDescriptor } from './NeighborLinksLayer';

// ---------------------------------------------------------------------------
// Mocks (mirrors TraceroutePathsLayer.test.tsx)
// ---------------------------------------------------------------------------

interface MockPolylineProps {
  positions: [number, number][];
  pathOptions?: { color?: string; weight?: number; opacity?: number; dashArray?: string };
  className?: string;
  interactive?: boolean;
  eventHandlers?: { click?: () => void };
  children?: ReactNode;
}

interface MockMarkerProps {
  position: [number, number];
  icon?: unknown;
  interactive?: boolean;
  children?: ReactNode;
}

vi.mock('react-leaflet', () => ({
  Polyline: (props: MockPolylineProps) => (
    <div
      data-testid="polyline"
      data-color={props.pathOptions?.color}
      data-weight={props.pathOptions?.weight}
      data-opacity={props.pathOptions?.opacity}
      data-dash={props.pathOptions?.dashArray ?? ''}
      data-classname={props.className ?? ''}
      data-interactive={String(props.interactive ?? true)}
      data-positions={JSON.stringify(props.positions)}
      onClick={props.eventHandlers?.click}
    >
      {props.children}
    </div>
  ),
  Marker: (props: MockMarkerProps) => (
    <div
      data-testid="arrow-marker"
      data-position={JSON.stringify(props.position)}
      data-interactive={String(props.interactive)}
    >
      {props.children}
    </div>
  ),
}));

// Real mapHelpers.createArrowIcon is used (leaflet-only, no DOM needed —
// mirrors TraceroutePathsLayer.test.tsx exercising generateCurvedArrowMarkers
// unmocked). neighborLinks.ts (bearingBetween/neighborArrowFractions) is
// pure/leaflet-free and also used unmocked.

function link(overrides: Partial<NeighborLinkDescriptor> & Pick<NeighborLinkDescriptor, 'key'>): NeighborLinkDescriptor {
  return {
    positions: [[10, 20], [11, 21]],
    pathOptions: { color: '#06b6d4', weight: 1, opacity: 0.7 },
    ...overrides,
  };
}

function renderLayer(links: NeighborLinkDescriptor[]) {
  return render(<NeighborLinksLayer links={links} />);
}

describe('NeighborLinksLayer', () => {
  describe('polyline count', () => {
    it('renders exactly one Polyline per descriptor', () => {
      renderLayer([link({ key: 'a' }), link({ key: 'b' }), link({ key: 'c' })]);
      expect(screen.getAllByTestId('polyline')).toHaveLength(3);
    });

    it('renders zero Polylines for an empty descriptor list', () => {
      renderLayer([]);
      expect(screen.queryAllByTestId('polyline')).toHaveLength(0);
    });
  });

  describe('pathOptions / className passthrough', () => {
    it('passes color/weight/opacity/dashArray through verbatim', () => {
      renderLayer([
        link({
          key: 'a',
          pathOptions: { color: '#f5a623', weight: 3, opacity: 0.7, dashArray: '5, 5' },
        }),
      ]);
      const el = screen.getByTestId('polyline');
      expect(el).toHaveAttribute('data-color', '#f5a623');
      expect(el).toHaveAttribute('data-weight', '3');
      expect(el).toHaveAttribute('data-opacity', '0.7');
      expect(el).toHaveAttribute('data-dash', '5, 5');
    });

    it('passes className through when set', () => {
      renderLayer([link({ key: 'a', className: 'neighbor-line node-1 node-2' })]);
      expect(screen.getByTestId('polyline')).toHaveAttribute(
        'data-classname',
        'neighbor-line node-1 node-2',
      );
    });

    it('omits className when not set', () => {
      renderLayer([link({ key: 'a' })]);
      expect(screen.getByTestId('polyline')).toHaveAttribute('data-classname', '');
    });

    it('passes positions through verbatim', () => {
      renderLayer([link({ key: 'a', positions: [[1, 2], [3, 4]] })]);
      expect(screen.getByTestId('polyline')).toHaveAttribute(
        'data-positions',
        JSON.stringify([[1, 2], [3, 4]]),
      );
    });
  });

  describe('eventHandlers passthrough', () => {
    it('fires the descriptor click handler on the hit-line click', () => {
      const onClick = vi.fn();
      renderLayer([link({ key: 'a', eventHandlers: { click: onClick } })]);
      const [visible, hit] = screen.getAllByTestId('polyline');
      fireEvent.click(hit);
      expect(onClick).toHaveBeenCalledTimes(1);
      fireEvent.click(visible); // visible line carries no handler
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('invisible hit-line for interactive links (thin-line click target fix)', () => {
    it('renders a wide transparent companion polyline when eventHandlers is set', () => {
      renderLayer([link({ key: 'a', eventHandlers: { click: vi.fn() } })]);
      const polys = screen.getAllByTestId('polyline');
      expect(polys).toHaveLength(2);
      const [visible, hit] = polys;
      expect(visible).toHaveAttribute('data-interactive', 'false');
      expect(hit).toHaveAttribute('data-weight', '12');
      expect(hit).toHaveAttribute('data-opacity', '0');
      expect(hit).toHaveAttribute('data-positions', visible.getAttribute('data-positions'));
    });

    it('renders a hit-line when only children (popup) is set', () => {
      renderLayer([link({ key: 'a', children: <div data-testid="popup-content">x</div> })]);
      expect(screen.getAllByTestId('polyline')).toHaveLength(2);
    });

    it('renders a single interactive-by-default polyline for select-only-less links', () => {
      renderLayer([link({ key: 'a' })]);
      const polys = screen.getAllByTestId('polyline');
      expect(polys).toHaveLength(1);
      expect(polys[0]).toHaveAttribute('data-interactive', 'true');
    });
  });

  describe('arrow gating', () => {
    it('draws no arrow markers when `arrows` is omitted', () => {
      renderLayer([link({ key: 'a' })]);
      expect(screen.queryAllByTestId('arrow-marker')).toHaveLength(0);
    });

    it('draws one arrow marker per default fraction (25%/50%/75%) when `arrows` is set', () => {
      renderLayer([link({ key: 'a', arrows: { color: '#ffcc00' } })]);
      expect(screen.getAllByTestId('arrow-marker')).toHaveLength(3);
    });

    it('honors a custom `fractions` array', () => {
      renderLayer([link({ key: 'a', arrows: { color: '#ffcc00', fractions: [0.5] } })]);
      expect(screen.getAllByTestId('arrow-marker')).toHaveLength(1);
    });

    it('positions each arrow by interpolating from positions[1] toward positions[0]', () => {
      renderLayer([
        link({
          key: 'a',
          positions: [[10, 0], [0, 0]],
          arrows: { color: '#ffcc00', fractions: [0.5] },
        }),
      ]);
      const marker = screen.getByTestId('arrow-marker');
      expect(JSON.parse(marker.getAttribute('data-position') ?? 'null')).toEqual([5, 0]);
    });

    it('renders arrow markers as non-interactive', () => {
      renderLayer([link({ key: 'a', arrows: { color: '#ffcc00', fractions: [0.5] } })]);
      expect(screen.getByTestId('arrow-marker')).toHaveAttribute('data-interactive', 'false');
    });

    it('renders a distinct arrow count per link when multiple links have arrows', () => {
      renderLayer([
        link({ key: 'a', arrows: { color: '#ffcc00' } }),
        link({ key: 'b' }),
        link({ key: 'c', arrows: { color: '#00ccff', fractions: [0.5] } }),
      ]);
      expect(screen.getAllByTestId('arrow-marker')).toHaveLength(4); // 3 + 0 + 1
    });
  });

  describe('popup / tooltip render-prop', () => {
    it('mounts descriptor children inside the hit-line Polyline', () => {
      renderLayer([
        link({ key: 'a', children: <div data-testid="popup-content">Neighbor info</div> }),
      ]);
      expect(screen.getByTestId('popup-content')).toHaveTextContent('Neighbor info');
      const [, hit] = screen.getAllByTestId('polyline');
      expect(hit.querySelector('[data-testid="popup-content"]')).not.toBeNull();
    });

    it('renders no popup content when children is omitted', () => {
      renderLayer([link({ key: 'a' })]);
      expect(screen.queryByTestId('popup-content')).not.toBeInTheDocument();
    });
  });
});
