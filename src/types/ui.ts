export type TabType = 'nodes' | 'channels' | 'messages' | 'info' | 'settings' | 'automation' | 'dashboard' | 'configuration' | 'notifications' | 'users' | 'audit' | 'security' | 'themes';

export type SortField = 'longName' | 'shortName' | 'id' | 'lastHeard' | 'snr' | 'battery' | 'hwModel' | 'hops';

export type SortDirection = 'asc' | 'desc';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'configuring' | 'rebooting' | 'user-disconnected' | 'node-offline';

export interface MapCenterControllerProps {
  centerTarget: [number, number] | null;
  onCenterComplete: () => void;
}