/**
 * Tests for useMessagingView — the messaging state machinery hook extracted
 * from App.tsx (#3962 5.4 PR7): optimistic pendingMessages merge, channel/
 * direct pagination, and the poll-payload merge (applyPollMessages).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { MeshMessage } from '../types/message';
import type { PollData } from './usePoll';

const mockUseSource = vi.fn();
const mockUseData = vi.fn();
const mockUseMessaging = vi.fn();
const mockUseUI = vi.fn();
const mockUseSettings = vi.fn();
const mockUseNotificationMuteSettings = vi.fn();
const mockUseToast = vi.fn();

vi.mock('../contexts/SourceContext', () => ({ useSource: () => mockUseSource() }));
vi.mock('../contexts/DataContext', () => ({ useData: () => mockUseData() }));
vi.mock('../contexts/MessagingContext', () => ({ useMessaging: () => mockUseMessaging() }));
vi.mock('../contexts/UIContext', () => ({ useUI: () => mockUseUI() }));
vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => mockUseSettings(),
  useNotificationMuteSettings: () => mockUseNotificationMuteSettings(),
}));
vi.mock('../components/ToastContainer', () => ({ useToast: () => mockUseToast() }));
vi.mock('../utils/notificationSounds', () => ({
  playSound: vi.fn(),
  playChannelSound: vi.fn(),
  DEFAULT_SOUND_ID: 'default',
}));

const mockGetChannelMessages = vi.fn();
const mockGetDirectMessages = vi.fn();
vi.mock('../services/api', () => ({
  default: {
    getChannelMessages: (...args: unknown[]) => mockGetChannelMessages(...args),
    getDirectMessages: (...args: unknown[]) => mockGetDirectMessages(...args),
  },
}));

import { useMessagingView } from './useMessagingView';

function makeMessage(overrides: Partial<MeshMessage> = {}): MeshMessage {
  return {
    id: '1',
    from: '!aaaaaaaa',
    to: '^all',
    fromNodeId: '!aaaaaaaa',
    toNodeId: '^all',
    channel: 0,
    text: 'hello',
    timestamp: new Date(),
    portnum: 1,
    ...overrides,
  } as MeshMessage;
}

describe('useMessagingView', () => {
  let setSelectedChannel: ReturnType<typeof vi.fn>;
  let setIsChannelScrolledToBottom: ReturnType<typeof vi.fn>;
  let setIsDMScrolledToBottom: ReturnType<typeof vi.fn>;
  let markMessagesAsRead: ReturnType<typeof vi.fn>;
  let setPendingMessages: ReturnType<typeof vi.fn>;
  let setUnreadCounts: ReturnType<typeof vi.fn>;
  let showToast: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    setSelectedChannel = vi.fn();
    setIsChannelScrolledToBottom = vi.fn();
    setIsDMScrolledToBottom = vi.fn();
    markMessagesAsRead = vi.fn().mockResolvedValue(undefined);
    setPendingMessages = vi.fn();
    setUnreadCounts = vi.fn();
    showToast = vi.fn();

    mockUseSource.mockReturnValue({ sourceId: 'src-1', sourceName: 'Test', sourceType: 'meshtastic_tcp' });
    mockUseData.mockReturnValue({ currentNodeId: '!aaaaaaaa' });
    mockUseMessaging.mockReturnValue({
      selectedChannel: 0,
      selectedDMNode: '',
      setSelectedChannel,
      setIsChannelScrolledToBottom,
      setIsDMScrolledToBottom,
      markMessagesAsRead,
      setPendingMessages,
      setUnreadCounts,
      unreadCountsData: { channels: {}, directMessages: {} },
    });
    mockUseUI.mockReturnValue({ activeTab: 'channels' });
    mockUseSettings.mockReturnValue({ enableAudioNotifications: false });
    mockUseNotificationMuteSettings.mockReturnValue({
      isChannelMuted: () => false,
      isDMMuted: () => false,
    });
    mockUseToast.mockReturnValue({ showToast });
  });

  describe('initial state', () => {
    it('starts with empty messages/channelMessages', () => {
      const { result } = renderHook(() => useMessagingView());
      expect(result.current.messages).toEqual([]);
      expect(result.current.channelMessages).toEqual({});
    });

    it('exposes stable container refs and a pendingMessagesRef', () => {
      const { result } = renderHook(() => useMessagingView());
      expect(result.current.channelMessagesContainerRef.current).toBeNull();
      expect(result.current.dmMessagesContainerRef.current).toBeNull();
      expect(result.current.pendingMessagesRef.current).toBeInstanceOf(Map);
      expect(result.current.pendingMessagesRef.current.size).toBe(0);
    });
  });

  describe('applyPollMessages — optimistic-send reconcile', () => {
    it('drops a matched pending (temp_) message and keeps only the server row — no duplicate', () => {
      const { result } = renderHook(() => useMessagingView());

      const now = new Date();
      const pending: MeshMessage = makeMessage({
        id: 'temp_1',
        text: 'hi there',
        from: '!aaaaaaaa',
        fromNodeId: '!aaaaaaaa',
        channel: 0,
        timestamp: now,
      });

      // Seed the pending optimistic message the way handleSendMessage does.
      act(() => {
        result.current.pendingMessagesRef.current = new Map([[pending.id, pending]]);
        result.current.setMessages([pending]);
      });

      const serverRow = makeMessage({
        id: 'server-1',
        text: 'hi there',
        from: '!aaaaaaaa',
        fromNodeId: '!aaaaaaaa',
        channel: 0,
        timestamp: now,
      });

      const pollData: PollData = {
        messages: [serverRow as unknown as Record<string, unknown>],
      } as unknown as PollData;

      act(() => {
        result.current.applyPollMessages(pollData, '!aaaaaaaa', 0);
      });

      // The temp row is gone, the server row is present exactly once.
      const ids = result.current.messages.map(m => m.id);
      expect(ids).toContain('server-1');
      expect(ids).not.toContain('temp_1');
      expect(ids.filter(id => id === 'server-1')).toHaveLength(1);

      // The pending map was reconciled too.
      expect(setPendingMessages).toHaveBeenCalled();
    });

    it('preserves an older message not present in the poll response (pagination survives a poll)', () => {
      const { result } = renderHook(() => useMessagingView());

      const older = makeMessage({ id: 'older-1', text: 'old message' });
      act(() => {
        result.current.setMessages([older]);
      });

      const pollData: PollData = {
        messages: [makeMessage({ id: 'new-1', text: 'new message' }) as unknown as Record<string, unknown>],
      } as unknown as PollData;

      act(() => {
        result.current.applyPollMessages(pollData, '!aaaaaaaa', 0);
      });

      const ids = result.current.messages.map(m => m.id);
      expect(ids).toContain('older-1');
      expect(ids).toContain('new-1');
    });

    it('never reconstructs a message id — ids pass through unchanged', () => {
      const { result } = renderHook(() => useMessagingView());

      const rowId = 'src-1_2882400001_123456789';
      const pollData: PollData = {
        messages: [makeMessage({ id: rowId }) as unknown as Record<string, unknown>],
      } as unknown as PollData;

      act(() => {
        result.current.applyPollMessages(pollData, '!aaaaaaaa', 0);
      });

      expect(result.current.messages.map(m => m.id)).toEqual([rowId]);
    });

    it('zeroes the unread count for the currently-open channel', () => {
      mockUseMessaging.mockReturnValue({
        selectedChannel: 5,
        selectedDMNode: '',
        setSelectedChannel,
        setIsChannelScrolledToBottom,
        setIsDMScrolledToBottom,
        markMessagesAsRead,
        setPendingMessages,
        setUnreadCounts,
        unreadCountsData: { channels: { 5: 3, 6: 2 }, directMessages: {} },
      });

      const { result } = renderHook(() => useMessagingView());

      const pollData: PollData = {
        messages: [makeMessage({ id: 'm1', channel: 5 }) as unknown as Record<string, unknown>],
      } as unknown as PollData;

      act(() => {
        result.current.applyPollMessages(pollData, '!aaaaaaaa', 5);
      });

      expect(setUnreadCounts).toHaveBeenCalledWith({ 5: 0, 6: 2 });
    });

    it('groups channel messages by channel and excludes DM (channel -1) rows', () => {
      const { result } = renderHook(() => useMessagingView());

      const pollData: PollData = {
        messages: [
          makeMessage({ id: 'c1', channel: 1 }) as unknown as Record<string, unknown>,
          makeMessage({ id: 'dm1', channel: -1 }) as unknown as Record<string, unknown>,
        ],
      } as unknown as PollData;

      act(() => {
        result.current.applyPollMessages(pollData, '!aaaaaaaa', -1);
      });

      expect(result.current.channelMessages[1]?.map(m => m.id)).toEqual(['c1']);
      expect(result.current.channelMessages[-1]).toBeUndefined();
    });
  });

  describe('pagination — auto-load-if-no-scrollbar path', () => {
    // loadMoreChannelMessages/loadMoreDirectMessages are hook-internal (App
    // never called them directly either — only the scroll handler and this
    // "no scrollbar" effect did), so exercise them the same way: populate a
    // fake (scrollbar-less) container and let the gated effect fire.
    function fakeContainer(overrides: Partial<HTMLDivElement> = {}) {
      return {
        scrollHeight: 100,
        clientHeight: 500, // no scrollbar: scrollHeight <= clientHeight
        scrollTop: 0,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        ...overrides,
      } as unknown as HTMLDivElement;
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('loadMoreChannelMessages prepends older messages and records hasMore', async () => {
      mockGetChannelMessages.mockResolvedValue({
        messages: [makeMessage({ id: 'old-1', text: 'older', timestamp: new Date(0) })],
        hasMore: true,
      });

      const { result, rerender } = renderHook(() => useMessagingView());

      act(() => {
        result.current.setChannelMessages({ 0: [makeMessage({ id: 'newer-1' })] });
        result.current.channelMessagesContainerRef.current = fakeContainer();
      });

      // Force the "auto-load if no scrollbar" effect (deps include
      // selectedChannel) to re-run now that the container ref is populated.
      mockUseMessaging.mockReturnValue({
        selectedChannel: 0,
        selectedDMNode: '',
        setSelectedChannel,
        setIsChannelScrolledToBottom,
        setIsDMScrolledToBottom,
        markMessagesAsRead,
        setPendingMessages,
        setUnreadCounts,
        unreadCountsData: { channels: {}, directMessages: {} },
      });
      rerender();

      await act(async () => {
        vi.advanceTimersByTime(250);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockGetChannelMessages).toHaveBeenCalledWith(0, 100, 1, 'src-1');
      const ids = result.current.channelMessages[0]?.map(m => m.id) ?? [];
      expect(ids).toEqual(['old-1', 'newer-1']);
    });
  });
});
