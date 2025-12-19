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
  | 'admin';

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
