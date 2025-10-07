import React, { createContext, useContext, useState, ReactNode } from 'react';
import { MeshMessage } from '../types/message';

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
}

const MessagingContext = createContext<MessagingContextType | undefined>(undefined);

interface MessagingProviderProps {
  children: ReactNode;
}

export const MessagingProvider: React.FC<MessagingProviderProps> = ({ children }) => {
  const [selectedDMNode, setSelectedDMNode] = useState<string>('');
  const [selectedChannel, setSelectedChannel] = useState<number>(-1);
  const [newMessage, setNewMessage] = useState<string>('');
  const [replyingTo, setReplyingTo] = useState<MeshMessage | null>(null);
  const [pendingMessages, setPendingMessages] = useState<Map<string, MeshMessage>>(new Map());
  const [unreadCounts, setUnreadCounts] = useState<{[key: number]: number}>({});
  const [isChannelScrolledToBottom, setIsChannelScrolledToBottom] = useState(true);
  const [isDMScrolledToBottom, setIsDMScrolledToBottom] = useState(true);

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
