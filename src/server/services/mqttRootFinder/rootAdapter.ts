/**
 * Protocol seam for the root sampler (#6287, spec 2.4).
 *
 * The sampler, job registry, routes and UI are shared. Only the topic filters
 * and the way one message maps to a root differ per protocol: Meshtastic
 * (`meshtasticRootAdapter`) and MeshCore regions (`meshcoreRegionAdapter`,
 * #6335).
 */

import type { LatLon } from './ladder.js';

export interface RootObservation {
  /** Root this message was published under. */
  root: string;
  /**
   * `e` is the Meshtastic encrypted packet stream, `map` the Meshtastic
   * map-report stream, `status` a MeshCore observer heartbeat.
   */
  stream: 'e' | 'map' | 'status';
  /** Stable key for the node behind the message, for distinct-node counts. */
  nodeKey?: string;
  /** Position from a map report. Kept on the server, never returned. */
  pos?: LatLon;
}

export interface RootAdapter {
  /** Topic filters to subscribe to. Never contains `#`. */
  filters(regionRoot: string): string[];
  /**
   * The filter that carries the region's own packet stream. The sampler cuts
   * it after the packet cap. `null` when the protocol has no such stream.
   */
  cappedFilter(regionRoot: string): string | null;
  /**
   * Map one received message to a root, or `null` to ignore it. `meta.retained`
   * is true for a message the broker replayed from its retained store.
   */
  classify(topic: string, payload: Buffer, meta?: { retained: boolean }): RootObservation | null;
}
