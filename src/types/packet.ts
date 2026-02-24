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

export interface PacketDistributionStats {
  byDevice: PacketCountByDevice[];
  byType: PacketCountByType[];
  total: number;
  enabled: boolean;
}
