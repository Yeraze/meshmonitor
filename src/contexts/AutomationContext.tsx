import React, { createContext, useContext, useState, ReactNode } from 'react';
import { AutoResponderTrigger, TimerTrigger, GeofenceTrigger } from '../components/auto-responder/types';

interface AutomationContextType {
  autoAckEnabled: boolean;
  setAutoAckEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoAckRegex: string;
  setAutoAckRegex: React.Dispatch<React.SetStateAction<string>>;
  autoAckMessage: string;
  setAutoAckMessage: React.Dispatch<React.SetStateAction<string>>;
  autoAckMessageDirect: string;
  setAutoAckMessageDirect: React.Dispatch<React.SetStateAction<string>>;
  autoAckChannels: number[];
  setAutoAckChannels: React.Dispatch<React.SetStateAction<number[]>>;
  autoAckDirectMessages: boolean;
  setAutoAckDirectMessages: React.Dispatch<React.SetStateAction<boolean>>;
  autoAckUseDM: boolean;
  setAutoAckUseDM: React.Dispatch<React.SetStateAction<boolean>>;
  autoAckSkipIncompleteNodes: boolean;
  setAutoAckSkipIncompleteNodes: React.Dispatch<React.SetStateAction<boolean>>;
  autoAckTapbackEnabled: boolean;
  setAutoAckTapbackEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoAckReplyEnabled: boolean;
  setAutoAckReplyEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoAckDirectEnabled: boolean;
  setAutoAckDirectEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoAckDirectTapbackEnabled: boolean;
  setAutoAckDirectTapbackEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoAckDirectReplyEnabled: boolean;
  setAutoAckDirectReplyEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoAckMultihopEnabled: boolean;
  setAutoAckMultihopEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoAckMultihopTapbackEnabled: boolean;
  setAutoAckMultihopTapbackEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoAckMultihopReplyEnabled: boolean;
  setAutoAckMultihopReplyEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoAckTestMessages: string;
  setAutoAckTestMessages: React.Dispatch<React.SetStateAction<string>>;
  autoAnnounceEnabled: boolean;
  setAutoAnnounceEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoAnnounceIntervalHours: number;
  setAutoAnnounceIntervalHours: React.Dispatch<React.SetStateAction<number>>;
  autoAnnounceMessage: string;
  setAutoAnnounceMessage: React.Dispatch<React.SetStateAction<string>>;
  autoAnnounceChannelIndexes: number[];
  setAutoAnnounceChannelIndexes: React.Dispatch<React.SetStateAction<number[]>>;
  autoAnnounceOnStart: boolean;
  setAutoAnnounceOnStart: React.Dispatch<React.SetStateAction<boolean>>;
  autoAnnounceUseSchedule: boolean;
  setAutoAnnounceUseSchedule: React.Dispatch<React.SetStateAction<boolean>>;
  autoAnnounceSchedule: string;
  setAutoAnnounceSchedule: React.Dispatch<React.SetStateAction<string>>;
  autoAnnounceNodeInfoEnabled: boolean;
  setAutoAnnounceNodeInfoEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoAnnounceNodeInfoChannels: number[];
  setAutoAnnounceNodeInfoChannels: React.Dispatch<React.SetStateAction<number[]>>;
  autoAnnounceNodeInfoDelaySeconds: number;
  setAutoAnnounceNodeInfoDelaySeconds: React.Dispatch<React.SetStateAction<number>>;
  autoWelcomeEnabled: boolean;
  setAutoWelcomeEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoWelcomeMessage: string;
  setAutoWelcomeMessage: React.Dispatch<React.SetStateAction<string>>;
  autoWelcomeTarget: string;
  setAutoWelcomeTarget: React.Dispatch<React.SetStateAction<string>>;
  autoWelcomeWaitForName: boolean;
  setAutoWelcomeWaitForName: React.Dispatch<React.SetStateAction<boolean>>;
  autoWelcomeMaxHops: number;
  setAutoWelcomeMaxHops: React.Dispatch<React.SetStateAction<number>>;
  autoResponderEnabled: boolean;
  setAutoResponderEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoResponderTriggers: AutoResponderTrigger[];
  setAutoResponderTriggers: React.Dispatch<React.SetStateAction<AutoResponderTrigger[]>>;
  autoResponderSkipIncompleteNodes: boolean;
  setAutoResponderSkipIncompleteNodes: React.Dispatch<React.SetStateAction<boolean>>;
  autoKeyManagementEnabled: boolean;
  setAutoKeyManagementEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoKeyManagementIntervalMinutes: number;
  setAutoKeyManagementIntervalMinutes: React.Dispatch<React.SetStateAction<number>>;
  autoKeyManagementMaxExchanges: number;
  setAutoKeyManagementMaxExchanges: React.Dispatch<React.SetStateAction<number>>;
  autoKeyManagementAutoPurge: boolean;
  setAutoKeyManagementAutoPurge: React.Dispatch<React.SetStateAction<boolean>>;
  timerTriggers: TimerTrigger[];
  setTimerTriggers: React.Dispatch<React.SetStateAction<TimerTrigger[]>>;
  geofenceTriggers: GeofenceTrigger[];
  setGeofenceTriggers: React.Dispatch<React.SetStateAction<GeofenceTrigger[]>>;
}

