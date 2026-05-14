import type { MeshCoreMapNode } from '../contexts/MapContext';

// Small offset to prevent exact overlap on map when local node is at same location as contacts
export const LOCAL_NODE_OFFSET = 0.0005; // ~55m

export interface MeshCoreContact {
  publicKey: string;
  advName?: string;
  name?: string;
  lastSeen?: number;
  rssi?: number;
  snr?: number;
  advType?: number;
  latitude?: number;
  longitude?: number;
  lastAdvert?: number;
  pathLen?: number;
}

/**
 * Transform MeshCore contacts into map node objects.
 * Filters to only contacts with valid coordinates and applies
 * a small offset for the local node to prevent marker overlap.
 */
export function mapContactsToNodes(contacts: MeshCoreContact[]): MeshCoreMapNode[] {
  if (!Array.isArray(contacts)) return [];
  return contacts
    .filter(c => c.publicKey && typeof c.latitude === 'number' && isFinite(c.latitude)
      && typeof c.longitude === 'number' && isFinite(c.longitude))
    .map(c => {
      const isLocalNode = c.advName?.includes('(local)');
      return {
        publicKey: String(c.publicKey),
        name: c.advName || c.name || 'Unknown',
        latitude: c.latitude! + (isLocalNode ? LOCAL_NODE_OFFSET : 0),
        longitude: c.longitude! + (isLocalNode ? LOCAL_NODE_OFFSET : 0),
        rssi: typeof c.rssi === 'number' ? c.rssi : undefined,
        snr: typeof c.snr === 'number' ? c.snr : undefined,
        lastSeen: c.lastSeen,
        advType: c.advType,
      };
    });
}
