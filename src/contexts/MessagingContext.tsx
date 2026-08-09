import React, { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, ReactNode } from 'react';
import { MeshMessage } from '../types/message';
import { useUnreadCounts, useMarkAsRead } from '../hooks/useUnreadCounts';
import { useFirstUnread } from '../hooks/useFirstUnread';
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
  /**
   * Select a DM node for composing and ask the DM view to focus its compose box
   * once it renders (#4325). Used by the node list's "Send Direct Message"
   * button: without the focus request the button lands you on the conversation
   * with an empty, unfocused textarea, so "Send DM" didn't actually let you
   * start typing.
   */
  openDmForCompose: (nodeId: string) => void;
  /** Node whose compose box is waiting to be focused, or null. */
  pendingComposeFocus: string | null;
  /** Consume the focus request — call after focusing (or when it can't be honored). */
  clearComposeFocus: () => void;
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
  /**
   * Oldest-unread timestamp (ms) for the OPEN channel, frozen at the moment it
   * was opened (#4607). `null` when nothing was unread.
   *
   * Pinned rather than live because the read-marking effects
   * (useMessagingView GATED EFFECTS #6/#7) mark a conversation read within a
   * tick of entry — a live value would be gone before the divider rendered.
   */
  pinnedFirstUnreadChannel: number | null;
  /** Same, for the open DM conversation. */
  pinnedFirstUnreadDM: number | null;
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

  // "Send Direct Message" from the node list (#4325). Selecting the node was
  // already enough to open the conversation, but the compose box was left
  // unfocused, so the button dropped you somewhere you still had to click
  // before typing. The DM view honors this request once it has rendered a
  // compose box for the same node, then clears it.
  const [pendingComposeFocus, setPendingComposeFocus] = useState<string | null>(null);

  const openDmForCompose = useCallback((nodeId: string) => {
    // Reuse the draft-safe selection path so the empty draft we want isn't
    // racing the #4183 scoping effect.
    composeConvKeyRef.current = `dm:${nodeId}`;
    setSelectedDMNode(nodeId);
    setNewMessage('');
    setPendingComposeFocus(nodeId);
  }, []);

  const clearComposeFocus = useCallback(() => setPendingComposeFocus(null), []);

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

  // Unread-divider anchors (#4607). Polled on the same cadence as the badge
  // counts, then PINNED per conversation: the read-marking effects clear the
  // unread set within a tick of entry, so the value has to be captured at the
  // transition rather than read live.
  const { data: firstUnreadData } = useFirstUnread({
    baseUrl,
    enabled: isAuthenticated,
    sourceId,
    excludeMqtt: !showMqttMessages,
  });
  const firstUnreadRef = useRef(firstUnreadData);
  firstUnreadRef.current = firstUnreadData;

  const [pinnedFirstUnreadChannel, setPinnedFirstUnreadChannel] = useState<number | null>(null);
  const [pinnedFirstUnreadDM, setPinnedFirstUnreadDM] = useState<number | null>(null);

  // Read through the ref so the pin fires ONLY on a conversation change. With
  // `firstUnreadData` in the deps the 10s poll would re-pin mid-read and the
  // line would jump (or vanish) while the operator was still scrolled to it.
  useEffect(() => {
    if (selectedChannel < 0) {
      setPinnedFirstUnreadChannel(null);
      return;
    }
    setPinnedFirstUnreadChannel(firstUnreadRef.current?.channels?.[selectedChannel] ?? null);
  }, [selectedChannel, sourceId]);

  useEffect(() => {
    if (!selectedDMNode) {
      setPinnedFirstUnreadDM(null);
      return;
    }
    setPinnedFirstUnreadDM(firstUnreadRef.current?.directMessages?.[selectedDMNode] ?? null);
  }, [selectedDMNode, sourceId]);

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
    openDmForCompose,
    pendingComposeFocus,
    clearComposeFocus,
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
    pinnedFirstUnreadChannel,
    pinnedFirstUnreadDM,
  }), [
    selectedDMNode, setSelectedDMNode,
    selectedChannel, setSelectedChannel,
    newMessage, setNewMessage,
    openDmWithDraft,
    openDmForCompose, pendingComposeFocus, clearComposeFocus,
    replyingTo, setReplyingTo,
    pendingMessages, setPendingMessages,
    unreadCounts, setUnreadCounts,
    isChannelScrolledToBottom, setIsChannelScrolledToBottom,
    isDMScrolledToBottom, setIsDMScrolledToBottom,
    markMessagesAsRead,
    fetchUnreadCounts,
    unreadCountsData,
    pinnedFirstUnreadChannel,
    pinnedFirstUnreadDM,
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

/**
 * Unread-divider anchors, safe to call outside a MessagingProvider (#4607).
 *
 * ChannelsTab and MessagesTab are rendered bare by a number of focused unit
 * tests that have no provider. The divider is presentational — "no anchors" is
 * a perfectly good answer — so it must degrade rather than throw, the same way
 * `useSource()` returns a null sourceId outside a SourceProvider.
 */
// eslint-disable-next-line react-refresh/only-export-components -- #4607 this file already exports the useMessaging hook alongside the provider; a second read-only hook follows the same established shape
export const useUnreadDividerAnchors = (): { channel: number | null; dm: number | null } => {
  const context = useContext(MessagingContext);
  return {
    channel: context?.pinnedFirstUnreadChannel ?? null,
    dm: context?.pinnedFirstUnreadDM ?? null,
  };
};
