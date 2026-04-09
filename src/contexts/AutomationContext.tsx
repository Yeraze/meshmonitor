import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { AutoResponderTrigger, TimerTrigger, GeofenceTrigger } from '../components/auto-responder/types';
import { useSource } from './SourceContext';
import { logger } from '../utils/logger';

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
  autoAckIgnoredNodes: string;
  setAutoAckIgnoredNodes: React.Dispatch<React.SetStateAction<string>>;
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
  autoAckCooldownSeconds: number;
  setAutoAckCooldownSeconds: React.Dispatch<React.SetStateAction<number>>;
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
  autoKeyManagementImmediatePurge: boolean;
  setAutoKeyManagementImmediatePurge: React.Dispatch<React.SetStateAction<boolean>>;
  autoDeleteByDistanceEnabled: boolean;
  setAutoDeleteByDistanceEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoDeleteByDistanceIntervalHours: number;
  setAutoDeleteByDistanceIntervalHours: React.Dispatch<React.SetStateAction<number>>;
  autoDeleteByDistanceThresholdKm: number;
  setAutoDeleteByDistanceThresholdKm: React.Dispatch<React.SetStateAction<number>>;
  autoDeleteByDistanceLat: number | null;
  setAutoDeleteByDistanceLat: React.Dispatch<React.SetStateAction<number | null>>;
  autoDeleteByDistanceLon: number | null;
  setAutoDeleteByDistanceLon: React.Dispatch<React.SetStateAction<number | null>>;
  timerTriggers: TimerTrigger[];
  setTimerTriggers: React.Dispatch<React.SetStateAction<TimerTrigger[]>>;
  geofenceTriggers: GeofenceTrigger[];
  setGeofenceTriggers: React.Dispatch<React.SetStateAction<GeofenceTrigger[]>>;
}

const AutomationContext = createContext<AutomationContextType | undefined>(undefined);

interface AutomationProviderProps {
  children: ReactNode;
  baseUrl?: string;
}

