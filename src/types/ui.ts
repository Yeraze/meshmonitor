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
  | 'themes'
  | 'admin'
  | 'meshcore';

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
  showUnknown: boolean;
  showIgnored: boolean;
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
