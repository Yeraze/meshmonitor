/**
 * Real NodeDataProvider (#3653) — hydrates the subject node + latest telemetry
 * from the database for condition evaluation. All reads are best-effort: a miss
 * returns null and the condition resolves to false rather than throwing.
 */
import databaseService from '../../../services/database.js';
import type { NodeDataProvider, NodeFacts } from './engineContext.js';
import { sourceProtocol } from './channelUnify.js';
import { sourceManagerRegistry } from '../../sourceManagerRegistry.js';
import { meshcoreManagerRegistry } from '../../meshcoreRegistry.js';

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
        const chans = await databaseService.channels.getAllChannels(sourceId ?? undefined);
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

    // Self-identity accessors (#3914) — read the live manager for the source so
    // the engine can drop self-originated events. Meshtastic and MeshCore live
    // in separate registries; a miss (source not connected) returns null → no drop.
    async getLocalNodeNum(sourceId) {
      try {
        if (!sourceId) return null;
        const nodeNum = sourceManagerRegistry.getManager(sourceId)?.getLocalNodeInfo()?.nodeNum;
        return nodeNum != null ? Number(nodeNum) : null;
      } catch {
        return null;
      }
    },

    async getSelfPublicKey(sourceId) {
      try {
        if (!sourceId) return null;
        return meshcoreManagerRegistry.get(sourceId)?.getLocalNode()?.publicKey ?? null;
      } catch {
        return null;
      }
    },
  };
}
