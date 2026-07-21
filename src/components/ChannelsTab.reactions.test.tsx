/**
 * @vitest-environment jsdom
 *
 * #4243 — the reacting node's short name must be visible next to the emoji in
 * Channel Messages, not hidden behind a hover-only `title` tooltip (which is
 * unreachable on touch devices and invisible at a glance).
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import ChannelsTab from './ChannelsTab';
import type { MeshMessage } from '../types/message';

// ChannelsTab calls useNodes() directly (line 211), which reaches usePoll ->
// useCsrfFetch -> useCsrf and requires a CsrfProvider. The node list is
// irrelevant to reaction rendering (short names arrive via the
// getNodeShortName prop), so stub it rather than standing up the provider tree.
vi.mock('../hooks/useServerData', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useNodes: () => ({ nodes: [], isLoading: false, error: null }),
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

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      (opts?.defaultValue as string) ?? key,
  }),
}));

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

describe('ChannelsTab reactions (#4243)', () => {
  it("renders the reactor's short name inline beside the emoji", () => {
    render(<ChannelsTab {...makeProps()} />);

    const author = document.querySelector('.reaction__author');
    expect(author).not.toBeNull();
    expect(author?.textContent).toBe('BOB');
  });

  it('keeps the emoji itself rendered alongside the name', () => {
    render(<ChannelsTab {...makeProps()} />);

    const bubble = document.querySelector('.reaction');
    expect(bubble).not.toBeNull();
    // The bubble carries both the emoji and the author label.
    expect(bubble?.textContent).toContain('👍');
    expect(bubble?.textContent).toContain('BOB');
  });

  it('still exposes the name via the title tooltip for hover users', () => {
    render(<ChannelsTab {...makeProps()} />);

    const bubble = document.querySelector('.reaction');
    // The tooltip is preserved; the inline label is additive, not a replacement.
    expect(bubble?.getAttribute('title')).toBeTruthy();
  });

  it('does not render the parent message itself as a reaction bubble', () => {
    render(<ChannelsTab {...makeProps()} />);

    // Exactly one reaction bubble — the tapback. The parent is a normal message.
    expect(document.querySelectorAll('.reaction').length).toBe(1);
    expect(screen.getByText('anyone around?')).toBeTruthy();
  });
});
