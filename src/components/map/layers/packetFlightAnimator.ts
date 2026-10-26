/**
 * The moving parts of the live packet traffic layer (#4835): a dot that flies
 * along a straight line with a short trail, then fades out while a ring
 * pulses out from the node that heard it.
 *
 * Imperative Leaflet, one requestAnimationFrame loop for every dot in flight
 * (the AssetPlaybackBar pattern: rAF + setLatLng). The loop runs only while
 * something is in flight. At most `maxConcurrent` dots animate at once; a new
 * one past the cap finishes the oldest first. `destroy()` removes every layer
 * and stops the loop.
 */
import L from 'leaflet';
import { MAX_CONCURRENT_FLIGHTS, flightDurationMs, type FlightEdge } from '../../../utils/packetFlightEdges';

/** How long a dot takes to fade once it lands, ms. */
export const FLIGHT_FADE_MS = 400;
/** How long the landing ring takes to spread and fade, ms. The flight ends with it. */
export const FLIGHT_PULSE_MS = 900;
/** The landing ring's radius at the start and end of its pulse, px. */
const PULSE_RADIUS_FROM = 8;
const PULSE_RADIUS_TO = 30;
/** The pane the dots draw in: above the node markers, so a dot landing on a node stays visible. */
export const FLIGHT_PANE = 'packetFlightsPane';
/** Trail length, as a share of the line. */
const TRAIL_FRACTION = 0.25;

interface ActiveFlight {
  edge: FlightEdge;
  start: number;
  duration: number;
  guide: L.Polyline;
  trail: L.Polyline;
  dot: L.CircleMarker;
  /** The landing ring, made when the dot lands. */
  ring: L.CircleMarker | null;
  color: string;
  baseGuideOpacity: number;
  baseTrailOpacity: number;
  baseDotOpacity: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function pointAt(edge: FlightEdge, t: number): L.LatLngExpression {
  return [lerp(edge.from.lat, edge.to.lat, t), lerp(edge.from.lng, edge.to.lng, t)];
}

export class PacketFlightAnimator {
  private readonly active: ActiveFlight[] = [];
  private frame: number | null = null;
  private destroyed = false;

  constructor(
    private readonly map: L.Map,
    private readonly maxConcurrent: number = MAX_CONCURRENT_FLIGHTS,
  ) {
    if (!map.getPane(FLIGHT_PANE)) {
      const pane = map.createPane(FLIGHT_PANE);
      // Above markerPane (600), below tooltips (650) and popups (700).
      pane.style.zIndex = '640';
      pane.style.pointerEvents = 'none';
    }
  }

  /** Dots now in flight or fading. */
  get activeCount(): number {
    return this.active.length;
  }

  /** Start one dot. `color` must be a literal colour (Leaflet sets SVG attributes, which skip `var()`). */
  add(edge: FlightEdge, color: string): void {
    if (this.destroyed) return;
    while (this.active.length >= this.maxConcurrent) {
      const oldest = this.active.shift();
      if (oldest) this.removeFlight(oldest);
    }
    const viaMesh = edge.viaMesh;
    const baseGuideOpacity = viaMesh ? 0.18 : 0.35;
    const baseTrailOpacity = viaMesh ? 0.4 : 0.75;
    const baseDotOpacity = viaMesh ? 0.55 : 0.95;
    const guide = L.polyline([[edge.from.lat, edge.from.lng], [edge.to.lat, edge.to.lng]], {
      color,
      weight: 2,
      opacity: baseGuideOpacity,
      dashArray: viaMesh ? '4 6' : undefined,
      interactive: false,
      pane: FLIGHT_PANE,
      className: 'packet-flight-guide',
    }).addTo(this.map);
    const trail = L.polyline([pointAt(edge, 0), pointAt(edge, 0)], {
      color,
      weight: 5,
      opacity: baseTrailOpacity,
      lineCap: 'round',
      dashArray: viaMesh ? '2 4' : undefined,
      interactive: false,
      pane: FLIGHT_PANE,
      className: 'packet-flight-trail',
    }).addTo(this.map);
    const dot = L.circleMarker(pointAt(edge, 0), {
      radius: viaMesh ? 6 : 9,
      color,
      weight: 2,
      opacity: baseDotOpacity,
      fillColor: color,
      fillOpacity: baseDotOpacity,
      interactive: false,
      pane: FLIGHT_PANE,
      className: 'packet-flight-dot',
    }).addTo(this.map);
    this.active.push({
      edge,
      start: performance.now(),
      duration: flightDurationMs(edge.from, edge.to),
      guide,
      trail,
      dot,
      ring: null,
      color,
      baseGuideOpacity,
      baseTrailOpacity,
      baseDotOpacity,
    });
    this.schedule();
  }

  /** Remove every dot and stop. The animator does nothing after this. */
  destroy(): void {
    this.destroyed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    for (const f of this.active.splice(0)) this.removeFlight(f);
  }

  private schedule(): void {
    if (this.frame === null && !this.destroyed) {
      this.frame = requestAnimationFrame(this.tick);
    }
  }

  private readonly tick = (now: number): void => {
    this.frame = null;
    if (this.destroyed) return;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const f = this.active[i];
      const elapsed = now - f.start;
      if (elapsed >= f.duration + FLIGHT_PULSE_MS) {
        this.active.splice(i, 1);
        this.removeFlight(f);
        continue;
      }
      const t = Math.min(1, Math.max(0, elapsed / f.duration));
      const head = pointAt(f.edge, t);
      f.dot.setLatLng(head);
      f.trail.setLatLngs([pointAt(f.edge, Math.max(0, t - TRAIL_FRACTION)), head]);
      if (elapsed > f.duration) {
        const fade = Math.max(0, 1 - (elapsed - f.duration) / FLIGHT_FADE_MS);
        const pulse = Math.min(1, (elapsed - f.duration) / FLIGHT_PULSE_MS);
        if (!f.ring) {
          f.ring = L.circleMarker([f.edge.to.lat, f.edge.to.lng], {
            radius: PULSE_RADIUS_FROM,
            color: f.color,
            weight: 3,
            fill: false,
            interactive: false,
            pane: FLIGHT_PANE,
            className: 'packet-flight-ring',
          }).addTo(this.map);
        }
        f.ring.setRadius(lerp(PULSE_RADIUS_FROM, PULSE_RADIUS_TO, pulse));
        f.ring.setStyle({ opacity: f.baseDotOpacity * (1 - pulse) });
        f.dot.setStyle({ opacity: f.baseDotOpacity * fade, fillOpacity: f.baseDotOpacity * fade });
        f.trail.setStyle({ opacity: f.baseTrailOpacity * fade });
        f.guide.setStyle({ opacity: f.baseGuideOpacity * fade });
      }
    }
    if (this.active.length > 0) this.schedule();
  };

  private removeFlight(f: ActiveFlight): void {
    f.dot.remove();
    f.trail.remove();
    f.guide.remove();
    f.ring?.remove();
  }
}
