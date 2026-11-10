/**
 * MeshCore adapter for the root sampler (#6335).
 *
 * MeshCore observers publish to `meshcore/{REGION}/{PUBKEY}/packets|status`.
 * The finder subscribes to the status heartbeats only (`meshcore/+/+/status`):
 * one filter, never `#`, never the packets firehose. Each region is a root;
 * its distinct, currently active observers are its nodes.
 *
 * An observer counts as active when its status says `online` and either the
 * message arrived live or its `timestamp` is within {@link ACTIVE_WINDOW_MS}
 * of now. Status is retained, so a retained `online` from an observer that
 * died without a last will would otherwise count forever. A missing or
 * unparseable timestamp on a retained message counts as stale.
 *
 * Imports only the pure decode helpers of the ingest path, never a manager.
 */

import { decodeObserverStatusMessage, observerKeyFromTopic } from '../meshcoreMqttIngestPacket.js';
import { FLOOD_CAP, type HeardRoot, type RankedHeard } from './ladder.js';
import type { RootAdapter, RootObservation } from './rootAdapter.js';

/** Root passed to the sampler for MeshCore. Never a real region. */
export const MESHCORE_ROOT = 'meshcore';

/** Status is republished every 5 min; three missed refreshes means stale. */
export const ACTIVE_WINDOW_MS = 15 * 60_000;

/** A region segment as the ingest subscribes to it: upper case, short. */
export const REGION_RE = /^[A-Z0-9_-]{1,16}$/;

function isFresh(timestamp: unknown, now: number): boolean {
  if (typeof timestamp !== 'string' || !timestamp) return false;
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at)) return false;
  return Math.abs(now - at) <= ACTIVE_WINDOW_MS;
}

export function createMeshcoreRegionAdapter(now: () => number = Date.now): RootAdapter {
  return {
    filters(): string[] {
      return [`${MESHCORE_ROOT}/+/+/status`];
    },

    cappedFilter(): null {
      return null;
    },

    classify(topic: string, payload: Buffer, meta?: { retained: boolean }): RootObservation | null {
      const parts = topic.split('/');
      if (parts.length !== 4 || parts[0] !== MESHCORE_ROOT || parts[3] !== 'status') return null;
      const region = parts[1];
      // The ingest upper-cases the region on subscribe, so a lower-case one
      // on the wire is not a region a source could use.
      if (region !== region.toUpperCase() || !REGION_RE.test(region)) return null;

      let body: unknown;
      try {
        body = JSON.parse(payload.toString('utf8'));
      } catch {
        return null;
      }
      const status = decodeObserverStatusMessage(body);
      if (!status) return null;
      // Same spoof check the ingest uses: the body must name the topic's key.
      if (observerKeyFromTopic(topic) !== status.originId) return null;

      const live = meta?.retained === false;
      const timestamp = (body as Record<string, unknown>).timestamp;
      const active = status.online && (live || isFresh(timestamp, now()));
      return active
        ? { root: region, stream: 'status', nodeKey: status.originId }
        : { root: region, stream: 'status' };
    },
  };
}

export const meshcoreRegionAdapter: RootAdapter = createMeshcoreRegionAdapter();

/**
 * Rank MeshCore regions by activity only: active observers, then status
 * messages, then code. No distance: status carries no position and there is
 * no code-to-location table.
 */
export function rankRegions(heard: HeardRoot[]): RankedHeard[] {
  return heard
    .map(
      (h): RankedHeard => ({
        root: h.root,
        nodes: h.nodes,
        messages: h.messages,
        depth: 1,
        tier: 3,
        retainedOnly: h.retainedOnly,
        floor: !!h.floor || h.messages >= FLOOD_CAP,
      }),
    )
    .sort((a, b) => {
      if (a.nodes !== b.nodes) return b.nodes - a.nodes;
      if (a.messages !== b.messages) return b.messages - a.messages;
      return a.root < b.root ? -1 : a.root > b.root ? 1 : 0;
    });
}
