/**
 * @vitest-environment jsdom
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TraceroutePathsLayer, type TraceroutePathsLayerProps } from './TraceroutePathsLayer';
import type { TracerouteRenderSegment } from '../../../utils/tracerouteSegments';
import type { SnrColorScale } from '../../../utils/mapHelpers';

// ---------------------------------------------------------------------------
// Mocks (mirrors BaseMap.test.tsx / MapAnalysis TraceroutePathsLayer.test.tsx)
// ---------------------------------------------------------------------------

interface MockPolylineProps {
  positions: [number, number][];
  pathOptions?: { color?: string; weight?: number; opacity?: number; dashArray?: string };
  className?: string;
  eventHandlers?: { click?: () => void };
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
      data-point-count={props.positions.length}
      data-positions={JSON.stringify(props.positions)}
      onClick={props.eventHandlers?.click}
    >
      {props.children}
    </div>
  ),
  Marker: (props: { children?: ReactNode }) => <div data-testid="arrow-marker">{props.children}</div>,
  Tooltip: (props: { children?: ReactNode }) => <div data-testid="tooltip">{props.children}</div>,
  Popup: (props: { children?: ReactNode }) => <div data-testid="popup">{props.children}</div>,
  CircleMarker: (props: { children?: ReactNode }) => <div data-testid="circle-marker">{props.children}</div>,
}));

const snrColors: SnrColorScale = {
  excellent: '#111111',
  good: '#222222',
  fair: '#333333',
  poor: '#444444',
  noData: '#555555',
};

function seg(overrides: Partial<TracerouteRenderSegment> = {}): TracerouteRenderSegment {
  return {
    key: 'forward:1-2',
    from: [10, 10],
    to: [20, 20],
    leg: 'forward',
    avgSnr: 5,
    isMqtt: false,
    ...overrides,
  };
}

function renderLayer(props: Partial<TraceroutePathsLayerProps> & Pick<TraceroutePathsLayerProps, 'segments' | 'weight' | 'colorMode'>) {
  return render(<TraceroutePathsLayer snrColors={snrColors} {...props} />);
}

describe('TraceroutePathsLayer', () => {
  describe('polyline count', () => {
    it('renders exactly one Polyline per segment', () => {
      renderLayer({
        segments: [seg({ key: 'a' }), seg({ key: 'b' }), seg({ key: 'c' })],
        weight: 3,
        colorMode: 'snr',
      });
      expect(screen.getAllByTestId('polyline')).toHaveLength(3);
    });

    it('renders zero Polylines for an empty segment list', () => {
      renderLayer({ segments: [], weight: 3, colorMode: 'snr' });
      expect(screen.queryAllByTestId('polyline')).toHaveLength(0);
    });
  });

  describe('colorMode: snr (4-band)', () => {
    it.each([
      [7, '#111111'], // excellent >= 5
      [2, '#222222'], // good >= 0
      [-3, '#333333'], // fair >= -5
      [-10, '#444444'], // poor
      [null, '#555555'], // noData
    ] as const)('avgSnr=%s -> %s', (avgSnr, expected) => {
      renderLayer({ segments: [seg({ avgSnr })], weight: 3, colorMode: 'snr' });
      expect(screen.getByTestId('polyline').getAttribute('data-color')).toBe(expected);
    });
  });

  describe('colorMode: direction', () => {
    const directionColors = { outbound: '#aaa', inbound: '#bbb', neutral: '#ccc' };

    it.each([
      ['outbound', '#aaa'],
      ['inbound', '#bbb'],
      ['neutral', '#ccc'],
      [undefined, '#ccc'], // defaults to neutral
    ] as const)('direction=%s -> %s', (direction, expected) => {
      renderLayer({
        segments: [seg({ direction })],
        weight: 3,
        colorMode: 'direction',
        directionColors,
      });
      expect(screen.getByTestId('polyline').getAttribute('data-color')).toBe(expected);
    });
  });

  describe('colorMode: fixed-leg', () => {
    const legColors = { forward: '#f0f0f0', return: '#0f0f0f' };

    it('colors forward-leg segments with legColors.forward', () => {
      renderLayer({ segments: [seg({ leg: 'forward' })], weight: 3, colorMode: 'fixed-leg', legColors });
      expect(screen.getByTestId('polyline').getAttribute('data-color')).toBe('#f0f0f0');
    });

    it('colors return-leg segments with legColors.return', () => {
      renderLayer({ segments: [seg({ leg: 'return' })], weight: 3, colorMode: 'fixed-leg', legColors });
      expect(screen.getByTestId('polyline').getAttribute('data-color')).toBe('#0f0f0f');
    });
  });

  describe('colorMode: fixed', () => {
    it('colors every segment with fixedColor regardless of SNR/leg/direction', () => {
      renderLayer({
        segments: [seg({ avgSnr: -99, leg: 'return', direction: 'inbound' })],
        weight: 3,
        colorMode: 'fixed',
        fixedColor: '#facc15',
      });
      expect(screen.getByTestId('polyline').getAttribute('data-color')).toBe('#facc15');
    });
  });

  describe('weight', () => {
    it('accepts a fixed number', () => {
      renderLayer({ segments: [seg()], weight: 4, colorMode: 'snr' });
      expect(screen.getByTestId('polyline').getAttribute('data-weight')).toBe('4');
    });

    it('accepts a per-segment function', () => {
      renderLayer({
        segments: [seg({ occurrences: 3 })],
        weight: (s) => 2 + (s.occurrences ?? 0),
        colorMode: 'snr',
      });
      expect(screen.getByTestId('polyline').getAttribute('data-weight')).toBe('5');
    });
  });

  describe('opacity', () => {
    it('defaults to 1 when omitted', () => {
      renderLayer({ segments: [seg()], weight: 3, colorMode: 'snr' });
      expect(screen.getByTestId('polyline').getAttribute('data-opacity')).toBe('1');
    });

    it('accepts a fixed number', () => {
      renderLayer({ segments: [seg()], weight: 3, colorMode: 'snr', opacity: 0.6 });
      expect(screen.getByTestId('polyline').getAttribute('data-opacity')).toBe('0.6');
    });

    it('accepts a per-segment function', () => {
      renderLayer({
        segments: [seg({ isMqtt: true })],
        weight: 3,
        colorMode: 'snr',
        opacity: (s) => (s.isMqtt ? 0.5 : 0.9),
      });
      expect(screen.getByTestId('polyline').getAttribute('data-opacity')).toBe('0.5');
    });

    it('temporalFade floors the multiplied opacity at 0.15 for very old segments', () => {
      const veryOld = Date.now() - 1000 * 60 * 60 * 24 * 30; // 30 days
      renderLayer({
        segments: [seg({ timestamp: veryOld })],
        weight: 3,
        colorMode: 'snr',
        opacity: 0.4,
        temporalFade: true,
      });
      // 0.4 * 0.2 (>24h floor multiplier) = 0.08, floored to 0.15
      expect(screen.getByTestId('polyline').getAttribute('data-opacity')).toBe('0.15');
    });

    it('does not apply temporal fade when the flag is unset', () => {
      const veryOld = Date.now() - 1000 * 60 * 60 * 24 * 30;
      renderLayer({
        segments: [seg({ timestamp: veryOld })],
        weight: 3,
        colorMode: 'snr',
        opacity: 0.4,
      });
      expect(screen.getByTestId('polyline').getAttribute('data-opacity')).toBe('0.4');
    });
  });

  describe('highlight (Widget hover)', () => {
    it('uses full resolved opacity for the highlighted leg', () => {
      renderLayer({
        segments: [seg({ leg: 'forward' })],
        weight: 3,
        colorMode: 'snr',
        opacity: 0.9,
        highlight: { group: 'forward', dimmedOpacity: 0.2 },
      });
      expect(screen.getByTestId('polyline').getAttribute('data-opacity')).toBe('0.9');
    });

    it('replaces opacity with dimmedOpacity for a non-highlighted leg', () => {
      renderLayer({
        segments: [seg({ leg: 'return' })],
        weight: 3,
        colorMode: 'snr',
        opacity: 0.9,
        highlight: { group: 'forward', dimmedOpacity: 0.2 },
      });
      expect(screen.getByTestId('polyline').getAttribute('data-opacity')).toBe('0.2');
    });

    it('treats group=null as "nothing highlighted" — full opacity for every leg', () => {
      renderLayer({
        segments: [seg({ leg: 'forward' }), seg({ key: 'b', leg: 'return' })],
        weight: 3,
        colorMode: 'snr',
        opacity: 0.9,
        highlight: { group: null, dimmedOpacity: 0.2 },
      });
      for (const el of screen.getAllByTestId('polyline')) {
        expect(el.getAttribute('data-opacity')).toBe('0.9');
      }
    });
  });

  describe('dashMode', () => {
    it('mqtt-unknown (default): dashes MQTT segments', () => {
      renderLayer({ segments: [seg({ isMqtt: true, avgSnr: null })], weight: 3, colorMode: 'snr' });
      expect(screen.getByTestId('polyline').getAttribute('data-dash')).toBe('3,6');
    });

    it('mqtt-unknown (default): dashes segments with no SNR data even if not flagged isMqtt', () => {
      renderLayer({ segments: [seg({ isMqtt: false, avgSnr: null })], weight: 3, colorMode: 'snr' });
      expect(screen.getByTestId('polyline').getAttribute('data-dash')).toBe('3,6');
    });

    it('mqtt-unknown (default): does not dash segments with real SNR data', () => {
      renderLayer({ segments: [seg({ isMqtt: false, avgSnr: 5 })], weight: 3, colorMode: 'snr' });
      expect(screen.getByTestId('polyline').getAttribute('data-dash')).toBe('');
    });

    it('always: dashes every segment regardless of SNR/MQTT', () => {
      renderLayer({
        segments: [seg({ isMqtt: false, avgSnr: 5 })],
        weight: 3,
        colorMode: 'snr',
        dashMode: 'always',
      });
      expect(screen.getByTestId('polyline').getAttribute('data-dash')).toBe('3,6');
    });

    it('never: dashes nothing even for MQTT segments', () => {
      renderLayer({
        segments: [seg({ isMqtt: true, avgSnr: null })],
        weight: 3,
        colorMode: 'snr',
        dashMode: 'never',
      });
      expect(screen.getByTestId('polyline').getAttribute('data-dash')).toBe('');
    });
  });

  describe('curvature', () => {
    it('curvature 0 (default) renders a straight 2-point line', () => {
      renderLayer({ segments: [seg()], weight: 3, colorMode: 'snr' });
      const el = screen.getByTestId('polyline');
      expect(el.getAttribute('data-point-count')).toBe('2');
      expect(JSON.parse(el.getAttribute('data-positions')!)).toEqual([
        [10, 10],
        [20, 20],
      ]);
    });

    it('curvature > 0 renders a multi-point curved path', () => {
      renderLayer({ segments: [seg()], weight: 3, colorMode: 'snr', curvature: 0.2 });
      const el = screen.getByTestId('polyline');
      expect(Number(el.getAttribute('data-point-count'))).toBeGreaterThan(2);
    });

    it('forward and return legs (same endpoints) curve to opposite sides', () => {
      renderLayer({
        segments: [seg({ key: 'fwd', leg: 'forward' }), seg({ key: 'ret', leg: 'return' })],
        weight: 3,
        colorMode: 'snr',
        curvature: 0.2,
      });
      const [fwd, ret] = screen.getAllByTestId('polyline');
      // Same endpoints, opposite sign curvature -> different midpoints.
      expect(fwd.getAttribute('data-positions')).not.toBe(ret.getAttribute('data-positions'));
    });

    it('neutralCurvature applies to neutral-leg segments independent of curvature', () => {
      renderLayer({
        segments: [seg({ leg: 'neutral' })],
        weight: 3,
        colorMode: 'snr',
        curvature: 0.2,
        neutralCurvature: 0.12,
      });
      const el = screen.getByTestId('polyline');
      expect(Number(el.getAttribute('data-point-count'))).toBeGreaterThan(2);
    });
  });

  describe('arrows', () => {
    it('does not render arrows when showArrows is false/unset', () => {
      renderLayer({ segments: [seg()], weight: 3, colorMode: 'snr' });
      expect(screen.queryAllByTestId('arrow-marker')).toHaveLength(0);
    });

    it('renders one arrow marker per segment when showArrows is true', () => {
      renderLayer({
        segments: [seg({ key: 'a' }), seg({ key: 'b' })],
        weight: 3,
        colorMode: 'snr',
        showArrows: true,
      });
      expect(screen.getAllByTestId('arrow-marker')).toHaveLength(2);
    });

    it('limits arrows to the highlighted leg when highlight is active', () => {
      renderLayer({
        segments: [seg({ key: 'a', leg: 'forward' }), seg({ key: 'b', leg: 'return' })],
        weight: 3,
        colorMode: 'snr',
        showArrows: true,
        highlight: { group: 'forward', dimmedOpacity: 0.2 },
      });
      expect(screen.getAllByTestId('arrow-marker')).toHaveLength(1);
    });

    it('draws arrows for every leg when highlight.group is null', () => {
      renderLayer({
        segments: [seg({ key: 'a', leg: 'forward' }), seg({ key: 'b', leg: 'return' })],
        weight: 3,
        colorMode: 'snr',
        showArrows: true,
        highlight: { group: null, dimmedOpacity: 0.2 },
      });
      expect(screen.getAllByTestId('arrow-marker')).toHaveLength(2);
    });
  });

  describe('render-props', () => {
    it('renders renderPopup output as a Polyline child', () => {
      renderLayer({
        segments: [seg()],
        weight: 3,
        colorMode: 'snr',
        renderPopup: (s) => <div data-testid="custom-popup">{s.key}</div>,
      });
      expect(screen.getByTestId('custom-popup')).toBeInTheDocument();
      expect(screen.getByTestId('custom-popup').textContent).toBe('forward:1-2');
    });

    it('renders nothing extra when renderPopup is omitted', () => {
      renderLayer({ segments: [seg()], weight: 3, colorMode: 'snr' });
      expect(screen.getByTestId('polyline').children.length).toBe(0);
    });

    it('invokes onSegmentClick with the clicked segment', () => {
      const onSegmentClick = vi.fn();
      renderLayer({
        segments: [seg({ key: 'clickme' })],
        weight: 3,
        colorMode: 'snr',
        onSegmentClick,
      });
      fireEvent.click(screen.getByTestId('polyline'));
      expect(onSegmentClick).toHaveBeenCalledTimes(1);
      expect(onSegmentClick.mock.calls[0][0]).toMatchObject({ key: 'clickme' });
    });

    it('applies segmentClassName to the Polyline', () => {
      renderLayer({
        segments: [seg({ key: 'node-1 node-2' })],
        weight: 3,
        colorMode: 'snr',
        segmentClassName: (s) => `route-segment ${s.key}`,
      });
      expect(screen.getByTestId('polyline').getAttribute('data-classname')).toBe(
        'route-segment node-1 node-2',
      );
    });
  });
});
