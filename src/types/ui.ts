export type TabType =
  | 'nodes'
  | 'channels'
  | 'messages'
  | 'info'
  | 'settings'
  | 'automation'
  | 'dashboard'
  | 'configuration'
  | 'notifications'
  | 'users'
  | 'audit'
  | 'security'
  // 'themes' removed (#3962 5.4 PR1): it had no `activeTab === 'themes'` render
  // in App and no Sidebar entry — custom-theme management lives inside the
  // `settings` tab (see CustomThemeManagement in SettingsTab), gated by the
  // separate `themes` *permission* resource (types/permission.ts), which is
  // unrelated to this tab enum. Was a dead VALID_TABS entry, never reachable.
  | 'admin'
  | 'packetmonitor'
  | 'mqtt-config';

// Valid tab types. Used by UIContext's activeTab<->route adapter to validate
// a path segment, and by App's hash->path redirect shim (#3962 5.4 PR1) to
// recognize a legacy `#tab` bookmark/deep-link. Lives here (not in
// UIContext.tsx) so it isn't a non-component named export from a file
// react-refresh treats as a component module. 'themes' intentionally
// omitted — see comment above.
export const VALID_TABS: TabType[] = ['nodes', 'channels', 'messages', 'info', 'settings', 'automation', 'dashboard', 'configuration', 'notifications', 'users', 'audit', 'security', 'admin', 'packetmonitor', 'mqtt-config'];

export type SortField = 'longName' | 'shortName' | 'id' | 'lastHeard' | 'snr' | 'battery' | 'hwModel' | 'hops';

export type SortDirection = 'asc' | 'desc';

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'configuring'
  | 'rebooting'
  | 'user-disconnected'
  | 'node-offline';

export interface MapCenterControllerProps {
  centerTarget: [number, number] | null;
  onCenterComplete: () => void;
  /** User-configurable target zoom (issue #4046 item 2). Defaults to 17. */
  targetZoom?: number;
}

export interface ChartData {
  timestamp: number;
  value: number | null; // null for solar-only data points
  time: string;
  solarEstimate?: number; // Solar power estimate in watt-hours
}

/**
 * Node popup position and target node
 */
export interface NodePopupState {
  nodeId: string;
  position: { x: number; y: number };
}

/**
 * System status information from the backend
 */
export interface SystemStatus {
  version: string;
  nodeVersion: string;
  uptime: string;
  platform: string;
  architecture: string;
  environment: string;
  memoryUsage: {
    heapUsed: string;
    heapTotal: string;
    rss: string;
  };
  database?: {
    type: string;
    version: string;
  };
}

/**
 * Node filter configuration
 * Controls which nodes are displayed in the node list based on various criteria
 */
export interface NodeFilters {
  filterMode: 'show' | 'hide';
  showMqtt: boolean;
  showTelemetry: boolean;
  showEnvironment: boolean;
  powerSource: 'powered' | 'battery' | 'both';
  showPosition: boolean;
  minHops: number;
  maxHops: number;
  showPKI: boolean;
  showRemoteAdmin: boolean;
  showUnknown: boolean;
  showIgnored: boolean;
  showFavoriteLocked: boolean;
  deviceRoles: number[];
  channels: number[];
}

/**
 * Security filter options
 */
export type SecurityFilter = 'all' | 'flaggedOnly' | 'hideFlagged';

/**
 * News item from meshmonitor.org
 */
export interface NewsItem {
  id: string;
  title: string;
  content: string;
  date: string;
  category: 'release' | 'security' | 'feature' | 'maintenance';
  priority: 'normal' | 'important';
  minVersion?: string;
}

/**
 * News feed containing multiple items
 */
export interface NewsFeed {
  version: string;
  lastUpdated: string;
  items: NewsItem[];
}

/**
 * User's news status (what they've seen/dismissed)
 */
export interface UserNewsStatus {
  lastSeenNewsId: string | null;
  dismissedNewsIds: string[];
}
