import { memo, type ReactElement, type ReactNode } from 'react';
import { Polyline } from 'react-leaflet';
import {
  generateCurvedPath,
  generateCurvedArrowMarkers,
  getTemporalOpacityMultiplier,
  snrToColor,
  MQTT_DASH,
  type SnrColorScale,
} from '../../../utils/mapHelpers';
import { UNKNOWN_SNR_SENTINEL, type TracerouteRenderSegment } from '../../../utils/tracerouteSegments';

const CURVE_SEGMENTS = 20;

export interface TraceroutePathsLayerProps {
  segments: TracerouteRenderSegment[];
  snrColors: SnrColorScale;                          // theme palette (prop, not useSettings)
  colorMode: 'snr' | 'direction' | 'fixed-leg' | 'fixed';
  /** `colorMode: 'snr'` only — when set, an `isMqtt` segment uses this color
   *  instead of `snrToColor(seg.avgSnr, snrColors)` (which would resolve to
   *  `noData` gray, losing the MQTT/IP-bridged distinction). Omit to fall
   *  through to `snrToColor` for every segment regardless of `isMqtt`. */
  mqttColor?: string;
  legColors?: { forward: string; return: string };   // 'fixed-leg'
  directionColors?: { outbound: string; inbound: string; neutral?: string }; // 'direction'
  fixedColor?: string;                                // 'fixed' (Dashboard yellow overlay)
  curvature?: number | ((seg: TracerouteRenderSegment) => number); // 0 = straight; default 0. Function form is used as-is (no leg-sign negation).
  neutralCurvature?: number;                          // MapAnalysis neutral 0.12 (number `curvature` form only)
  weight: number | ((seg: TracerouteRenderSegment) => number);
  opacity?: number | ((seg: TracerouteRenderSegment) => number);
  dashMode?: 'mqtt-unknown' | 'always' | 'never';    // default 'mqtt-unknown'
  showArrows?: boolean;
  temporalFade?: boolean;                             // multiplies opacity, floor 0.15
  highlight?: { group: 'forward' | 'return' | null; dimmedOpacity: number }; // Widget hover
  onSegmentClick?: (seg: TracerouteRenderSegment) => void;   // MapAnalysis click-select
  renderPopup?: (seg: TracerouteRenderSegment) => ReactNode; // NodesTab recharts / DraggablePopup
  segmentClassName?: (seg: TracerouteRenderSegment) => string;     // NodesTab 'route-segment node-X'
}

/** Resolve a segment's stroke color for the configured `colorMode`. */
function resolveColor(seg: TracerouteRenderSegment, props: TraceroutePathsLayerProps): string {
  switch (props.colorMode) {
    case 'snr':
      if (seg.isMqtt && props.mqttColor) return props.mqttColor;
      return snrToColor(seg.avgSnr, props.snrColors);
    case 'direction': {
      const dc = props.directionColors;
      if (!dc) return props.snrColors.noData;
      const key = seg.direction ?? 'neutral';
      return key === 'neutral' ? (dc.neutral ?? props.snrColors.noData) : dc[key];
    }
    case 'fixed-leg': {
      const lc = props.legColors;
      if (!lc) return props.snrColors.noData;
      return seg.leg === 'return' ? lc.return : lc.forward;
    }
    case 'fixed':
      return props.fixedColor ?? props.snrColors.noData;
    default:
      return props.snrColors.noData;
  }
}

function resolveWeight(seg: TracerouteRenderSegment, weight: TraceroutePathsLayerProps['weight']): number {
  return typeof weight === 'function' ? weight(seg) : weight;
}

/**
 * Base opacity (number or per-segment fn, default 1 when omitted) — then, if
 * `temporalFade` is set, multiplied by `getTemporalOpacityMultiplier` and
 * floored at 0.15 (matches the pre-existing NodesTab base-layer behavior) —
 * then, if `highlight` is active and this segment's leg isn't the
 * highlighted group, REPLACED (not multiplied) by `highlight.dimmedOpacity`,
 * matching the Widget's pre-existing hover behavior
 * (`opacity: isHighlighted ? 0.9 : 0.2`).
 */
function resolveOpacity(seg: TracerouteRenderSegment, props: TraceroutePathsLayerProps): number {
  const base = props.opacity === undefined
    ? 1
    : typeof props.opacity === 'function'
      ? props.opacity(seg)
      : props.opacity;

  let value = props.temporalFade
    ? Math.max(0.15, base * getTemporalOpacityMultiplier(seg.timestamp))
    : base;

  if (props.highlight && props.highlight.group !== null && seg.leg !== props.highlight.group) {
    value = props.highlight.dimmedOpacity;
  }

  return value;
}

