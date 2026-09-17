/**
 * @vitest-environment jsdom
 *
 * Mobile Channels layout (#5265).
 *
 * The mobile header is a deliberate single nowrap row (#3385): heading +
 * selector + a "⋯" kebab, with the inline actions folded into the kebab. The
 * Beacons button (#5232) was added into that row afterwards and took width
 * from the channel selector until its name truncated.
 *
 * The fix moves Beacons and the two send-actions (alert bell, position) onto
 * their own short row below the header on mobile, which also lets the composer
 * collapse from two rows to one.
 *
 * The invariant worth guarding is NOT "the row exists" — it is that each
 * control is rendered in exactly ONE place at any width. Rendering the buttons
 * in both the header row and the composer and hiding one with CSS would look
 * identical on screen while giving the accessibility tree two elements with
 * the same `aria-label`, and would double-fire anything keyed off them.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
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

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      (opts && typeof opts === 'object' && 'defaultValue' in opts
        ? (opts.defaultValue as string)
        : undefined) ?? key,
  }),
}));

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
    getNodeName: () => 'Alice Node',
    getNodeShortName: () => 'ALC',
    isMqttBridgeMessage: () => false,
    setEmojiPickerMessage: noop,
    channelMessagesContainerRef: { current: null },
    ...overrides,
  } as unknown as ChannelsTabProps;
}

const bells = () => document.querySelectorAll('button[aria-label="Send alert bell"]');
const positions = () => document.querySelectorAll('button[aria-label="Send position"]');
const actionRow = () => document.querySelector('.channels-action-row');
const composer = () => document.querySelector('.message-input-container');

describe('ChannelsTab mobile action row (#5265)', () => {
  it('renders the action row on mobile', () => {
    setViewport(true);
    render(<ChannelsTab {...makeProps()} />);
    expect(actionRow()).not.toBeNull();
  });

  it('does NOT render the action row on desktop', () => {
    // Desktop had room already; nothing moves for anyone who wasn't affected.
    setViewport(false);
    render(<ChannelsTab {...makeProps()} />);
    expect(actionRow()).toBeNull();
  });

  it('renders each send action exactly once on mobile', () => {
    setViewport(true);
    render(<ChannelsTab {...makeProps()} />);
    expect(bells()).toHaveLength(1);
    expect(positions()).toHaveLength(1);
  });

  it('renders each send action exactly once on desktop', () => {
    setViewport(false);
    render(<ChannelsTab {...makeProps()} />);
    expect(bells()).toHaveLength(1);
    expect(positions()).toHaveLength(1);
  });

  it('puts the send actions in the action row on mobile, not the composer', () => {
    setViewport(true);
    render(<ChannelsTab {...makeProps()} />);
    expect(actionRow()!.contains(bells()[0])).toBe(true);
    expect(composer()?.contains(bells()[0])).toBe(false);
  });

  it('leaves the send actions in the composer on desktop', () => {
    setViewport(false);
    render(<ChannelsTab {...makeProps()} />);
    expect(composer()!.contains(bells()[0])).toBe(true);
    expect(composer()!.contains(positions()[0])).toBe(true);
  });

  it('keeps the send button in the composer at both widths', () => {
    // Only the bell and position move. Send stays beside what it sends.
    for (const mobile of [true, false]) {
      setViewport(mobile);
      render(<ChannelsTab {...makeProps()} />);
      const send = document.querySelector('button.send-btn:not(.channel-action-btn)');
      expect(send, `send button missing at mobile=${mobile}`).not.toBeNull();
      expect(composer()!.contains(send!), `send left the composer at mobile=${mobile}`).toBe(true);
      cleanup();
    }
  });

  it('renders the Beacons button exactly once at either width', () => {
    // It moves between the controls row and the action row; two copies would
    // mean two buttons opening the same dialog.
    for (const mobile of [true, false]) {
      setViewport(mobile);
      render(<ChannelsTab {...makeProps()} />);
      const beacons = document.querySelectorAll('[data-testid="beacons-button"]');
      expect(beacons.length, `beacons count at mobile=${mobile}`).toBe(1);
      cleanup();
    }
  });

  it('uses the short placeholder on mobile so it does not clip', () => {
    // The one-row composer leaves the input ~270px wide. The long form wraps
    // to a second line inside a single-line box and renders half-cut; the
    // channel name is already in the selector directly above.
    setViewport(true);
    render(<ChannelsTab {...makeProps()} />);
    const ta = document.querySelector('textarea.message-input') as HTMLTextAreaElement;
    expect(ta.placeholder).toBe('channels.send_placeholder_short');
  });

  it('keeps the full placeholder on desktop', () => {
    setViewport(false);
    render(<ChannelsTab {...makeProps()} />);
    const ta = document.querySelector('textarea.message-input') as HTMLTextAreaElement;
    expect(ta.placeholder).toBe('channels.send_placeholder');
  });

  it('still disables the relocated actions when txDisabled', () => {
    // The move must not lose the TX gating from #4294.
    setViewport(true);
    render(<ChannelsTab {...makeProps({ txDisabled: true })} />);
    expect(bells()[0]).toBeDisabled();
    expect(positions()[0]).toBeDisabled();
  });
});
