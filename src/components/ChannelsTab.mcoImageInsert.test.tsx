/**
 * @vitest-environment jsdom
 *
 * #6586 phase 3: ChannelsTab passes the Meshtastic 200-byte limit to the image dialog.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import ChannelsTab from './ChannelsTab';
import { ComposeDraftContext, createComposeDraftStore } from '../contexts/composeDraftStore';
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

vi.mock('react-i18next', async (importOriginal) => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  const t = (key: string, opts?: Record<string, unknown>) =>
    (opts && typeof opts === 'object' && 'defaultValue' in opts
      ? (opts.defaultValue as string)
      : undefined) ?? key;
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    useTranslation: createReactI18nextMock(t).useTranslation,
  };
});

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});


vi.mock('./McoImage/compose/McoImageComposeDialog', async () => {
  const React = await import('react');
  return {
    default: (p: { limit: number; onChoose(t: string): void }) =>
      React.createElement(
        'div',
        { role: 'dialog', 'data-limit': String(p.limit) },
        React.createElement('button', { onClick: () => p.onChoose('MCOimg-test-payload') }, 'choose-image'),
      ),
  };
});

const PAYLOAD = 'MCOimg-test-payload';
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


describe('ChannelsTab insert image (#6586)', () => {
  it('offers Insert image, passes 200 bytes, and sends exactly the payload', async () => {
    const handleSendMessage = vi.fn(async () => {});
    const store = createComposeDraftStore();
    render(
      <ComposeDraftContext.Provider value={store}>
        <ChannelsTab {...makeProps({ handleSendMessage })} />
      </ComposeDraftContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'messages.insert_menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Insert image|messages.insert_image/ }));
    const dlg = await screen.findByRole('dialog');
    expect(dlg.getAttribute('data-limit')).toBe('200');
    fireEvent.click(screen.getByText('choose-image'));
    expect(store.get()).toBe(PAYLOAD);
    fireEvent.click(document.querySelector('button.send-btn:not(.channel-action-btn)') as HTMLElement);
    expect(handleSendMessage).toHaveBeenCalledTimes(1);
  });

  it('disables the + button while TX is off', () => {
    render(<ChannelsTab {...makeProps({ txDisabled: true })} />);
    expect((screen.getByRole('button', { name: 'messages.insert_menu' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
