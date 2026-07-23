/**
 * @vitest-environment jsdom
 *
 * #4311 — the long name (`.sender-name`) must stay visually tied to its own
 * message bubble. On touch/no-hover displays `.message-actions` renders in
 * normal document flow, so when it sat between `.sender-name` and
 * `.message-bubble` it pushed the name away from its bubble (the name read as
 * belonging to the previous message). The fix renders `.message-actions` AFTER
 * `.message-bubble`; on hover displays it remains an absolute overlay, so DOM
 * order there is cosmetically irrelevant. This test locks in that DOM order.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render } from '@testing-library/react';
import ChannelsTab from './ChannelsTab';
import type { MeshMessage } from '../types/message';

vi.mock('../hooks/useServerData', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useNodes: () => ({ nodes: [], isLoading: false, error: null }),
}));

vi.mock('../contexts/SettingsContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSettings: () => ({ distanceUnit: 'km' }),
  useNotificationMuteSettings: () => ({
    isChannelMuted: () => false,
    muteChannel: async () => {},
    unmuteChannel: async () => {},
  }),
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      (opts?.defaultValue as string) ?? key,
  }),
}));

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

// Incoming message (from !aaaaaaaa, currentNodeId !cccccccc) so `.sender-name`
// renders, and hasPermission()=true so `.message-actions` renders.
const incoming: MeshMessage = {
  id: 'src1_111_9001',
  from: '!aaaaaaaa',
  to: '^all',
  fromNodeId: '!aaaaaaaa',
  toNodeId: '^all',
  text: 'hello from far away',
  channel: 0,
  timestamp: new Date('2026-07-23T12:00:00Z'),
};

type ChannelsTabProps = React.ComponentProps<typeof ChannelsTab>;

function makeProps(overrides: Partial<ChannelsTabProps> = {}): ChannelsTabProps {
  const noop = () => {};
  const asyncNoop = async () => {};
  return {
    channels: [{ id: 0, name: 'Primary', psk: '', uplinkEnabled: true, downlinkEnabled: true }],
    channelDatabaseEntries: [],
    channelMessages: { 0: [incoming] },
    messages: [incoming],
    currentNodeId: '!cccccccc',
    sourceId: 'src1',
    connectionStatus: 'connected',
    selectedChannel: 0,
    setSelectedChannel: noop,
    selectedChannelRef: { current: 0 },
    showMqttMessages: true,
    setShowMqttMessages: noop,
    newMessage: '',
    setNewMessage: noop,
    replyingTo: null,
    setReplyingTo: noop,
    unreadCounts: {},
    setUnreadCounts: noop,
    markMessagesAsRead: noop,
    channelInfoModal: null,
    setChannelInfoModal: noop,
    showPsk: false,
    setShowPsk: noop,
    timeFormat: '24' as const,
    dateFormat: 'MM/DD/YYYY' as const,
    hasPermission: () => true,
    handleSendMessage: asyncNoop,
    handleResendMessage: asyncNoop,
    handleDeleteMessage: asyncNoop,
    handleSendTapback: noop,
    handlePurgeChannelMessages: asyncNoop,
    handleSenderClick: noop,
    shouldShowData: () => true,
    getNodeName: () => 'Alice Node',
    getNodeShortName: () => 'ALC',
    isMqttBridgeMessage: () => false,
    setEmojiPickerMessage: noop,
    channelMessagesContainerRef: { current: null },
    ...overrides,
  } as unknown as ChannelsTabProps;
}

describe('ChannelsTab message-actions ordering (#4311)', () => {
  it('renders .message-actions AFTER .message-bubble within .message-content', () => {
    render(<ChannelsTab {...makeProps()} />);

    const content = document.querySelector('.message-content');
    expect(content).not.toBeNull();
    const bubble = content!.querySelector('.message-bubble');
    const actions = content!.querySelector('.message-actions');
    expect(bubble).not.toBeNull();
    expect(actions).not.toBeNull();

    // DOCUMENT_POSITION_FOLLOWING (4) means `actions` comes after `bubble`.
    const rel = bubble!.compareDocumentPosition(actions!);
    expect(rel & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps .sender-name immediately adjacent to .message-bubble (nothing wedged between)', () => {
    render(<ChannelsTab {...makeProps()} />);

    const content = document.querySelector('.message-content')!;
    const senderName = content.querySelector('.sender-name');
    expect(senderName).not.toBeNull();
    // The element right after the long name is the bubble itself — not the
    // actions toolbar (the pre-#4311 bug wedged .message-actions in here).
    expect(senderName!.nextElementSibling?.classList.contains('message-bubble')).toBe(true);
  });
});
