/**
 * Real NodeDataProvider (#3653) — hydrates the subject node + latest telemetry
 * from the database for condition evaluation. All reads are best-effort: a miss
 * returns null and the condition resolves to false rather than throwing.
 */
import databaseService from '../../../services/database.js';
import type { NodeDataProvider, NodeFacts } from './engineContext.js';

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
  };
}
