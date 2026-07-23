import React, { createContext, useContext, useState, useMemo, ReactNode } from 'react';
import { ConnectionStatus } from '../types/ui';

// messages/channelMessages (+ their channelHasMore/channelLoadingMore/
// dmHasMore/dmLoadingMore pagination state) were removed (#3962 5.4 PR7).
// They were never pure poll-cache mirrors — the optimistic-send merge and
// infinite-scroll pagination logic they need moved to `useMessagingView`
// (src/hooks/useMessagingView.ts), which now owns this state itself instead
// of prop-drilling it through DataContext.
//
// nodes/channels were removed (#3962 5.4 PR8) — they WERE pure poll-cache
// mirrors (App.tsx's processPollData just copied usePoll()'s data.nodes/
// data.channels in here on every tick, plus a pending-optimistic-toggle
// overlay for nodes). Consumers now read them straight from the poll cache
// via useNodes()/useChannels() (src/hooks/useServerData.ts); the toggle
// overlay moved to applyPendingNodeOverrides (src/utils/pendingToggles.ts),
// applied by useNodes() on every read, and optimistic writes go through
// setNodeFieldInCache (src/hooks/useServerData.ts) instead of setNodes.
//
// connectionStatus stays: unlike nodes/channels, it is NOT a poll-cache
// mirror. It's a richer client-driven state machine — values 'rebooting',
// 'configuring', 'node-offline', 'connecting', 'user-disconnected' have no
// equivalent in useConnectionInfo() (which only exposes the boolean
// connected/nodeResponsive/configuring/userDisconnected flags the server's
// poll response reports) — and it's written from several places outside any
// poll-processing path: checkConnectionStatus's own out-of-band
// GET /api/poll health check, handleRebootDevice/handleConfigChangeTriggeringReboot/
// handleRebootModalClose, handleDisconnect/handleReconnect (all in App.tsx),
// and FirmwareUpdateSection's OTA-update flow. Deleting it would require
// inventing a new state-machine hook and touching every one of those call
// sites plus ~10 prop consumers (AppHeader, NodesTab, MessagesTab,
// ChannelsTab, NodePopup, InfoTab, useNotificationNavigationHandler) for a
// behavior change, not a mechanical dedupe — out of scope for this PR.
interface DataContextType {
  connectionStatus: ConnectionStatus;
  setConnectionStatus: React.Dispatch<React.SetStateAction<ConnectionStatus>>;
  deviceInfo: any;
  setDeviceInfo: React.Dispatch<React.SetStateAction<any>>;
  deviceConfig: any;
  setDeviceConfig: React.Dispatch<React.SetStateAction<any>>;
  currentNodeId: string;
  setCurrentNodeId: React.Dispatch<React.SetStateAction<string>>;
  nodeAddress: string;
  setNodeAddress: React.Dispatch<React.SetStateAction<string>>;
}

const DataContext = createContext<DataContextType | undefined>(undefined);

interface DataProviderProps {
  children: ReactNode;
}

export const DataProvider: React.FC<DataProviderProps> = ({ children }) => {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [deviceInfo, setDeviceInfo] = useState<any>(null);
  const [deviceConfig, setDeviceConfig] = useState<any>(null);
  const [currentNodeId, setCurrentNodeId] = useState<string>('');
  // Starts empty (not a 'Loading...' placeholder): the connection-status string
  // interpolates nodeAddress, and the literal 'Loading...' must never leak into
  // "Connecting to …" before the real per-source address is resolved (#3611).
  const [nodeAddress, setNodeAddress] = useState<string>('');

  const value = useMemo<DataContextType>(() => ({
    connectionStatus,
    setConnectionStatus,
    deviceInfo,
    setDeviceInfo,
    deviceConfig,
    setDeviceConfig,
    currentNodeId,
    setCurrentNodeId,
    nodeAddress,
    setNodeAddress,
  }), [
    connectionStatus, setConnectionStatus,
    deviceInfo, setDeviceInfo,
    deviceConfig, setDeviceConfig,
    currentNodeId, setCurrentNodeId,
    nodeAddress, setNodeAddress,
  ]);

  return (
    <DataContext.Provider value={value}>
      {children}
    </DataContext.Provider>
  );
};

export const useData = () => {
  const context = useContext(DataContext);
  if (context === undefined) {
    throw new Error('useData must be used within a DataProvider');
  }
  return context;
};
