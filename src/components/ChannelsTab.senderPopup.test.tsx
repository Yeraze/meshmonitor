/**
 * @vitest-environment jsdom
 *
 * #5645: in the channel feed the sender's NAME opens the node popup, same as
 * the avatar beside it, and the avatar carries the sender's leading status
 * emoji as a badge.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ChannelsTab from './ChannelsTab';
import type { MeshMessage } from '../types/message';

const mockNodes = vi.hoisted(() => ({ current: [] as unknown[] }));

// ChannelsTab calls useNodes() directly (line 211), which reaches usePoll ->
// useCsrfFetch -> useCsrf and requires a CsrfProvider. The node list is
// irrelevant to reaction rendering (short names arrive via the
// getNodeShortName prop), so stub it rather than standing up the provider tree.
vi.mock('../hooks/useServerData', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useNodes: () => ({ nodes: mockNodes.current, isLoading: false, error: null }),
}));

// ChannelsTab also pulls distanceUnit and channel-mute state from
// SettingsContext. Neither affects reaction rendering.
vi.mock('../contexts/SettingsContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSettings: () => ({ distanceUnit: 'km' }),
  useNotificationMuteSettings: () => ({
    isChannelMuted: () => false,
    muteChannel: async () => {},
    unmuteChannel: async () => {},
  }),
}));

// The default shared mock: it honours `t(key, 'Fallback {{var}}', vars)`, which
// the status label uses.
vi.mock('react-i18next', async (importOriginal) => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    useTranslation: createReactI18nextMock().useTranslation,
  };
});

// jsdom has no ResizeObserver; ChannelsTab constructs one on mount (line 384).
// Stubbed locally rather than in the shared setup file so this PR doesn't
// change the environment for every other test.
beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

const PARENT_PACKET_ID = 5000;

// Message ids are `${sourceId}_${fromNum}_${packetId}` — ChannelsTab matches a
// reaction to its parent via `msg.id.split('_').pop()`, so the trailing segment
// must be the parent's packet id.
const parentMsg: MeshMessage = {
  id: `src1_111_${PARENT_PACKET_ID}`,
  from: '!aaaaaaaa',
  to: '^all',
  fromNodeId: '!aaaaaaaa',
  toNodeId: '^all',
  text: 'anyone around?',
  channel: 0,
  timestamp: new Date('2026-07-21T12:00:00Z'),
};

const reactionMsg: MeshMessage = {
  id: 'src1_222_5001',
  from: '!bbbbbbbb',
  to: '^all',
  fromNodeId: '!bbbbbbbb',
  toNodeId: '^all',
  text: '👍',
  channel: 0,
  timestamp: new Date('2026-07-21T12:00:05Z'),
  replyId: PARENT_PACKET_ID,
  emoji: 1,
};

type ChannelsTabProps = React.ComponentProps<typeof ChannelsTab>;

function makeProps(overrides: Partial<ChannelsTabProps> = {}): ChannelsTabProps {
  const noop = () => {};
  const asyncNoop = async () => {};
  return {
    channels: [{ id: 0, name: 'Primary', psk: '', uplinkEnabled: true, downlinkEnabled: true }],
    channelDatabaseEntries: [],
    channelMessages: { 0: [parentMsg, reactionMsg] },
    messages: [parentMsg, reactionMsg],
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
    getNodeName: (id: string) => (id === '!bbbbbbbb' ? 'Bob Node' : 'Alice Node'),
    getNodeShortName: (id: string) => (id === '!bbbbbbbb' ? 'BOB' : 'ALC'),
    isMqttBridgeMessage: () => false,
    setEmojiPickerMessage: noop,
    channelMessagesContainerRef: { current: null },
    ...overrides,
  } as unknown as ChannelsTabProps;
}

describe('ChannelsTab sender triggers (#5645)', () => {
  it('the sender name is a button that opens the popup for that sender', () => {
    mockNodes.current = [];
    const handleSenderClick = vi.fn();
    render(<ChannelsTab {...makeProps({ handleSenderClick })} />);

    const name = screen.getByRole('button', { name: 'Alice Node' });
    expect(name.tagName).toBe('BUTTON');
    expect(name).toHaveClass('sender-name');

    fireEvent.click(name);
    expect(handleSenderClick).toHaveBeenCalledTimes(1);
    const [nodeId, event] = handleSenderClick.mock.calls[0];
    expect(nodeId).toBe('!aaaaaaaa');
    // The real event goes through: the popup anchors to event.currentTarget.
    expect(event.type).toBe('click');
  });

  it('the avatar opens the same popup by click and by keyboard', () => {
    mockNodes.current = [];
    const handleSenderClick = vi.fn();
    const { container } = render(<ChannelsTab {...makeProps({ handleSenderClick })} />);

    const dot = container.querySelector('.sender-dot') as HTMLElement;
    expect(dot).toHaveAttribute('role', 'button');
    expect(dot).toHaveAttribute('tabindex', '0');
    fireEvent.click(dot);
    fireEvent.keyDown(dot, { key: 'Enter' });
    expect(handleSenderClick).toHaveBeenCalledTimes(2);
    expect(handleSenderClick.mock.calls.every(call => call[0] === '!aaaaaaaa')).toBe(true);
  });

  it('badges the avatar with the leading status emoji, and only then', () => {
    mockNodes.current = [
      { nodeNum: 1, user: { id: '!aaaaaaaa', longName: 'Alice Node', shortName: 'ALC' }, nodeStatus: '📡 Monitoring' },
    ];
    const first = render(<ChannelsTab {...makeProps()} />);
    const badge = screen.getByTestId('sender-avatar-status-badge');
    expect(badge.textContent).toBe('📡');
    expect(badge).toHaveAttribute('aria-label', expect.stringContaining('📡 Monitoring'));
    first.unmount();

    mockNodes.current = [
      { nodeNum: 1, user: { id: '!aaaaaaaa', longName: 'Alice Node', shortName: 'ALC' }, nodeStatus: 'Monitoring' },
    ];
    render(<ChannelsTab {...makeProps()} />);
    expect(screen.queryByTestId('sender-avatar-status-badge')).toBeNull();
  });
});
