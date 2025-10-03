import { DeviceInfo } from '../types/device';
import { ROLE_NAMES, HARDWARE_MODELS } from '../constants';

export const getRoleName = (role: number | string | undefined): string | null => {
  if (role === undefined || role === null) return null;
  const roleNum = typeof role === 'string' ? parseInt(role) : role;
  if (isNaN(roleNum)) return null;
  return ROLE_NAMES[roleNum] || `Unknown (${roleNum})`;
};

export const getHardwareModelName = (hwModel: number | undefined): string | null => {
  if (hwModel === undefined || hwModel === null) return null;
  return HARDWARE_MODELS[hwModel] || `Unknown (${hwModel})`;
};

export const getNodeName = (nodes: DeviceInfo[], nodeId: string): string => {
  if (!nodeId) return 'Unknown';
  const node = nodes.find(n => n.user?.id === nodeId);
  return node?.user?.longName || nodeId;
};

export const getNodeShortName = (nodes: DeviceInfo[], nodeId: string): string => {
  if (!nodeId) return 'Unknown';
  const node = nodes.find(n => n.user?.id === nodeId);

  // Check if node has a shortName
  if (node?.user?.shortName && node.user.shortName.trim()) {
    return node.user.shortName.trim();
  }

  // Safely extract substring from nodeId
  // Node IDs are typically formatted as !XXXXXXXX (8 hex chars)
  if (nodeId.length >= 5 && nodeId.startsWith('!')) {
    return nodeId.substring(1, 5);
  }

  // Fallback to full nodeId if it's too short or doesn't match expected format
  return nodeId;
};