const AutomationContext = createContext<AutomationContextType | undefined>(undefined);

interface AutomationProviderProps {
  children: ReactNode;
}

export const AutomationProvider: React.FC<AutomationProviderProps> = ({ children }) => {
  // Automation settings - loaded from backend API, not localStorage
  const [autoAckEnabled, setAutoAckEnabled] = useState<boolean>(false);
  const [autoAckRegex, setAutoAckRegex] = useState<string>('^(test|ping)');
  const [autoAckMessage, setAutoAckMessage] = useState<string>('🤖 Copy, {NUMBER_HOPS} hops at {TIME}');
  const [autoAckMessageDirect, setAutoAckMessageDirect] = useState<string>('🤖 Copy, direct connection! SNR: {SNR}dB RSSI: {RSSI}dBm at {TIME}');
  const [autoAckChannels, setAutoAckChannels] = useState<number[]>([]);
  const [autoAckDirectMessages, setAutoAckDirectMessages] = useState<boolean>(false);
  const [autoAckUseDM, setAutoAckUseDM] = useState<boolean>(false);
  const [autoAckSkipIncompleteNodes, setAutoAckSkipIncompleteNodes] = useState<boolean>(false);
  const [autoAckTapbackEnabled, setAutoAckTapbackEnabled] = useState<boolean>(false);
  const [autoAckReplyEnabled, setAutoAckReplyEnabled] = useState<boolean>(true); // Default true for backward compatibility
  const [autoAckDirectEnabled, setAutoAckDirectEnabled] = useState<boolean>(true);
  const [autoAckDirectTapbackEnabled, setAutoAckDirectTapbackEnabled] = useState<boolean>(true);
  const [autoAckDirectReplyEnabled, setAutoAckDirectReplyEnabled] = useState<boolean>(true);
  const [autoAckMultihopEnabled, setAutoAckMultihopEnabled] = useState<boolean>(true);
  const [autoAckMultihopTapbackEnabled, setAutoAckMultihopTapbackEnabled] = useState<boolean>(true);
  const [autoAckMultihopReplyEnabled, setAutoAckMultihopReplyEnabled] = useState<boolean>(true);
  const [autoAckTestMessages, setAutoAckTestMessages] = useState<string>('');
  const [autoAnnounceEnabled, setAutoAnnounceEnabled] = useState<boolean>(false);
  const [autoAnnounceIntervalHours, setAutoAnnounceIntervalHours] = useState<number>(6);
  const [autoAnnounceMessage, setAutoAnnounceMessage] = useState<string>('MeshMonitor {VERSION} online for {DURATION} {FEATURES}');
  const [autoAnnounceChannelIndexes, setAutoAnnounceChannelIndexes] = useState<number[]>([0]);
  const [autoAnnounceOnStart, setAutoAnnounceOnStart] = useState<boolean>(false);
  const [autoAnnounceUseSchedule, setAutoAnnounceUseSchedule] = useState<boolean>(false);
  const [autoAnnounceSchedule, setAutoAnnounceSchedule] = useState<string>('0 */6 * * *');
  const [autoAnnounceNodeInfoEnabled, setAutoAnnounceNodeInfoEnabled] = useState<boolean>(false);
  const [autoAnnounceNodeInfoChannels, setAutoAnnounceNodeInfoChannels] = useState<number[]>([]);
  const [autoAnnounceNodeInfoDelaySeconds, setAutoAnnounceNodeInfoDelaySeconds] = useState<number>(30);
  const [autoWelcomeEnabled, setAutoWelcomeEnabled] = useState<boolean>(false);
  const [autoWelcomeMessage, setAutoWelcomeMessage] = useState<string>('Welcome {LONG_NAME} ({SHORT_NAME}) to the mesh!');
  const [autoWelcomeTarget, setAutoWelcomeTarget] = useState<string>('0');
  const [autoWelcomeWaitForName, setAutoWelcomeWaitForName] = useState<boolean>(true);
  const [autoWelcomeMaxHops, setAutoWelcomeMaxHops] = useState<number>(5);
  const [autoResponderEnabled, setAutoResponderEnabled] = useState<boolean>(false);
  const [autoResponderTriggers, setAutoResponderTriggers] = useState<AutoResponderTrigger[]>([]);
  const [autoResponderSkipIncompleteNodes, setAutoResponderSkipIncompleteNodes] = useState<boolean>(false);
  const [autoKeyManagementEnabled, setAutoKeyManagementEnabled] = useState<boolean>(false);
  const [autoKeyManagementIntervalMinutes, setAutoKeyManagementIntervalMinutes] = useState<number>(5);
  const [autoKeyManagementMaxExchanges, setAutoKeyManagementMaxExchanges] = useState<number>(3);
  const [autoKeyManagementAutoPurge, setAutoKeyManagementAutoPurge] = useState<boolean>(false);
  const [timerTriggers, setTimerTriggers] = useState<TimerTrigger[]>([]);
  const [geofenceTriggers, setGeofenceTriggers] = useState<GeofenceTrigger[]>([]);

  return (
    <AutomationContext.Provider
      value={{
        autoAckEnabled, setAutoAckEnabled,
        autoAckRegex, setAutoAckRegex,
        autoAckMessage, setAutoAckMessage,
        autoAckMessageDirect, setAutoAckMessageDirect,
        autoAckChannels, setAutoAckChannels,
        autoAckDirectMessages, setAutoAckDirectMessages,
        autoAckUseDM, setAutoAckUseDM,
        autoAckSkipIncompleteNodes, setAutoAckSkipIncompleteNodes,
        autoAckTapbackEnabled, setAutoAckTapbackEnabled,
        autoAckReplyEnabled, setAutoAckReplyEnabled,
        autoAckDirectEnabled, setAutoAckDirectEnabled,
        autoAckDirectTapbackEnabled, setAutoAckDirectTapbackEnabled,
        autoAckDirectReplyEnabled, setAutoAckDirectReplyEnabled,
        autoAckMultihopEnabled, setAutoAckMultihopEnabled,
        autoAckMultihopTapbackEnabled, setAutoAckMultihopTapbackEnabled,
        autoAckMultihopReplyEnabled, setAutoAckMultihopReplyEnabled,
        autoAckTestMessages, setAutoAckTestMessages,
        autoAnnounceEnabled, setAutoAnnounceEnabled,
        autoAnnounceIntervalHours, setAutoAnnounceIntervalHours,
        autoAnnounceMessage, setAutoAnnounceMessage,
        autoAnnounceChannelIndexes, setAutoAnnounceChannelIndexes,
        autoAnnounceOnStart, setAutoAnnounceOnStart,
        autoAnnounceUseSchedule, setAutoAnnounceUseSchedule,
        autoAnnounceSchedule, setAutoAnnounceSchedule,
        autoAnnounceNodeInfoEnabled, setAutoAnnounceNodeInfoEnabled,
        autoAnnounceNodeInfoChannels, setAutoAnnounceNodeInfoChannels,
        autoAnnounceNodeInfoDelaySeconds, setAutoAnnounceNodeInfoDelaySeconds,
        autoWelcomeEnabled, setAutoWelcomeEnabled,
        autoWelcomeMessage, setAutoWelcomeMessage,
        autoWelcomeTarget, setAutoWelcomeTarget,
        autoWelcomeWaitForName, setAutoWelcomeWaitForName,
        autoWelcomeMaxHops, setAutoWelcomeMaxHops,
        autoResponderEnabled, setAutoResponderEnabled,
        autoResponderTriggers, setAutoResponderTriggers,
        autoResponderSkipIncompleteNodes, setAutoResponderSkipIncompleteNodes,
        autoKeyManagementEnabled, setAutoKeyManagementEnabled,
        autoKeyManagementIntervalMinutes, setAutoKeyManagementIntervalMinutes,
        autoKeyManagementMaxExchanges, setAutoKeyManagementMaxExchanges,
        autoKeyManagementAutoPurge, setAutoKeyManagementAutoPurge,
        timerTriggers, setTimerTriggers,
        geofenceTriggers, setGeofenceTriggers,
      }}
    >
      {children}
    </AutomationContext.Provider>
  );
};

export const useAutomation = () => {
  const context = useContext(AutomationContext);
  if (context === undefined) {
    throw new Error('useAutomation must be used within an AutomationProvider');
  }
  return context;
};
