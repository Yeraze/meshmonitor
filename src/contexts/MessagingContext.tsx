import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { MeshMessage } from '../types/message';
import { useUnreadCounts, useMarkAsRead } from '../hooks/useUnreadCounts';
import { useAuth } from './AuthContext';

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
  markMessagesAsRead: (messageIds?: string[], channelId?: number, nodeId?: string) => Promise<void>;
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

  const [selectedDMNode, setSelectedDMNode] = useState<string>('');
  const [selectedChannel, setSelectedChannel] = useState<number>(-1);
  const [newMessage, setNewMessage] = useState<string>('');
  const [replyingTo, setReplyingTo] = useState<MeshMessage | null>(null);
  const [pendingMessages, setPendingMessages] = useState<Map<string, MeshMessage>>(new Map());
  const [unreadCounts, setUnreadCounts] = useState<{ [key: number]: number }>({});
  const [isChannelScrolledToBottom, setIsChannelScrolledToBottom] = useState(true);
  const [isDMScrolledToBottom, setIsDMScrolledToBottom] = useState(true);

  // Use TanStack Query hooks for unread counts - only enable when authenticated
  const { data: unreadCountsData, refetch: refetchUnreadCounts } = useUnreadCounts({
    baseUrl,
    enabled: isAuthenticated,
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
    async (messageIds?: string[], channelId?: number, nodeId?: string): Promise<void> => {
      try {
        await markAsReadMutation({ messageIds, channelId, nodeId });
        // The mutation automatically invalidates and refetches unread counts
      } catch (error) {
        console.error('Error marking messages as read:', error);
      }
    },
    [markAsReadMutation]
  );

  return (
    <MessagingContext.Provider
      value={{
        selectedDMNode,
        setSelectedDMNode,
        selectedChannel,
        setSelectedChannel,
        newMessage,
        setNewMessage,
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
      }}
    >
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
