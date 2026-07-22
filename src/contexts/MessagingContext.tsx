import React, { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, ReactNode } from 'react';
import { MeshMessage } from '../types/message';
import { useUnreadCounts, useMarkAsRead } from '../hooks/useUnreadCounts';
import { useAuth } from './AuthContext';
import { useSource } from './SourceContext';
import { useUI } from './UIContext';
import { getComposeConversationKey, nextComposeDraftState } from '../utils/composeDraft';

interface UnreadCounts {
  channels: { [channelId: number]: number };
  directMessages: { [nodeId: string]: number };
}

interface MessagingContextType {
  selectedDMNode: string;
  setSelectedDMNode: React.Dispatch<React.SetStateAction<string>>;
  selectedChannel: number;
  setSelectedChannel: React.Dispatch<React.SetStateAction<number>>;
  newMessage: string;
  setNewMessage: React.Dispatch<React.SetStateAction<string>>;
  /** Select a DM node and pre-fill the compose draft atomically (survives the #4183 draft-scoping clear). */
  openDmWithDraft: (nodeId: string, message: string) => void;
  replyingTo: MeshMessage | null;
  setReplyingTo: React.Dispatch<React.SetStateAction<MeshMessage | null>>;
  pendingMessages: Map<string, MeshMessage>;
  setPendingMessages: React.Dispatch<React.SetStateAction<Map<string, MeshMessage>>>;
  unreadCounts: { [key: number]: number };
  setUnreadCounts: React.Dispatch<React.SetStateAction<{ [key: number]: number }>>;
  isChannelScrolledToBottom: boolean;
  setIsChannelScrolledToBottom: React.Dispatch<React.SetStateAction<boolean>>;
  isDMScrolledToBottom: boolean;
  setIsDMScrolledToBottom: React.Dispatch<React.SetStateAction<boolean>>;
  // New read tracking functions
  markMessagesAsRead: (messageIds?: string[], channelId?: number, nodeId?: string, allDMs?: boolean) => Promise<void>;
  fetchUnreadCounts: () => Promise<UnreadCounts | null>;
  unreadCountsData: UnreadCounts | null;
}

const MessagingContext = createContext<MessagingContextType | undefined>(undefined);

interface MessagingProviderProps {
  children: ReactNode;
  baseUrl?: string;
}

