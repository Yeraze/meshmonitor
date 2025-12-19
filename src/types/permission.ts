/**
 * Permission and Authorization Types
 */

export type ResourceType =
  | 'dashboard'
  | 'nodes'
  | 'channel_0'
  | 'channel_1'
  | 'channel_2'
  | 'channel_3'
  | 'channel_4'
  | 'channel_5'
  | 'channel_6'
  | 'channel_7'
  | 'messages'
  | 'settings'
  | 'configuration'
  | 'info'
  | 'automation'
  | 'connection'
  | 'traceroute'
  | 'audit'
  | 'security'
  | 'themes';

export type PermissionAction = 'read' | 'write';

export interface Permission {
  id: number;
  userId: number;
  resource: ResourceType;
  canRead: boolean;
  canWrite: boolean;
  grantedAt: number; // Unix timestamp
  grantedBy: number | null; // User ID who granted this permission
}

export interface PermissionInput {
  userId: number;
  resource: ResourceType;
  canRead: boolean;
  canWrite: boolean;
  grantedBy?: number;
}

export type PermissionSet = Partial<{
  [K in ResourceType]: {
    read: boolean;
    write: boolean;
  };
}>;

export interface ResourceDefinition {
  id: ResourceType;
  name: string;
  description: string;
}

export const RESOURCES: readonly ResourceDefinition[] = [
  { id: 'dashboard', name: 'Dashboard', description: 'View statistics and system info' },
  { id: 'nodes', name: 'Node List', description: 'View and manage mesh nodes' },
  { id: 'channel_0', name: 'Channel 0 (Primary)', description: 'View and send messages to channel 0' },
  { id: 'channel_1', name: 'Channel 1', description: 'View and send messages to channel 1' },
  { id: 'channel_2', name: 'Channel 2', description: 'View and send messages to channel 2' },
  { id: 'channel_3', name: 'Channel 3', description: 'View and send messages to channel 3' },
  { id: 'channel_4', name: 'Channel 4', description: 'View and send messages to channel 4' },
  { id: 'channel_5', name: 'Channel 5', description: 'View and send messages to channel 5' },
  { id: 'channel_6', name: 'Channel 6', description: 'View and send messages to channel 6' },
  { id: 'channel_7', name: 'Channel 7', description: 'View and send messages to channel 7' },
  { id: 'messages', name: 'Direct Messages', description: 'Send and receive direct messages' },
  { id: 'settings', name: 'Settings', description: 'Application settings' },
  { id: 'configuration', name: 'Configuration', description: 'Device configuration' },
  { id: 'info', name: 'Info', description: 'Telemetry and network information' },
  { id: 'automation', name: 'Automation', description: 'Automated tasks and announcements' },
  { id: 'connection', name: 'Connection', description: 'Control node connection (disconnect/reconnect)' },
  { id: 'traceroute', name: 'Traceroute', description: 'Initiate traceroute requests to nodes' },
  { id: 'audit', name: 'Audit Log', description: 'View and manage audit logs (admin only)' },
  { id: 'security', name: 'Security', description: 'View security scan results and key management' },
  { id: 'themes', name: 'Custom Themes', description: 'Create and manage custom color themes' },
] as const;

// Default permissions for different user types
export const ADMIN_PERMISSIONS: PermissionSet = {
  dashboard: { read: true, write: true },
  nodes: { read: true, write: true },
  channel_0: { read: true, write: true },
  channel_1: { read: true, write: true },
  channel_2: { read: true, write: true },
  channel_3: { read: true, write: true },
  channel_4: { read: true, write: true },
  channel_5: { read: true, write: true },
  channel_6: { read: true, write: true },
  channel_7: { read: true, write: true },
  messages: { read: true, write: true },
  settings: { read: true, write: true },
  configuration: { read: true, write: true },
  info: { read: true, write: true },
  automation: { read: true, write: true },
  connection: { read: true, write: true },
  traceroute: { read: true, write: true },
  audit: { read: true, write: true },
  security: { read: true, write: true },
  themes: { read: true, write: true },
};

export const DEFAULT_USER_PERMISSIONS: PermissionSet = {
  dashboard: { read: true, write: false },
  nodes: { read: true, write: false },
  channel_0: { read: true, write: false },
  channel_1: { read: true, write: false },
  channel_2: { read: true, write: false },
  channel_3: { read: true, write: false },
  channel_4: { read: true, write: false },
  channel_5: { read: true, write: false },
  channel_6: { read: true, write: false },
  channel_7: { read: true, write: false },
  messages: { read: true, write: false },
  settings: { read: false, write: false },
  configuration: { read: false, write: false },
  info: { read: true, write: false },
  automation: { read: false, write: false },
  connection: { read: true, write: false },
  traceroute: { read: true, write: false },
  audit: { read: false, write: false },
  security: { read: false, write: false },
  themes: { read: true, write: false },
};
