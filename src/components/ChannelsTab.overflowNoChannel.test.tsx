/**
 * @vitest-environment jsdom
 *
 * Meshtastic Channels overflow ("more") menu with no channel open
 * (#4173 review N2).
 *
 * On a phone, portrait or landscape (844x390), CSS hides the inline
 * "Show MQTT/Bridge Messages" toggle and the "more" menu carries it instead.
 * That menu only rendered once a channel was open, so with no channel (for
 * example while the source is disconnected) the toggle could not be reached.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import ChannelsTab from './ChannelsTab';
import type { MeshMessage } from '../types/message';

// BeaconsPanel returns null without beacon data, so the real component would
// render nothing here and an "exactly one" assertion would pass vacuously —
// it would hold just as well if the panel were mounted twice. Stub it to a
// marker that always renders, so the count means what the test says it means
// (raised in review of #5265).
vi.mock('./beacons/BeaconsPanel', () => ({
  default: () => <button data-testid="beacons-button">Beacons</button>,
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
    (opts && typeof opts === 'object' && 'defaultValue' in opts
      ? (opts.defaultValue as string)
      : undefined) ?? key;
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    useTranslation: createReactI18nextMock(t).useTranslation,
  };
});

/**
 * Drive the width the component's `useIsMobileViewport` reads. jsdom has no
 * layout, so `matchMedia` has to be stubbed — it answers `false` for
 * everything otherwise, and every test would silently take the desktop path.
 */
function setViewport(mobile: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      // Answer ONLY the width query this component reads. Inverting every
      // other query would also drive unrelated hooks in the tree — notably
      // MessageEmojiButton's `pointer: fine` check — and make their behaviour
      // an accident of this stub (raised in review of #5265).
      matches: /max-width:\s*768px/.test(query) ? mobile : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

afterEach(cleanup);

const msg: MeshMessage = {
  id: 'src1_111_6000',
  from: '!aaaaaaaa',
  to: '^all',
  fromNodeId: '!aaaaaaaa',
  toNodeId: '^all',
  text: 'hello',
  channel: 0,
  timestamp: new Date('2026-09-17T12:00:00Z'),
};

type ChannelsTabProps = React.ComponentProps<typeof ChannelsTab>;

function makeProps(overrides: Partial<ChannelsTabProps> = {}): ChannelsTabProps {
  const noop = () => {};
  const asyncNoop = async () => {};
  return {
    channels: [{ id: 0, name: 'Primary', psk: '', uplinkEnabled: true, downlinkEnabled: true }],
    channelDatabaseEntries: [],
    channelMessages: { 0: [msg] },
    messages: [msg],
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
    getNodeName: () => 'Alice Node',
    getNodeShortName: () => 'ALC',
    isMqttBridgeMessage: () => false,
    setEmojiPickerMessage: noop,
    channelMessagesContainerRef: { current: null },
    ...overrides,
  } as unknown as ChannelsTabProps;
}


const kebab = () => document.querySelector('.channel-overflow-btn');

describe('ChannelsTab overflow menu with no channel open (#4173 N2)', () => {
  it('renders the menu with only the MQTT toggle when no data is shown', () => {
    setViewport(true);
    render(<ChannelsTab {...makeProps({ shouldShowData: () => false, selectedChannel: -1 })} />);
    expect(kebab()).not.toBeNull();
    fireEvent.click(kebab()!);
    const items = [...document.querySelectorAll('.channel-overflow-item')].map((b) => b.textContent?.trim());
    expect(items).toEqual(['channels.show_mqtt_messages']);
  });

  it('toggles MQTT messages from the menu with no channel open', () => {
    setViewport(true);
    const setShowMqttMessages = vi.fn();
    render(<ChannelsTab {...makeProps({ selectedChannel: -1, showMqttMessages: false, setShowMqttMessages })} />);
    fireEvent.click(kebab()!);
    const item = [...document.querySelectorAll('.channel-overflow-item')]
      .find((b) => b.textContent?.includes('channels.show_mqtt_messages'));
    fireEvent.click(item!);
    expect(setShowMqttMessages).toHaveBeenCalledWith(true);
  });

  it('keeps the per-channel items when a channel is open', () => {
    setViewport(true);
    render(<ChannelsTab {...makeProps()} />);
    fireEvent.click(kebab()!);
    const text = document.querySelector('.channel-overflow-menu')!.textContent ?? '';
    expect(text).toContain('channels.info_link');
    expect(text).toContain('channels.mark_all_read_button');
    expect(text).toContain('channels.show_mqtt_messages');
  });

  it('renders no menu when there is nothing to put in it (read-only MQTT, no channel)', () => {
    setViewport(true);
    render(<ChannelsTab {...makeProps({ selectedChannel: -1, mqttReadOnly: true })} />);
    expect(kebab()).toBeNull();
  });
});
