/**
 * @vitest-environment jsdom
 *
 * #4660 follow-up: the channel-list unread bell (#4669) only reached the
 * desktop expanded list (`.unread-badge` with a <UiIcon>). The mobile channel
 * picker is a native <select>, which cannot host an SVG icon, so it showed the
 * unread count as bare "(N)" with no bell. This asserts the dropdown's <option>
 * now carries a 🔔 emoji + count for unread channels, and nothing for read ones.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import ChannelsTab from './ChannelsTab';

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
      (opts && typeof opts === 'object' && 'defaultValue' in opts
        ? (opts.defaultValue as string)
        : undefined) ?? key,
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

type ChannelsTabProps = React.ComponentProps<typeof ChannelsTab>;

function makeProps(overrides: Partial<ChannelsTabProps> = {}): ChannelsTabProps {
  const noop = () => {};
  const asyncNoop = async () => {};
  return {
    channels: [
      { id: 0, name: 'Primary', psk: '', uplinkEnabled: true, downlinkEnabled: true },
      { id: 2, name: 'gauntlet', psk: '', uplinkEnabled: false, downlinkEnabled: false },
    ],
    channelDatabaseEntries: [],
    channelMessages: {},
    messages: [],
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
    unreadCounts: { 2: 3 },
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
    onSendBell: asyncNoop,
    onSendPosition: asyncNoop,
    shouldShowData: () => true,
    getNodeName: (id: string) => id,
    getNodeShortName: (id: string) => id,
    isMqttBridgeMessage: () => false,
    setEmojiPickerMessage: noop,
    channelMessagesContainerRef: { current: null },
    ...overrides,
  } as unknown as ChannelsTabProps;
}

describe('ChannelsTab mobile channel dropdown unread bell (#4660)', () => {
  it('shows 🔔 + count on an unread channel option and nothing on read ones', () => {
    render(<ChannelsTab {...makeProps()} />);

    const gauntlet = screen.getByRole('option', { name: /gauntlet/ }) as HTMLOptionElement;
    const primary = screen.getByRole('option', { name: /Primary/ }) as HTMLOptionElement;

    expect(gauntlet.textContent).toContain('🔔3');
    expect(primary.textContent).not.toContain('🔔');
  });
});
