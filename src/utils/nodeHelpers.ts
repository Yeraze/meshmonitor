import { DeviceInfo } from '../types/device';
import { ROLE_NAMES } from '../constants';

export const getRoleName = (role: number | string | undefined): string | null => {
  if (role === undefined || role === null) return null;
  const roleNum = typeof role === 'string' ? parseInt(role) : role;
  if (isNaN(roleNum)) return null;
  return ROLE_NAMES[roleNum] || `Unknown (${roleNum})`;
};

export const getNodeName = (nodes: DeviceInfo[], nodeId: string): string => {
  const node = nodes.find(n => n.user?.id === nodeId);
  return node?.user?.longName || nodeId;
};

export const getNodeShortName = (nodes: DeviceInfo[], nodeId: string): string => {
  const node = nodes.find(n => n.user?.id === nodeId);
  return (node?.user?.shortName && node.user.shortName.trim()) || nodeId.substring(1, 5);
};