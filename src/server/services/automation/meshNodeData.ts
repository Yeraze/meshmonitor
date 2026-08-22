/**
 * Real NodeDataProvider (#3653) — hydrates the subject node + latest telemetry
 * from the database for condition evaluation. All reads are best-effort: a miss
 * returns null and the condition resolves to false rather than throwing.
 */
import databaseService from '../../../services/database.js';
import { ALL_SOURCES } from '../../../db/repositories/index.js';
import type { NodeDataProvider, NodeFacts, StaleCandidate } from './engineContext.js';
import { sourceProtocol } from './channelUnify.js';
import { sourceManagerRegistry } from '../../sourceManagerRegistry.js';
import { isMeshCoreManager } from '../../sourceManagerTypes.js';
import { isOwnNodeNum as isOwnedByAnySource, isOwnPublicKey as isOwnedPubkeyByAnySource } from '../../utils/ownNodes.js';

function nodeIdOf(nodeNum: number): string {
  return `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`;
}

export function createMeshNodeDataProvider(): NodeDataProvider {
  return {
    async getNode(sourceId, nodeNum) {
      try {
        const n = await databaseService.nodes.getNode(nodeNum, sourceId ?? undefined);
        return n ? (n as unknown as NodeFacts) : null;
      } catch {
        return null;
      }
    },

    async getTelemetry(_sourceId, nodeNum, telemetryType) {
      try {
        const t = await databaseService.getLatestTelemetryForTypeAsync(nodeIdOf(nodeNum), telemetryType);
        return t && t.value != null ? Number(t.value) : null;
      } catch {
        return null;
      }
    },

    /**
     * #4722 — current position of a waypoint a geofence is anchored to.
     *
     * An EXPIRED waypoint reads as gone. `expireAt` is epoch *seconds* (null or
     * 0 = never expires, matching `waypoints.listAsync`), and an expired
     * waypoint has already vanished from the map — continuing to fence the spot
     * it used to occupy would fire on a region the user believes no longer
     * exists. Failing closed here is the safer half of that trade.
     */
    async getWaypoint(sourceId, waypointId) {
      try {
        const w = await databaseService.waypoints.getAsync(sourceId, waypointId);
        if (!w || w.latitude == null || w.longitude == null) return null;
        if (w.expireAt != null && w.expireAt !== 0 && w.expireAt < Math.floor(Date.now() / 1000)) return null;
        return { latitude: Number(w.latitude), longitude: Number(w.longitude) };
      } catch {
        return null;
      }
    },

    async getChannelName(sourceId, channelIndex) {
      try {
        const ch = await databaseService.channels.getChannelById(channelIndex, sourceId ?? undefined);
        return ch?.name ?? null;
      } catch {
        return null;
      }
    },

    async getChannels(sourceId) {
      try {
        // intentional cross-source: omitting sourceId returns channels from all sources
        const chans = await databaseService.channels.getAllChannels(sourceId ?? ALL_SOURCES);
        return chans.map((c) => ({ id: c.id, name: c.name, psk: c.psk ?? null, role: c.role ?? null }));
      } catch {
        return [];
      }
    },

    async getSourceProtocol(sourceId) {
      try {
        if (!sourceId) return null;
        const s = await databaseService.sources.getSource(sourceId);
        return s ? sourceProtocol(s.type) : null;
      } catch {
        return null;
      }
    },

    async getSourceType(sourceId) {
      try {
        if (!sourceId) return null;
        const s = await databaseService.sources.getSource(sourceId);
        return s?.type ?? null;
      } catch {
        return null;
      }
    },

    // Self-identity accessors (#3914) — read the live manager for the source so
    // the engine can drop self-originated events. A miss (source not connected)
    // returns null → no drop.
    async getLocalNodeNum(sourceId) {
      try {
        if (!sourceId) return null;
        const nodeNum = sourceManagerRegistry.getManager(sourceId)?.getLocalNodeInfo()?.nodeNum;
        return nodeNum != null ? Number(nodeNum) : null;
      } catch {
        return null;
      }
    },

    // Cross-source owned-node check (#4593) — the fallback the engine uses when
    // the event's own source has no local identity (an MQTT bridge). Reads the
    // registry live; an empty registry means "nothing is ours" → no drop.
    async isOwnNodeNum(nodeNum) {
      try {
        return isOwnedByAnySource(nodeNum);
      } catch {
        return false;
      }
    },

    async getSelfPublicKey(sourceId) {
      try {
        if (!sourceId) return null;
        const m = sourceManagerRegistry.getManager(sourceId);
        return (m && isMeshCoreManager(m) ? m.getLocalNode()?.publicKey : null) ?? null;
      } catch {
        return null;
      }
    },

    // Cross-source owned-pubkey check (#4577 P2) — the fallback the engine uses
    // when the event's own MeshCore source has no self key (not yet connected)
    // or a different MeshCore source owns the key (multi-MC-source bridge
    // safety). Reads the registry live; an empty registry means "nothing is
    // ours" → no drop.
    async isOwnPublicKey(pubkey) {
      try {
        return isOwnedPubkeyByAnySource(pubkey);
      } catch {
        return false;
      }
    },

    // #4558 Phase A — enumerate every node across all registered sources with a
    // last-heard time normalized to epoch ms, for the periodic staleness check.
    // Best-effort: one source failing must not abort the rest, and an empty list
    // (or a missing method on an older provider) simply means no staleness fires.
    async listNodesForStaleCheck() {
      const out: StaleCandidate[] = [];
      try {
        for (const m of sourceManagerRegistry.getAllManagers()) {
          const sourceId = m.sourceId;
          try {
            if (m.sourceType === 'meshcore') {
              const nodes = await databaseService.meshcore.getNodesBySource(sourceId);
              for (const n of nodes) {
                // MeshCore lastHeard is already epoch milliseconds.
                out.push({ sourceId, nodeNum: null, publicKey: n.publicKey, lastHeardMs: n.lastHeard ?? null });
              }
            } else if (m.sourceType !== 'reticulum') {
              // Meshtastic TCP + MQTT bridge/broker all populate the `nodes` table.
              const nodes = await databaseService.nodes.getAllNodes(sourceId);
              for (const n of nodes) {
                // Meshtastic lastHeard is epoch SECONDS → normalize to ms.
                out.push({
                  sourceId,
                  nodeNum: Number(n.nodeNum),
                  publicKey: null,
                  lastHeardMs: n.lastHeard != null ? n.lastHeard * 1000 : null,
                });
              }
            }
          } catch {
            // skip this source; keep enumerating the others
          }
        }
      } catch {
        return out;
      }
      return out;
    },
  };
}
