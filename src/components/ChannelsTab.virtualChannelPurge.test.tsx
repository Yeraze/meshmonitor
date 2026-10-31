/**
 * @vitest-environment jsdom
 *
 * Regression for issue #6044 (Part B): the Virtual Channel Info modal must
 * offer a "Purge all messages" button, mirroring the radio-slot channel modal.
 *
 * Virtual channels (Channel Database entries) surface at channel number
 * CHANNEL_DB_OFFSET + entry.id in the unified (sourceId === null) view. The
 * purge button must call handlePurgeChannelMessages with that virtual channel
 * number, and must be gated on channel-write permission.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import ChannelsTab from './ChannelsTab';
import type { ChannelDatabaseEntry } from '../services/api';

const CHANNEL_DB_OFFSET = 100;

vi.mock('./LinkPreview', () => ({
  default: () => null,
}));

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
    (opts?.defaultValue as string) ?? (typeof opts === 'string' ? opts : key);
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

const dbEntry: ChannelDatabaseEntry = {
  id: 1,
  name: 'LongFast',
  protocol: 'meshtastic',
  pskLength: 1,
  pskPreview: 'AQ==',
  psk: 'AQ==',
  description: null,
  isEnabled: true,
  enforceNameValidation: false,
  sortOrder: 0,
  decryptedPacketCount: 5,
  lastDecryptedAt: null,
  createdBy: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

type ChannelsTabProps = React.ComponentProps<typeof ChannelsTab>;

function makeProps(overrides: Partial<ChannelsTabProps> = {}): ChannelsTabProps {
  const noop = () => {};
  const asyncNoop = async () => {};
  return {
    channels: [],
    channelDatabaseEntries: [dbEntry],
    channelMessages: {},
    messages: [],
    currentNodeId: '!cccccccc',
    // Unified / cross-source view: virtual channels only surface when sourceId is null.
    sourceId: null,
    connectionStatus: 'connected',
    // Virtual channel 101 = CHANNEL_DB_OFFSET + dbEntry.id (1).
    selectedChannel: CHANNEL_DB_OFFSET + dbEntry.id,
    setSelectedChannel: noop,
    selectedChannelRef: { current: CHANNEL_DB_OFFSET + dbEntry.id },
    showMqttMessages: true,
    setShowMqttMessages: noop,
    replyingTo: null,
    setReplyingTo: noop,
    unreadCounts: {},
    setUnreadCounts: noop,
    markMessagesAsRead: asyncNoop,
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

function openVirtualModal(container: HTMLElement) {
  const infoLink = container.querySelector('.channel-info-link');
  expect(infoLink).not.toBeNull();
  fireEvent.click(infoLink as Element);
}

describe('ChannelsTab virtual channel purge (#6044)', () => {
  it('shows a purge button in the virtual channel modal and purges the virtual channel number', () => {
    const handlePurgeChannelMessages = vi.fn(async () => {});
    const { container } = render(
      <ChannelsTab {...makeProps({ handlePurgeChannelMessages })} />
    );

    openVirtualModal(container);

    const modal = container.querySelector('.channel-info-modal') as HTMLElement;
    expect(modal).not.toBeNull();

    const purgeButton = within(modal).getByRole('button', {
      name: 'channels.purge_all_messages',
    });
    fireEvent.click(purgeButton);

    // CHANNEL_DB_OFFSET (100) + entry id (1) = 101
    expect(handlePurgeChannelMessages).toHaveBeenCalledTimes(1);
    expect(handlePurgeChannelMessages).toHaveBeenCalledWith(101);
  });

  it('hides the purge button without channel-write permission', () => {
    const { container } = render(
      <ChannelsTab {...makeProps({ hasPermission: () => false })} />
    );

    openVirtualModal(container);

    const modal = container.querySelector('.channel-info-modal') as HTMLElement;
    expect(modal).not.toBeNull();
    expect(
      within(modal).queryByRole('button', { name: 'channels.purge_all_messages' })
    ).toBeNull();
  });
});