export const MessagingProvider: React.FC<MessagingProviderProps> = ({ children, baseUrl = '' }) => {
  const { authStatus } = useAuth();
  const isAuthenticated = authStatus?.authenticated || false;
  // Scope unread counts to the current source so per-source tabs don't show
  // badges for messages other sources received but the current source did not.
  const { sourceId } = useSource();
  const { showMqttMessages, activeTab } = useUI();

  const [selectedDMNode, setSelectedDMNode] = useState<string>('');
  const [selectedChannel, setSelectedChannel] = useState<number>(-1);
  const [newMessage, setNewMessage] = useState<string>('');
  const [replyingTo, setReplyingTo] = useState<MeshMessage | null>(null);
  const [pendingMessages, setPendingMessages] = useState<Map<string, MeshMessage>>(new Map());
  const [unreadCounts, setUnreadCounts] = useState<{ [key: number]: number }>({});
  const [isChannelScrolledToBottom, setIsChannelScrolledToBottom] = useState(true);
  const [isDMScrolledToBottom, setIsDMScrolledToBottom] = useState(true);

  // Scope the compose draft to the active conversation (#4183). The DM and
  // channel compose boxes share this single `newMessage` state, so without
  // this a draft typed in one conversation lingered after switching to another
  // and could be sent to the WRONG conversation (a private DM draft could even
  // be sent to a public channel). Clearing centrally here — keyed on the active
  // compose target — covers every switch site at once: the four UI handlers and
  // the several programmatic setSelectedDMNode/setSelectedChannel call sites.
  // It deliberately does NOT fire on send (send does not change the active
  // conversation), so the existing optimistic post-send clear stays intact.
  const composeConvKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const nextKey = getComposeConversationKey(activeTab, selectedDMNode, selectedChannel);
    const { key, clear } = nextComposeDraftState(composeConvKeyRef.current, nextKey);
    composeConvKeyRef.current = key;
    if (clear) setNewMessage('');
  }, [activeTab, selectedDMNode, selectedChannel]);

  // Open a DM with a pre-filled draft — e.g. SecurityTab's "Send Notification"
  // button. The selection change and the pre-fill land in the same React batch,
  // so the scoping effect above would otherwise see a conversation change and
  // wipe the just-pre-filled draft. Pre-marking the compose-target key makes
  // the effect's transition a same-key no-op, preserving the draft.
  const openDmWithDraft = useCallback((nodeId: string, message: string) => {
    composeConvKeyRef.current = `dm:${nodeId}`;
    setSelectedDMNode(nodeId);
    setNewMessage(message);
  }, []);

  // Use TanStack Query hooks for unread counts - only enable when authenticated.
  // Exclude MQTT messages from the count when the user has opted to hide them,
  // so the sidebar dot and channel badges don't light up for MQTT-only traffic.
  const { data: unreadCountsData, refetch: refetchUnreadCounts } = useUnreadCounts({
    baseUrl,
    enabled: isAuthenticated,
    sourceId,
    excludeMqtt: !showMqttMessages,
  });
  const { mutateAsync: markAsReadMutation } = useMarkAsRead({ baseUrl });

  // Wrapper for backward compatibility - returns the data from the query
  const fetchUnreadCounts = useCallback(async (): Promise<UnreadCounts | null> => {
    const result = await refetchUnreadCounts();
    const data = result.data;

    // Also update the legacy unreadCounts state for backward compatibility
    if (data?.channels) {
      setUnreadCounts(data.channels);
    }

    return data || null;
  }, [refetchUnreadCounts]);

  // Mark messages as read using the mutation hook
  const markMessagesAsRead = useCallback(
    async (messageIds?: string[], channelId?: number, nodeId?: string, allDMs?: boolean): Promise<void> => {
      try {
        await markAsReadMutation({ messageIds, channelId, nodeId, allDMs });
        // The mutation automatically invalidates and refetches unread counts
      } catch (error) {
        console.error('Error marking messages as read:', error);
      }
    },
    [markAsReadMutation]
  );

  const value = useMemo<MessagingContextType>(() => ({
    selectedDMNode,
    setSelectedDMNode,
    selectedChannel,
    setSelectedChannel,
    newMessage,
    setNewMessage,
    openDmWithDraft,
    replyingTo,
    setReplyingTo,
    pendingMessages,
    setPendingMessages,
    unreadCounts,
    setUnreadCounts,
    isChannelScrolledToBottom,
    setIsChannelScrolledToBottom,
    isDMScrolledToBottom,
    setIsDMScrolledToBottom,
    markMessagesAsRead,
    fetchUnreadCounts,
    unreadCountsData: unreadCountsData || null,
  }), [
    selectedDMNode, setSelectedDMNode,
    selectedChannel, setSelectedChannel,
    newMessage, setNewMessage,
    openDmWithDraft,
    replyingTo, setReplyingTo,
    pendingMessages, setPendingMessages,
    unreadCounts, setUnreadCounts,
    isChannelScrolledToBottom, setIsChannelScrolledToBottom,
    isDMScrolledToBottom, setIsDMScrolledToBottom,
    markMessagesAsRead,
    fetchUnreadCounts,
    unreadCountsData,
  ]);

  return (
    <MessagingContext.Provider value={value}>
      {children}
    </MessagingContext.Provider>
  );
};

export const useMessaging = () => {
  const context = useContext(MessagingContext);
  if (context === undefined) {
    throw new Error('useMessaging must be used within a MessagingProvider');
  }
  return context;
};