/** MQTT/unknown-SNR dashing (#2931 visual), canonical `MQTT_DASH` (§2.3). */
function resolveDash(seg: TracerouteRenderSegment, dashMode: TraceroutePathsLayerProps['dashMode']): string | undefined {
  const mode = dashMode ?? 'mqtt-unknown';
  if (mode === 'never') return undefined;
  if (mode === 'always') return MQTT_DASH;
  return seg.isMqtt || seg.avgSnr == null ? MQTT_DASH : undefined;
}

/**
 * Resolve a segment's curvature. `curvature` as a function is used AS-IS —
 * the caller owns direction/sign entirely and the leg-based negation below
 * does not apply (e.g. MapAnalysis's honest in/outbound curvature, which
 * isn't a forward/return leg at all). `curvature` as a number applies the
 * leg-signed convention: forward legs curve `+curvature`, return legs
 * `-curvature`; 'neutral' legs use `neutralCurvature` when provided, falling
 * back to the signed `curvature` otherwise.
 */
function resolveCurvature(
  seg: TracerouteRenderSegment,
  curvature: TraceroutePathsLayerProps['curvature'],
  neutralCurvature: number | undefined,
): number {
  if (typeof curvature === 'function') return curvature(seg);
  if (seg.leg === 'neutral') {
    return neutralCurvature ?? curvature ?? 0;
  }
  const base = curvature ?? 0;
  return seg.leg === 'return' ? -base : base;
}

function resolvePositions(seg: TracerouteRenderSegment, effectiveCurvature: number): [number, number][] {
  return effectiveCurvature === 0
    ? [seg.from, seg.to]
    : generateCurvedPath(seg.from, seg.to, effectiveCurvature, CURVE_SEGMENTS, true);
}

/** Arrows are gated by `showArrows` overall, and — when `highlight` is
 *  active — further limited to the highlighted leg (matches the Widget's
 *  pre-existing "arrows only for the highlighted path" behavior). */
function shouldDrawArrow(seg: TracerouteRenderSegment, props: TraceroutePathsLayerProps): boolean {
  if (!props.showArrows) return false;
  if (props.highlight && props.highlight.group !== null) {
    return seg.leg === props.highlight.group;
  }
  return true;
}

interface ResolvedSegment {
  seg: TracerouteRenderSegment;
  color: string;
  weight: number;
  opacity: number;
  dashArray: string | undefined;
  curvature: number;
  positions: [number, number][];
  className: string | undefined;
}

/**
 * Shared traceroute render layer (`src/components/map/layers/`, per the
 * Phase-1 `BaseMap` convention: named export, typed props, no `any`, returns
 * a fragment). Owns geometry (straight vs curved), color-mode resolution,
 * weight/opacity strategies, MQTT/unknown-SNR dashing, arrows, temporal
 * fade, and hover-highlight dimming for a pre-decomposed
 * `TracerouteRenderSegment[]` (see `utils/tracerouteSegments.ts`). Consumed
 * by NodesTab/useTraceroutePaths, TracerouteWidget, DashboardMap, and
 * MapAnalysis.
 */
function TraceroutePathsLayerImpl(props: TraceroutePathsLayerProps): ReactElement {
  const { segments, showArrows = false } = props;

  // Resolve each segment's color/weight/opacity/dash/curvature/positions
  // exactly once and reuse the result for both the Polyline pass and the
  // arrow pass below (arrows share the same color/curvature).
  const resolved: ResolvedSegment[] = segments.map((seg) => {
    const color = resolveColor(seg, props);
    const curvature = resolveCurvature(seg, props.curvature, props.neutralCurvature);
    return {
      seg,
      color,
      weight: resolveWeight(seg, props.weight),
      opacity: resolveOpacity(seg, props),
      dashArray: resolveDash(seg, props.dashMode),
      curvature,
      positions: resolvePositions(seg, curvature),
      className: props.segmentClassName?.(seg),
    };
  });

  return (
    <>
      {resolved.map(({ seg, color, weight, opacity, dashArray, positions, className }) => (
        <Polyline
          key={seg.key}
          positions={positions}
          pathOptions={{ color, weight, opacity, dashArray }}
          className={className}
          eventHandlers={
            props.onSegmentClick
              ? { click: () => props.onSegmentClick?.(seg) }
              : undefined
          }
        >
          {props.renderPopup ? props.renderPopup(seg) : null}
        </Polyline>
      ))}
      {showArrows &&
        resolved
          .filter(({ seg }) => shouldDrawArrow(seg, props))
          .flatMap(({ seg, color, curvature }) => {
            const snr = seg.avgSnr === null ? UNKNOWN_SNR_SENTINEL : seg.avgSnr;
            return generateCurvedArrowMarkers([seg.from, seg.to], seg.key, color, [snr], curvature, true);
          })}
    </>
  );
}

export const TraceroutePathsLayer = memo(TraceroutePathsLayerImpl);
