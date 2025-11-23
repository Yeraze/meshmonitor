import api from './api';
import { PacketLog, PacketLogResponse, PacketStats, PacketFilters } from '../types/packet';

/**
 * Fetch packet logs with optional filters
 */
export const getPackets = async (
  offset: number = 0,
  limit: number = 100,
  filters?: PacketFilters
): Promise<PacketLogResponse> => {
  const params = new URLSearchParams({
    offset: offset.toString(),
    limit: limit.toString(),
  });

  if (filters?.portnum !== undefined) {
    params.append('portnum', filters.portnum.toString());
  }
  if (filters?.from_node !== undefined) {
    params.append('from_node', filters.from_node.toString());
  }
  if (filters?.to_node !== undefined) {
    params.append('to_node', filters.to_node.toString());
  }
  if (filters?.channel !== undefined) {
    params.append('channel', filters.channel.toString());
  }
  if (filters?.encrypted !== undefined) {
    params.append('encrypted', filters.encrypted.toString());
  }
  if (filters?.since !== undefined) {
    params.append('since', filters.since.toString());
  }

  return api.get<PacketLogResponse>(`/api/packets?${params.toString()}`);
};

/**
 * Fetch packet statistics
 */
export const getPacketStats = async (): Promise<PacketStats> => {
  return api.get<PacketStats>('/api/packets/stats');
};

/**
 * Fetch single packet by ID
 */
export const getPacketById = async (id: number): Promise<PacketLog> => {
  return api.get<PacketLog>(`/api/packets/${id}`);
};

/**
 * Export packet logs as JSONL file (server-side generation)
 */
export const exportPackets = async (filters?: PacketFilters): Promise<void> => {
  const params = new URLSearchParams();

  if (filters?.portnum !== undefined) {
    params.append('portnum', filters.portnum.toString());
  }
  if (filters?.from_node !== undefined) {
    params.append('from_node', filters.from_node.toString());
  }
  if (filters?.to_node !== undefined) {
    params.append('to_node', filters.to_node.toString());
  }
  if (filters?.channel !== undefined) {
    params.append('channel', filters.channel.toString());
  }
  if (filters?.encrypted !== undefined) {
    params.append('encrypted', filters.encrypted.toString());
  }
  if (filters?.since !== undefined) {
    params.append('since', filters.since.toString());
  }

  // Fetch export from backend with credentials
  const baseUrl = await api.getBaseUrl();
  const url = `${baseUrl}/api/packets/export?${params.toString()}`;

  const response = await fetch(url, {
    credentials: 'same-origin'
  });

  if (!response.ok) {
    throw new Error('Failed to export packets');
  }

  // Get filename from Content-Disposition header or generate one
  const contentDisposition = response.headers.get('Content-Disposition');
  let filename = 'packet-monitor.jsonl';
  if (contentDisposition) {
    const matches = /filename="(.+)"/.exec(contentDisposition);
    if (matches && matches[1]) {
      filename = matches[1];
    }
  }

  // Create blob and trigger download
  const blob = await response.blob();
  const blobUrl = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(blobUrl);
};

/**
 * Clear all packet logs (admin only)
 */
export const clearPackets = async (): Promise<{ message: string; deletedCount: number }> => {
  return api.delete<{ message: string; deletedCount: number }>('/api/packets');
};
