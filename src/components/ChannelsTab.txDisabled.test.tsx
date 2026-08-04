/**
 * @vitest-environment jsdom
 *
 * TX-disabled gating (epic #4294 Phase 2, §3.2) — when `txDisabled` is true,
 * every send/request control in the channel send box (message textarea, send
 * button, bell, position, per-message emoji-picker "react" button) renders
 * `disabled` with the shared tooltip copy. Reads (existing reaction chips,
 * message history) stay fully interactive — see the inline comment in
 * ChannelsTab.tsx for why reaction chips are deliberately NOT disabled.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
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

const PARENT_PACKET_ID = 6000;

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
  id: 'src1_222_6001',
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
    onSendBell: asyncNoop,
    onSendPosition: asyncNoop,
    shouldShowData: () => true,
    getNodeName: (id: string) => (id === '!bbbbbbbb' ? 'Bob Node' : 'Alice Node'),
    getNodeShortName: (id: string) => (id === '!bbbbbbbb' ? 'BOB' : 'ALC'),
    isMqttBridgeMessage: () => false,
    setEmojiPickerMessage: noop,
    channelMessagesContainerRef: { current: null },
    ...overrides,
  } as unknown as ChannelsTabProps;
}

describe('ChannelsTab txDisabled gating (#4294 Phase 2)', () => {
  it('disables the message textarea with the shared tooltip when txDisabled', () => {
    render(<ChannelsTab {...makeProps({ txDisabled: true })} />);
    const textarea = document.querySelector('textarea.message-input');
    expect(textarea).not.toBeNull();
    expect(textarea).toBeDisabled();
    expect(textarea?.getAttribute('title')).toBe('tx_disabled.control_tooltip');
  });

  it('disables the send button when txDisabled', () => {
    render(<ChannelsTab {...makeProps({ txDisabled: true })} />);
    const sendBtn = document.querySelector('button.send-btn:not(.channel-action-btn)');
    expect(sendBtn).not.toBeNull();
    expect(sendBtn).toBeDisabled();
  });

  it('disables the bell and position buttons when txDisabled', () => {
    render(<ChannelsTab {...makeProps({ txDisabled: true })} />);
    const actionBtns = document.querySelectorAll('button.send-btn.channel-action-btn');
    expect(actionBtns.length).toBe(2);
    actionBtns.forEach(btn => {
      expect(btn).toBeDisabled();
      expect(btn.getAttribute('title')).toBe('tx_disabled.control_tooltip');
    });
  });

  it('disables the per-message emoji-picker (react) button when txDisabled', () => {
    render(<ChannelsTab {...makeProps({ txDisabled: true })} />);
    const emojiBtn = document.querySelector('button.emoji-picker-button');
    expect(emojiBtn).not.toBeNull();
    expect(emojiBtn).toBeDisabled();
    expect(emojiBtn?.getAttribute('title')).toBe('tx_disabled.control_tooltip');
  });

  it('keeps existing reaction chips clickable (reads remain enabled) when txDisabled', () => {
    const handleSendTapback = vi.fn();
    render(<ChannelsTab {...makeProps({ txDisabled: true, handleSendTapback })} />);
    const chip = document.querySelector('.reaction');
    expect(chip).not.toBeNull();
    // Reaction chips are <span> elements, not buttons — verify no disabled-like
    // gating was added and the tapback click handler is still wired (a re-tap
    // while TX is off is caught by the App.tsx failure-branch toast instead).
    expect(chip?.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(chip as HTMLElement);
    expect(handleSendTapback).toHaveBeenCalledTimes(1);
  });

  it('leaves all controls enabled when txDisabled is false', () => {
    // newMessage must be non-empty, or the send button's independent
    // `!newMessage.trim()` guard would also disable it and mask this assertion.
    render(<ChannelsTab {...makeProps({ txDisabled: false, newMessage: 'hi' })} />);
    const textarea = document.querySelector('textarea.message-input');
    expect(textarea).not.toBeDisabled();
    document.querySelectorAll('button.send-btn').forEach(btn => {
      expect(btn).not.toBeDisabled();
    });
    const emojiBtn = document.querySelector('button.emoji-picker-button');
    expect(emojiBtn).not.toBeDisabled();
  });
});

// #4547 Phase 2 WP5: App.tsx computes one MeshCore-or-Meshtastic tooltip
// string and threads it in as `txDisabledTooltip`. The default-key assertions
// above already prove the omitted-prop (Meshtastic today) case is
// byte-identical; this covers the other direction — the prop, when supplied,
// wins over the default key on every gated control.
describe('ChannelsTab txDisabledTooltip prop (#4547 Phase 2 WP5)', () => {
  const MESHCORE_TOOLTIP = 'meshcore.receive_only.control_tooltip';

  it('uses the supplied tooltip on the message textarea instead of the default key', () => {
    render(<ChannelsTab {...makeProps({ txDisabled: true, txDisabledTooltip: MESHCORE_TOOLTIP })} />);
    const textarea = document.querySelector('textarea.message-input');
    expect(textarea?.getAttribute('title')).toBe(MESHCORE_TOOLTIP);
  });

  it('uses the supplied tooltip on the bell/position buttons and the emoji-picker button', () => {
    render(<ChannelsTab {...makeProps({ txDisabled: true, txDisabledTooltip: MESHCORE_TOOLTIP })} />);
    document.querySelectorAll('button.send-btn.channel-action-btn').forEach(btn => {
      expect(btn.getAttribute('title')).toBe(MESHCORE_TOOLTIP);
    });
    const emojiBtn = document.querySelector('button.emoji-picker-button');
    expect(emojiBtn?.getAttribute('title')).toBe(MESHCORE_TOOLTIP);
  });

  it('falls back to tx_disabled.control_tooltip when the prop is omitted (Meshtastic default, unchanged)', () => {
    render(<ChannelsTab {...makeProps({ txDisabled: true })} />);
    const textarea = document.querySelector('textarea.message-input');
    expect(textarea?.getAttribute('title')).toBe('tx_disabled.control_tooltip');
  });
});
