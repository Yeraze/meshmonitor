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
  | 'automations'
  | 'connection'
  | 'traceroute'
  | 'audit'
  | 'security'
  | 'themes'
  | 'nodes_private'
  | 'packetmonitor'
  | 'sources'
  | 'waypoints'
  | 'channel_database'
  | 'remote_admin';

export type PermissionAction = 'viewOnMap' | 'read' | 'write';

export interface Permission {
  id: number;
  userId: number;
  resource: ResourceType;
  canViewOnMap: boolean;
  canRead: boolean;
  canWrite: boolean;
  grantedAt: number; // Unix timestamp
  grantedBy: number | null; // User ID who granted this permission
}

export interface PermissionInput {
  userId: number;
  resource: ResourceType;
  canViewOnMap: boolean;
  canRead: boolean;
  canWrite: boolean;
  grantedBy?: number;
}

export type PermissionSet = Partial<{
  [K in ResourceType]: {
    viewOnMap?: boolean;
    read: boolean;
    write: boolean;
  };
}>;

/**
 * Resources whose permissions are scoped per-source. This is the single
 * canonical definition of that classification — see
 * `docs/internal/dev-notes/PER_SOURCE_NODE_DISPLAY_PHASE6_SPEC.md` §2.2 for the
 * repo-scanning drift guard (`src/types/permission.sourcey.test.ts`) that keeps
 * a second competing list from being reintroduced (issue #4416). Grants on
 * these resources always carry a sourceId.
 *
 * Adding an entry here is a BREAKING CHANGE: it flips a resource from globally
 * authorized to per-source authorized, which silently drops every existing
 * global grant for that resource unless a fan-out migration first copies each
 * grant onto every source (see spec §3; migration 132 fanned out `settings`
 * when it was added here). Do not add an entry without a matching migration.
 *
 * `dashboard`, `info`, `audit`, and `security` are deliberately NOT included —
 * see spec §1.3 (they are cross-source nav gates, or their underlying data has
 * no `sourceId` column). This is a decision, not an oversight.
 */
export const SOURCEY_RESOURCES: readonly ResourceType[] = [
  'channel_0', 'channel_1', 'channel_2', 'channel_3',
  'channel_4', 'channel_5', 'channel_6', 'channel_7',
  'messages', 'nodes', 'nodes_private', 'traceroute',
  'packetmonitor', 'configuration', 'connection', 'automation',
  'waypoints', 'remote_admin', 'settings',
] as const;

const SOURCEY_RESOURCE_SET = new Set<ResourceType>(SOURCEY_RESOURCES);

export function isSourceyResource(resource: ResourceType): boolean {
  return SOURCEY_RESOURCE_SET.has(resource);
}

/**
 * Resources granted to a newly provisioned non-admin user, written at GLOBAL
 * scope (`sourceId = NULL`) by the local, JIT and OIDC provisioning paths.
 *
 * **Every entry here must be absent from `SOURCEY_RESOURCES`.** The sourcey
 * branch of `checkPermissionAsync` reads only `bySource` and ignores
 * `sourceId = NULL` rows, so a per-source resource seeded here produces a row
 * that is written, visible in the admin UI, and authorizes nothing.
 *
 * That is exactly what this list used to do (issue #4448). It previously read
 * `['dashboard','nodes','messages','settings','info','traceroute']`, of which
 * four — `nodes`, `messages`, `traceroute`, and (after #4416) `settings` — are
 * per-source. New users got a working dashboard and info and nothing else,
 * while the admin UI displayed all six as granted, which is why it went
 * unnoticed. Dropping them changes **no** effective access; it stops writing
 * misleading rows.
 *
 * Per-source access is granted explicitly by an admin, matching the decision
 * that a newly created *source* also starts with no grants.
 *
 * `permission.sourcey.test.ts` asserts the disjointness above, so adding a
 * sourcey resource here fails the build rather than silently doing nothing.
 */
export const DEFAULT_NEW_USER_RESOURCES: readonly ResourceType[] = [
  'dashboard', 'info',
] as const;

/**
 * Response shape for the split permission model: non-sourcey grants live in
 * `global`; per-source grants are keyed by sourceId in `bySource`. Replaces
 * the old OR-merged single map that leaked grants across sources.
 */
export interface SourcedPermissionSet {
  global: PermissionSet;
  bySource: Record<string, PermissionSet>;
}

export interface ResourceDefinition {
  id: ResourceType;
  name: string;
  description: string;
}

