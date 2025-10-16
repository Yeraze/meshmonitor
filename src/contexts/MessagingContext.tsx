import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { MeshMessage } from '../types/message';
import { useCsrf } from './CsrfContext';

interface UnreadCounts {
  channels: {[channelId: number]: number};
  directMessages: {[nodeId: string]: number};
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
  unreadCounts: {[key: number]: number};
  setUnreadCounts: React.Dispatch<React.SetStateAction<{[key: number]: number}>>;
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
  const { getToken: getCsrfToken } = useCsrf();
  const [selectedDMNode, setSelectedDMNode] = useState<string>('');
  const [selectedChannel, setSelectedChannel] = useState<number>(-1);
  const [newMessage, setNewMessage] = useState<string>('');
  const [replyingTo, setReplyingTo] = useState<MeshMessage | null>(null);
  const [pendingMessages, setPendingMessages] = useState<Map<string, MeshMessage>>(new Map());
  const [unreadCounts, setUnreadCounts] = useState<{[key: number]: number}>({});
  const [isChannelScrolledToBottom, setIsChannelScrolledToBottom] = useState(true);
  const [isDMScrolledToBottom, setIsDMScrolledToBottom] = useState(true);
  const [unreadCountsData, setUnreadCountsData] = useState<UnreadCounts | null>(null);

  // Fetch unread counts from the server
  const fetchUnreadCounts = useCallback(async (): Promise<UnreadCounts | null> => {
    try {
      const response = await fetch(`${baseUrl}/api/messages/unread-counts`, {
        credentials: 'include',
      });

      if (!response.ok) {
        console.error('Failed to fetch unread counts:', await response.text());
        return null;
      }

      const data = await response.json();
      setUnreadCountsData(data);

      // Also update the legacy unreadCounts state for backward compatibility
      if (data.channels) {
        setUnreadCounts(data.channels);
      }

      return data;
    } catch (error) {
      console.error('Error fetching unread counts:', error);
      return null;
    }
  }, [baseUrl]);

  // Mark messages as read
  const markMessagesAsRead = useCallback(async (
    messageIds?: string[],
    channelId?: number,
    nodeId?: string
  ): Promise<void> => {
    try {
      const body: {
        messageIds?: string[];
        channelId?: number;
        nodeId?: string;
      } = {};

      if (messageIds) {
        body.messageIds = messageIds;
      } else if (channelId !== undefined) {
        body.channelId = channelId;
      } else if (nodeId) {
        body.nodeId = nodeId;
      }

      const headers: HeadersInit = {
        'Content-Type': 'application/json',
      };

      // Add CSRF token for POST request
      const csrfToken = getCsrfToken();
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch(`${baseUrl}/api/messages/mark-read`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        credentials: 'include',
      });

      if (!response.ok) {
        console.error('Failed to mark messages as read:', await response.text());
        return;
      }

      // Refresh unread counts after marking as read
      await fetchUnreadCounts();
    } catch (error) {
      console.error('Error marking messages as read:', error);
    }
  }, [fetchUnreadCounts, baseUrl, getCsrfToken]);

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
        unreadCountsData,
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
