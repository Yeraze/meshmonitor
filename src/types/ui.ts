export type TabType = 'nodes' | 'channels' | 'messages' | 'info' | 'settings' | 'dashboard' | 'configuration';

export type SortField = 'longName' | 'shortName' | 'id' | 'lastHeard' | 'snr' | 'battery' | 'hwModel' | 'hops';

export type SortDirection = 'asc' | 'desc';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'configuring' | 'rebooting';

export interface MapCenterControllerProps {
  centerTarget: [number, number] | null;
  onCenterComplete: () => void;
}