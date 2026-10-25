/**
 * PacketFlightsLayer: live packet traffic on the map (#4835). A child of the
 * map (BaseMap / MapContainer).
 *
 * Mount it only while the "Live packet traffic" toggle is on: mounting
 * subscribes this socket to `packet:flight` for `sourceIds`, unmounting
 * unsubscribes and removes every dot. Each event resolves against `nodes`,
 * the positioned nodes this map draws (already filtered for the viewer), so a
 * flight never reveals a node or a position the map does not already show.
 *
 * Rate: `maxPerSecond` (0 = all) caps the dots drawn per second; the excess is
 * dropped here and counted through `onDroppedChange`. Whatever the rate, at
 * most MAX_CONCURRENT_FLIGHTS dots animate at once.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useMap } from 'react-leaflet';
import { useWebSocketContext } from '../../../contexts/WebSocketContext';
import { usePacketFlights } from '../../../hooks/usePacketFlights';
import type { PacketFlight } from '../../../types/packetFlight';
import {
  buildFlightNodeIndex,
  createFlightRateLimiter,
  flightKindColor,
  resolveFlightEdge,
  type FlightNodeEntry,
} from '../../../utils/packetFlightEdges';
import { resolveCssColor } from '../../../utils/sourceColors';
import { PacketFlightAnimator } from './packetFlightAnimator';

export interface PacketFlightsLayerProps {
  /** Sources whose flights this map draws. */
  sourceIds: string[];
  /** The positioned nodes this map draws, at their marker positions. */
  nodes: FlightNodeEntry[];
  /** Most dots per second; 0 = all. */
  maxPerSecond: number;
  /** The map's own colour for a flight's source, as a CSS colour or `var()`; null = colour by kind. */
  sourceColor?: (sourceId: string) => string | null;
  /** Called with the running dropped count (0 on mount). */
  onDroppedChange?: (dropped: number) => void;
}

/** How often the dropped count is reported, ms. */
const DROPPED_REPORT_MS = 1000;

export function PacketFlightsLayer({ sourceIds, nodes, maxPerSecond, sourceColor, onDroppedChange }: PacketFlightsLayerProps) {
  const map = useMap();
  const { state } = useWebSocketContext();

  const index = useMemo(() => buildFlightNodeIndex(nodes), [nodes]);
  const indexRef = useRef(index);
  indexRef.current = index;
  const sourceColorRef = useRef(sourceColor);
  sourceColorRef.current = sourceColor;
  const onDroppedRef = useRef(onDroppedChange);
  onDroppedRef.current = onDroppedChange;

  const limiterRef = useRef(createFlightRateLimiter(maxPerSecond));
  useEffect(() => {
    limiterRef.current.setRate(maxPerSecond);
  }, [maxPerSecond]);

  const animatorRef = useRef<PacketFlightAnimator | null>(null);
  useEffect(() => {
    const animator = new PacketFlightAnimator(map);
    animatorRef.current = animator;
    return () => {
      animator.destroy();
      animatorRef.current = null;
    };
  }, [map]);

  // Report the dropped count about once a second, and clear it on unmount.
  useEffect(() => {
    const limiter = limiterRef.current;
    let reported = -1;
    const report = () => {
      const dropped = limiter.dropped();
      if (dropped !== reported) {
        reported = dropped;
        onDroppedRef.current?.(dropped);
      }
    };
    report();
    const timer = setInterval(report, DROPPED_REPORT_MS);
    return () => {
      clearInterval(timer);
      limiter.resetDropped();
      onDroppedRef.current?.(0);
    };
  }, []);

  const colorCache = useRef(new Map<string, string>());
  const literal = (value: string): string => {
    let resolved = colorCache.current.get(value);
    if (resolved === undefined) {
      resolved = resolveCssColor(value);
      colorCache.current.set(value, resolved);
    }
    return resolved;
  };

  const onFlight = (flight: PacketFlight) => {
    const animator = animatorRef.current;
    if (!animator) return;
    const edge = resolveFlightEdge(flight, indexRef.current);
    if (!edge) return;
    if (!limiterRef.current.allow()) return;
    const color = sourceColorRef.current?.(flight.sourceId) ?? flightKindColor(flight.kind);
    animator.add(edge, literal(color));
  };

  usePacketFlights({ socket: state.socket, enabled: true, sourceIds, onFlight });
  return null;
}

export default PacketFlightsLayer;
