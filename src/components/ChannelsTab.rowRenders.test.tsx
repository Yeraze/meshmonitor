/**
 * @vitest-environment jsdom
 *
 * Channel message rows are memoized (perf P3-2). Each poll rebuilds every
 * message from fresh JSON (new objects, new Dates) and App passes new
 * getNodeName/getNodeShortName functions, so before the change a poll redrew
 * every row. A poll that adds one message must now render exactly one row,
 * and a poll that changes nothing must render none.
 *
 * Rows are counted through LinkPreview, which every text row renders once.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import ChannelsTab from './ChannelsTab';
import type { MeshMessage } from '../types/message';

const linkPreviewRenders: string[] = [];
vi.mock('./LinkPreview', () => ({
  default: ({ text }: { text: string }) => {
    linkPreviewRenders.push(text);
    return null;
  },
}));

const testNodes: { current: Array<{ nodeNum: number; user: { id: string; longName: string; shortName: string } }> } = vi.hoisted(() => ({ current: [] }));

vi.mock('../hooks/useServerData', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useNodes: () => ({ nodes: testNodes.current, isLoading: false, error: null }),
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
    (opts?.defaultValue as string) ?? key;
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

// Default fixture for makeProps; each test passes its own list.
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


function msg(n: number, extra: Partial<MeshMessage> = {}): MeshMessage {
  return {
    id: `src1_111_${9000 + n}`,
    from: n % 2 ? '!aaaaaaaa' : '!cccccccc',
    to: '^all',
    fromNodeId: n % 2 ? '!aaaaaaaa' : '!cccccccc',
    toNodeId: '^all',
    text: `message ${n}`,
    channel: 0,
    timestamp: new Date(Date.UTC(2026, 6, 23, 12, 0, n)),
    ...extra,
  };
}

/** What a poll does: same content, all-new objects and Dates. */
function repoll(list: MeshMessage[]): MeshMessage[] {
  return list.map(m => ({ ...m, timestamp: new Date(m.timestamp.getTime()) }));
}

function pollProps(list: MeshMessage[]) {
  return makeProps({
    channelMessages: { 0: list },
    messages: list,
    // App rebuilds these on every render.
    getNodeName: (id: string) => (id === '!aaaaaaaa' ? 'Alice Node' : id),
    getNodeShortName: (id: string) => (id === '!aaaaaaaa' ? 'ALC' : id.slice(-4)),
  });
}

beforeEach(() => {
  linkPreviewRenders.length = 0;
  testNodes.current = [{ nodeNum: 1, user: { id: '!aaaaaaaa', longName: 'Alice Node', shortName: 'ALC' } }];
});

describe('ChannelsTab memoized rows', () => {
  it('a poll that adds one message renders one row', () => {
    const first = [msg(1), msg(2), msg(3), msg(4)];
    const { rerender } = render(<ChannelsTab {...pollProps(first)} />);
    expect(linkPreviewRenders).toHaveLength(4);

    linkPreviewRenders.length = 0;
    testNodes.current = [...testNodes.current.map(n => ({ ...n }))];
    rerender(<ChannelsTab {...pollProps([...repoll(first), msg(5)])} />);
    expect(linkPreviewRenders).toEqual(['message 5']);
  });

  it('a poll that changes nothing renders no row', () => {
    const first = [msg(1), msg(2), msg(3)];
    const { rerender } = render(<ChannelsTab {...pollProps(first)} />);
    linkPreviewRenders.length = 0;
    rerender(<ChannelsTab {...pollProps(repoll(first))} />);
    expect(linkPreviewRenders).toEqual([]);
  });

  it('redraws only the parent row when a tapback arrives', () => {
    const first = [msg(1), msg(2), msg(3)];
    const { rerender } = render(<ChannelsTab {...pollProps(first)} />);
    linkPreviewRenders.length = 0;
    const tapback = msg(4, { text: '👍', emoji: 1, replyId: 9002 });
    rerender(<ChannelsTab {...pollProps([...repoll(first), tapback])} />);
    expect(linkPreviewRenders).toEqual(['message 2']);
    expect(document.querySelector('[data-message-id="src1_111_9002"] .message-reactions')?.textContent).toContain('👍');
  });

  it('redraws rows when a sender is renamed', () => {
    const first = [msg(1), msg(2), msg(3)];
    const { rerender } = render(<ChannelsTab {...pollProps(first)} />);
    linkPreviewRenders.length = 0;
    testNodes.current = [{ nodeNum: 1, user: { id: '!aaaaaaaa', longName: 'Alice Renamed', shortName: 'ALR' } }];
    rerender(<ChannelsTab {...makeProps({
      channelMessages: { 0: repoll(first) },
      messages: repoll(first),
      getNodeName: (id: string) => (id === '!aaaaaaaa' ? 'Alice Renamed' : id),
      getNodeShortName: (id: string) => (id === '!aaaaaaaa' ? 'ALR' : id.slice(-4)),
    })} />);
    expect(linkPreviewRenders.length).toBeGreaterThan(0);
    expect(document.querySelector('[data-message-id="src1_111_9001"] .sender-name')?.textContent).toContain('Alice Renamed');
  });
});
