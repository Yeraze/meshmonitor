/**
 * Packet Log Types
 */

export interface PacketLog {
  id: number;
  packet_id?: number;
  timestamp: number;
  from_node: number;
  from_node_id?: string;
  from_node_longName?: string;
  to_node?: number;
  to_node_id?: string;
  to_node_longName?: string;
  channel?: number;
  portnum: number;
  portnum_name?: string;
  encrypted: boolean;
  snr?: number;
  rssi?: number;
  hop_limit?: number;
  hop_start?: number;
  relay_node?: number;
  payload_size?: number;
  want_ack?: boolean;
  priority?: number;
  payload_preview?: string;
  metadata?: string;
  direction?: 'rx' | 'tx';
  created_at?: number;
  decrypted_by?: 'node' | 'server' | null;
  decrypted_channel_id?: number | null;
  transport_mechanism?: number;
  /** Present on cross-source (unified) packet rows — the source that received it. */
  sourceId?: string;
  sourceName?: string;
}

export interface PacketLogResponse {
  packets: PacketLog[];
  total: number;
  offset: number;
  limit: number;
  maxCount: number;
  maxAgeHours: number;
}

export interface PacketStats {
  total: number;
  encrypted: number;
  decoded: number;
  maxCount: number;
  maxAgeHours: number;
  enabled: boolean;
}

export interface PacketFilters {
  portnum?: number;
  from_node?: number;
  to_node?: number;
  channel?: number;
  encrypted?: boolean;
  since?: number;
  relay_node?: number | 'unknown';
  transport_mechanism?: number;
  sourceId?: string;
}

/** Filters accepted by the unified packet stream (no offset — keyset cursor). */
export interface UnifiedPacketFilters {
  portnum?: number;
  encrypted?: boolean;
  transport_mechanism?: number;
  from_node?: number;
  /** Restrict the stream to a single source within the unified view. */
  sourceId?: string;
}

export interface UnifiedSourceRef {
  id: string;
  name: string;
}

export interface UnifiedPacketsResponse {
  packets: PacketLog[];
  hasMore: boolean;
  nextCursor: string | null;
  /** Every source the user can read (drives the source filter dropdown). */
  sources: UnifiedSourceRef[];
}

export interface UnifiedPacketBySource {
  sourceId: string;
  sourceName: string;
  count: number;
}

export interface UnifiedPacketDistribution {
  byDevice: PacketCountByDevice[];
  byType: PacketCountByType[];
  bySource: UnifiedPacketBySource[];
  total: number;
  enabled: boolean;
}

export interface PacketMonitorSettings {
  enabled: boolean;
  maxCount: number;
  maxAgeHours: number;
  panelPosition: 'right' | 'bottom';
  showPanel: boolean;
  autoScroll: boolean;
}

export interface PacketCountByDevice {
  from_node: number;
  from_node_id: string | null;
  from_node_longName: string | null;
  count: number;
}

export interface PacketCountByType {
  portnum: number;
  portnum_name: string;
  count: number;
}

export interface RelayNodeOption {
  relay_node: number;
  matching_nodes: Array<{ longName: string | null; shortName: string | null }>;
}

export interface RelayNodesResponse {
  relayNodes: RelayNodeOption[];
}

export interface PacketDistributionStats {
  byDevice: PacketCountByDevice[];
  byType: PacketCountByType[];
  total: number;
  enabled: boolean;
}