export const RESOURCES: readonly ResourceDefinition[] = [
  // Listed first on purpose: MeshCoreSourcePage gates its ENTIRE surface on
  // `connection: read`, so without it every other grant on a MeshCore source is
  // inert and the user just sees "You do not have permission to view this
  // MeshCore source". Granting it is the first thing you need, so it reads
  // first.
  {
    id: 'connection',
    name: 'Connection',
    description: 'Required to open a source. Also controls connect/disconnect.',
  },
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
  { id: 'messages', name: 'Node Details & DM', description: 'View node details and send/receive direct messages' },
  { id: 'settings', name: 'Settings', description: 'Application settings' },
  { id: 'configuration', name: 'Configuration', description: 'Device configuration' },
  { id: 'info', name: 'Info', description: 'Telemetry and network information' },
  { id: 'automation', name: 'Automation', description: 'Automated tasks and announcements' },
  { id: 'automations', name: 'Automation Engine', description: 'Create and manage global automations and variables (Advanced Mode)' },
  { id: 'traceroute', name: 'Traceroute', description: 'Initiate traceroute requests to nodes' },
  { id: 'audit', name: 'Audit Log', description: 'View and manage audit logs (admin only)' },
  { id: 'security', name: 'Security', description: 'View security scan results and key management' },
  { id: 'themes', name: 'Custom Themes', description: 'Create and manage custom color themes' },
  { id: 'nodes_private', name: 'Private Positions', description: 'View private node position overrides' },
  { id: 'packetmonitor', name: 'Packet Monitor', description: 'View real-time packet logs and statistics' },
  { id: 'sources', name: 'Sources', description: 'Manage data sources (Meshtastic TCP, MQTT, MeshCore)' },
  { id: 'waypoints', name: 'Waypoints', description: 'View and manage map waypoints (Meshtastic WAYPOINT_APP)' },
  { id: 'channel_database', name: 'Channel Database', description: 'Manage global channel/PSK library used for MQTT decryption' },
  { id: 'remote_admin', name: 'Remote Administration', description: 'Send admin/CLI commands to remote MeshCore nodes (login, reboot, configure) — per-source' },
] as const;

// Default permissions for different user types
export const ADMIN_PERMISSIONS: PermissionSet = {
  dashboard: { read: true, write: true },
  nodes: { read: true, write: true },
  channel_0: { viewOnMap: true, read: true, write: true },
  channel_1: { viewOnMap: true, read: true, write: true },
  channel_2: { viewOnMap: true, read: true, write: true },
  channel_3: { viewOnMap: true, read: true, write: true },
  channel_4: { viewOnMap: true, read: true, write: true },
  channel_5: { viewOnMap: true, read: true, write: true },
  channel_6: { viewOnMap: true, read: true, write: true },
  channel_7: { viewOnMap: true, read: true, write: true },
  messages: { read: true, write: true },
  settings: { read: true, write: true },
  configuration: { read: true, write: true },
  info: { read: true, write: true },
  automation: { read: true, write: true },
  automations: { read: true, write: true },
  connection: { read: true, write: true },
  traceroute: { read: true, write: true },
  audit: { read: true, write: true },
  security: { read: true, write: true },
  themes: { read: true, write: true },
  nodes_private: { read: true, write: true },
  packetmonitor: { read: true, write: true },
  sources: { read: true, write: true },
  waypoints: { read: true, write: true },
  channel_database: { read: true, write: true },
  remote_admin: { read: true, write: true },
};

export const DEFAULT_USER_PERMISSIONS: PermissionSet = {
  dashboard: { read: true, write: false },
  nodes: { read: true, write: false },
  channel_0: { viewOnMap: true, read: true, write: false },
  channel_1: { viewOnMap: true, read: true, write: false },
  channel_2: { viewOnMap: true, read: true, write: false },
  channel_3: { viewOnMap: true, read: true, write: false },
  channel_4: { viewOnMap: true, read: true, write: false },
  channel_5: { viewOnMap: true, read: true, write: false },
  channel_6: { viewOnMap: true, read: true, write: false },
  channel_7: { viewOnMap: true, read: true, write: false },
  messages: { read: true, write: false },
  settings: { read: false, write: false },
  configuration: { read: false, write: false },
  info: { read: true, write: false },
  automation: { read: false, write: false },
  automations: { read: false, write: false },
  connection: { read: true, write: false },
  traceroute: { read: true, write: false },
  audit: { read: false, write: false },
  security: { read: false, write: false },
  themes: { read: true, write: false },
  nodes_private: { read: false, write: false },
  packetmonitor: { read: true, write: false },
  sources: { read: false, write: false },
  waypoints: { read: true, write: false },
  channel_database: { read: false, write: false },
  remote_admin: { read: false, write: false },
};
