export type TabType = 'nodes' | 'channels' | 'messages' | 'info' | 'settings';

export type SortField = 'longName' | 'shortName' | 'id' | 'lastHeard' | 'snr' | 'battery' | 'hwModel' | 'location' | 'hops';

export type SortDirection = 'asc' | 'desc';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'configuring';

export interface MapCenterControllerProps {
  centerTarget: [number, number] | null;
  onCenterComplete: () => void;
}