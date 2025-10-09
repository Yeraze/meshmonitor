/**
 * Permission and Authorization Types
 */

export type ResourceType =
  | 'dashboard'
  | 'nodes'
  | 'messages'
  | 'settings'
  | 'configuration'
  | 'info'
  | 'automation';

export type PermissionAction = 'read' | 'write';

export interface Permission {
  id: number;
  userId: number;
  resource: ResourceType;
  canRead: boolean;
  canWrite: boolean;
  grantedAt: number;        // Unix timestamp
  grantedBy: number | null; // User ID who granted this permission
}

export interface PermissionInput {
  userId: number;
  resource: ResourceType;
  canRead: boolean;
  canWrite: boolean;
  grantedBy?: number;
}

export interface PermissionSet {
  [key: string]: {
    read: boolean;
    write: boolean;
  };
}

export interface ResourceDefinition {
  id: ResourceType;
  name: string;
  description: string;
}

export const RESOURCES: readonly ResourceDefinition[] = [
  { id: 'dashboard', name: 'Dashboard', description: 'View statistics and system info' },
  { id: 'nodes', name: 'Node List', description: 'View and manage mesh nodes' },
  { id: 'messages', name: 'Messages', description: 'Send and receive mesh messages' },
  { id: 'settings', name: 'Settings', description: 'Application settings' },
  { id: 'configuration', name: 'Configuration', description: 'Device configuration' },
  { id: 'info', name: 'Info', description: 'Telemetry and network information' },
  { id: 'automation', name: 'Automation', description: 'Automated tasks and announcements' }
] as const;

// Default permissions for different user types
export const ADMIN_PERMISSIONS: PermissionSet = {
  dashboard: { read: true, write: true },
  nodes: { read: true, write: true },
  messages: { read: true, write: true },
  settings: { read: true, write: true },
  configuration: { read: true, write: true },
  info: { read: true, write: true },
  automation: { read: true, write: true }
};

export const DEFAULT_USER_PERMISSIONS: PermissionSet = {
  dashboard: { read: true, write: false },
  nodes: { read: true, write: false },
  messages: { read: true, write: false },
  settings: { read: false, write: false },
  configuration: { read: false, write: false },
  info: { read: true, write: false },
  automation: { read: false, write: false }
};