export const AutomationProvider: React.FC<AutomationProviderProps> = ({ children, baseUrl = '' }) => {
  const { sourceId } = useSource();

  // Automation settings - loaded from backend API, not localStorage
  const [autoAckEnabled, setAutoAckEnabled] = useState<boolean>(false);
  const [autoAckRegex, setAutoAckRegex] = useState<string>('^(test|ping)');
  const [autoAckMessage, setAutoAckMessage] = useState<string>('🤖 Copy, {NUMBER_HOPS} hops at {TIME}');
  const [autoAckMessageDirect, setAutoAckMessageDirect] = useState<string>('🤖 Copy, direct connection! SNR: {SNR}dB RSSI: {RSSI}dBm at {TIME}');
  const [autoAckChannels, setAutoAckChannels] = useState<number[]>([]);
  const [autoAckDirectMessages, setAutoAckDirectMessages] = useState<boolean>(false);
  const [autoAckUseDM, setAutoAckUseDM] = useState<boolean>(false);
  const [autoAckSkipIncompleteNodes, setAutoAckSkipIncompleteNodes] = useState<boolean>(false);
  const [autoAckIgnoredNodes, setAutoAckIgnoredNodes] = useState<string>('');
  const [autoAckTapbackEnabled, setAutoAckTapbackEnabled] = useState<boolean>(false);
  const [autoAckReplyEnabled, setAutoAckReplyEnabled] = useState<boolean>(true); // Default true for backward compatibility
  const [autoAckDirectEnabled, setAutoAckDirectEnabled] = useState<boolean>(true);
  const [autoAckDirectTapbackEnabled, setAutoAckDirectTapbackEnabled] = useState<boolean>(true);
  const [autoAckDirectReplyEnabled, setAutoAckDirectReplyEnabled] = useState<boolean>(true);
  const [autoAckMultihopEnabled, setAutoAckMultihopEnabled] = useState<boolean>(true);
  const [autoAckMultihopTapbackEnabled, setAutoAckMultihopTapbackEnabled] = useState<boolean>(true);
  const [autoAckMultihopReplyEnabled, setAutoAckMultihopReplyEnabled] = useState<boolean>(true);
  const [autoAckCooldownSeconds, setAutoAckCooldownSeconds] = useState<number>(60);
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
  const [autoKeyManagementImmediatePurge, setAutoKeyManagementImmediatePurge] = useState<boolean>(false);
  const [autoDeleteByDistanceEnabled, setAutoDeleteByDistanceEnabled] = useState<boolean>(false);
  const [autoDeleteByDistanceIntervalHours, setAutoDeleteByDistanceIntervalHours] = useState<number>(24);
  const [autoDeleteByDistanceThresholdKm, setAutoDeleteByDistanceThresholdKm] = useState<number>(100);
  const [autoDeleteByDistanceLat, setAutoDeleteByDistanceLat] = useState<number | null>(null);
  const [autoDeleteByDistanceLon, setAutoDeleteByDistanceLon] = useState<number | null>(null);
  const [timerTriggers, setTimerTriggers] = useState<TimerTrigger[]>([]);
  const [geofenceTriggers, setGeofenceTriggers] = useState<GeofenceTrigger[]>([]);

  // Load automation settings from /api/settings, scoped by current sourceId.
  // Refetches whenever sourceId changes so each source has independent automation config.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const sourceQuery = sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : '';
        const response = await fetch(`${baseUrl}/api/settings${sourceQuery}`, { credentials: 'include' });
        if (!response.ok) return;
        const s = await response.json();
        if (cancelled) return;

        const bool = (k: string) => s[k] === 'true' || s[k] === true;
        const num = (k: string, d: number) => {
          const v = s[k];
          if (v === undefined || v === null || v === '') return d;
          const n = typeof v === 'number' ? v : parseFloat(v);
          return isNaN(n) ? d : n;
        };
        const jsonArr = <T,>(k: string, d: T[]): T[] => {
          if (s[k] === undefined || s[k] === null || s[k] === '') return d;
          const raw = s[k];
          // Try JSON first
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed as T[];
          } catch { /* fall through */ }
          // Fallback: CSV of numbers (legacy format for autoAckChannels)
          if (typeof raw === 'string' && raw.includes(',')) {
            const nums = raw.split(',').map(x => parseInt(x.trim(), 10)).filter(n => !isNaN(n));
            if (nums.length > 0) return nums as unknown as T[];
          }
          // Single number as string
          if (typeof raw === 'string') {
            const n = parseInt(raw.trim(), 10);
            if (!isNaN(n)) return [n] as unknown as T[];
          }
          return d;
        };

        if (s.autoAckEnabled !== undefined) setAutoAckEnabled(bool('autoAckEnabled'));
        if (s.autoAckRegex !== undefined) setAutoAckRegex(s.autoAckRegex);
        if (s.autoAckMessage !== undefined) setAutoAckMessage(s.autoAckMessage);
        if (s.autoAckMessageDirect !== undefined) setAutoAckMessageDirect(s.autoAckMessageDirect);
        if (s.autoAckChannels !== undefined) setAutoAckChannels(jsonArr<number>('autoAckChannels', []));
        if (s.autoAckDirectMessages !== undefined) setAutoAckDirectMessages(bool('autoAckDirectMessages'));
        if (s.autoAckUseDM !== undefined) setAutoAckUseDM(bool('autoAckUseDM'));
        if (s.autoAckSkipIncompleteNodes !== undefined) setAutoAckSkipIncompleteNodes(bool('autoAckSkipIncompleteNodes'));
        if (s.autoAckIgnoredNodes !== undefined) setAutoAckIgnoredNodes(s.autoAckIgnoredNodes);
        if (s.autoAckTapbackEnabled !== undefined) setAutoAckTapbackEnabled(bool('autoAckTapbackEnabled'));
        if (s.autoAckReplyEnabled !== undefined) setAutoAckReplyEnabled(bool('autoAckReplyEnabled'));
        if (s.autoAckDirectEnabled !== undefined) setAutoAckDirectEnabled(bool('autoAckDirectEnabled'));
        if (s.autoAckDirectTapbackEnabled !== undefined) setAutoAckDirectTapbackEnabled(bool('autoAckDirectTapbackEnabled'));
        if (s.autoAckDirectReplyEnabled !== undefined) setAutoAckDirectReplyEnabled(bool('autoAckDirectReplyEnabled'));
        if (s.autoAckMultihopEnabled !== undefined) setAutoAckMultihopEnabled(bool('autoAckMultihopEnabled'));
        if (s.autoAckMultihopTapbackEnabled !== undefined) setAutoAckMultihopTapbackEnabled(bool('autoAckMultihopTapbackEnabled'));
        if (s.autoAckMultihopReplyEnabled !== undefined) setAutoAckMultihopReplyEnabled(bool('autoAckMultihopReplyEnabled'));
        if (s.autoAckCooldownSeconds !== undefined) setAutoAckCooldownSeconds(num('autoAckCooldownSeconds', 60));
        if (s.autoAckTestMessages !== undefined) setAutoAckTestMessages(s.autoAckTestMessages);

        if (s.autoAnnounceEnabled !== undefined) setAutoAnnounceEnabled(bool('autoAnnounceEnabled'));
        if (s.autoAnnounceIntervalHours !== undefined) setAutoAnnounceIntervalHours(num('autoAnnounceIntervalHours', 6));
        if (s.autoAnnounceMessage !== undefined) setAutoAnnounceMessage(s.autoAnnounceMessage);
        if (s.autoAnnounceChannelIndexes !== undefined) setAutoAnnounceChannelIndexes(jsonArr<number>('autoAnnounceChannelIndexes', [0]));
        if (s.autoAnnounceOnStart !== undefined) setAutoAnnounceOnStart(bool('autoAnnounceOnStart'));
        if (s.autoAnnounceUseSchedule !== undefined) setAutoAnnounceUseSchedule(bool('autoAnnounceUseSchedule'));
        if (s.autoAnnounceSchedule !== undefined) setAutoAnnounceSchedule(s.autoAnnounceSchedule);
        if (s.autoAnnounceNodeInfoEnabled !== undefined) setAutoAnnounceNodeInfoEnabled(bool('autoAnnounceNodeInfoEnabled'));
        if (s.autoAnnounceNodeInfoChannels !== undefined) setAutoAnnounceNodeInfoChannels(jsonArr<number>('autoAnnounceNodeInfoChannels', []));
        if (s.autoAnnounceNodeInfoDelaySeconds !== undefined) setAutoAnnounceNodeInfoDelaySeconds(num('autoAnnounceNodeInfoDelaySeconds', 30));

        if (s.autoWelcomeEnabled !== undefined) setAutoWelcomeEnabled(bool('autoWelcomeEnabled'));
        if (s.autoWelcomeMessage !== undefined) setAutoWelcomeMessage(s.autoWelcomeMessage);
        if (s.autoWelcomeTarget !== undefined) setAutoWelcomeTarget(s.autoWelcomeTarget);
        if (s.autoWelcomeWaitForName !== undefined) setAutoWelcomeWaitForName(bool('autoWelcomeWaitForName'));
        if (s.autoWelcomeMaxHops !== undefined) setAutoWelcomeMaxHops(num('autoWelcomeMaxHops', 5));

        if (s.autoResponderEnabled !== undefined) setAutoResponderEnabled(bool('autoResponderEnabled'));
        if (s.autoResponderTriggers !== undefined) setAutoResponderTriggers(jsonArr<AutoResponderTrigger>('autoResponderTriggers', []));
        if (s.autoResponderSkipIncompleteNodes !== undefined) setAutoResponderSkipIncompleteNodes(bool('autoResponderSkipIncompleteNodes'));

        if (s.autoKeyManagementEnabled !== undefined) setAutoKeyManagementEnabled(bool('autoKeyManagementEnabled'));
        if (s.autoKeyManagementIntervalMinutes !== undefined) setAutoKeyManagementIntervalMinutes(num('autoKeyManagementIntervalMinutes', 5));
        if (s.autoKeyManagementMaxExchanges !== undefined) setAutoKeyManagementMaxExchanges(num('autoKeyManagementMaxExchanges', 3));
        if (s.autoKeyManagementAutoPurge !== undefined) setAutoKeyManagementAutoPurge(bool('autoKeyManagementAutoPurge'));
        if (s.autoKeyManagementImmediatePurge !== undefined) setAutoKeyManagementImmediatePurge(bool('autoKeyManagementImmediatePurge'));

        if (s.autoDeleteByDistanceEnabled !== undefined) setAutoDeleteByDistanceEnabled(bool('autoDeleteByDistanceEnabled'));
        if (s.autoDeleteByDistanceIntervalHours !== undefined) setAutoDeleteByDistanceIntervalHours(num('autoDeleteByDistanceIntervalHours', 24));
        if (s.autoDeleteByDistanceThresholdKm !== undefined) setAutoDeleteByDistanceThresholdKm(num('autoDeleteByDistanceThresholdKm', 100));
        if (s.autoDeleteByDistanceLat !== undefined) setAutoDeleteByDistanceLat(s.autoDeleteByDistanceLat ? num('autoDeleteByDistanceLat', 0) : null);
        if (s.autoDeleteByDistanceLon !== undefined) setAutoDeleteByDistanceLon(s.autoDeleteByDistanceLon ? num('autoDeleteByDistanceLon', 0) : null);

        if (s.timerTriggers !== undefined) setTimerTriggers(jsonArr<TimerTrigger>('timerTriggers', []));
        if (s.geofenceTriggers !== undefined) setGeofenceTriggers(jsonArr<GeofenceTrigger>('geofenceTriggers', []));
      } catch (err) {
        logger.error('[AutomationContext] Failed to load settings:', err);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [sourceId, baseUrl]);

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
        autoAckIgnoredNodes, setAutoAckIgnoredNodes,
        autoAckTapbackEnabled, setAutoAckTapbackEnabled,
        autoAckReplyEnabled, setAutoAckReplyEnabled,
        autoAckDirectEnabled, setAutoAckDirectEnabled,
        autoAckDirectTapbackEnabled, setAutoAckDirectTapbackEnabled,
        autoAckDirectReplyEnabled, setAutoAckDirectReplyEnabled,
        autoAckMultihopEnabled, setAutoAckMultihopEnabled,
        autoAckMultihopTapbackEnabled, setAutoAckMultihopTapbackEnabled,
        autoAckMultihopReplyEnabled, setAutoAckMultihopReplyEnabled,
        autoAckCooldownSeconds, setAutoAckCooldownSeconds,
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
        autoKeyManagementImmediatePurge, setAutoKeyManagementImmediatePurge,
        autoDeleteByDistanceEnabled, setAutoDeleteByDistanceEnabled,
        autoDeleteByDistanceIntervalHours, setAutoDeleteByDistanceIntervalHours,
        autoDeleteByDistanceThresholdKm, setAutoDeleteByDistanceThresholdKm,
        autoDeleteByDistanceLat, setAutoDeleteByDistanceLat,
        autoDeleteByDistanceLon, setAutoDeleteByDistanceLon,
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
