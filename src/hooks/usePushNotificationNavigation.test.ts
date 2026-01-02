/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePushNotificationNavigation, NotificationNavigationData } from './usePushNotificationNavigation';

// Mock the logger
vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('usePushNotificationNavigation', () => {
  let originalNavigator: typeof navigator;
  let mockAddEventListener: ReturnType<typeof vi.fn>;
  let mockRemoveEventListener: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Store original navigator
    originalNavigator = global.navigator;

    // Mock service worker event listeners
    mockAddEventListener = vi.fn();
    mockRemoveEventListener = vi.fn();

    // Mock navigator.serviceWorker
    Object.defineProperty(global, 'navigator', {
      value: {
        ...originalNavigator,
        serviceWorker: {
          addEventListener: mockAddEventListener,
          removeEventListener: mockRemoveEventListener,
        },
      },
      writable: true,
      configurable: true,
    });

    // Clear URL hash
    window.history.replaceState(null, '', window.location.pathname);
  });

  afterEach(() => {
    // Restore original navigator
    Object.defineProperty(global, 'navigator', {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should return null pendingNavigation initially', () => {
      const { result } = renderHook(() => usePushNotificationNavigation());

      expect(result.current.pendingNavigation).toBeNull();
    });

    it('should register service worker message listener on mount', () => {
      renderHook(() => usePushNotificationNavigation());

      expect(mockAddEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    });

    it('should unregister service worker message listener on unmount', () => {
      const { unmount } = renderHook(() => usePushNotificationNavigation());

      unmount();

      expect(mockRemoveEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    });
  });

  describe('service worker message handling', () => {
    it('should set pendingNavigation when receiving NOTIFICATION_CLICK message with channel data', async () => {
      const { result } = renderHook(() => usePushNotificationNavigation());

      // Get the message handler that was registered
      const messageHandler = mockAddEventListener.mock.calls.find(
        call => call[0] === 'message'
      )?.[1];

      expect(messageHandler).toBeDefined();

      const navigationData: NotificationNavigationData = {
        type: 'channel',
        channelId: 5,
        messageId: 'msg_123456',
      };

      // Simulate receiving a message from service worker
      act(() => {
        messageHandler({
          data: {
            type: 'NOTIFICATION_CLICK',
            payload: navigationData,
          },
        });
      });

      await waitFor(() => {
        expect(result.current.pendingNavigation).toEqual(navigationData);
      });
    });

    it('should set pendingNavigation when receiving NOTIFICATION_CLICK message with DM data', async () => {
      const { result } = renderHook(() => usePushNotificationNavigation());

      const messageHandler = mockAddEventListener.mock.calls.find(
        call => call[0] === 'message'
      )?.[1];

      const navigationData: NotificationNavigationData = {
        type: 'dm',
        messageId: 'msg_789',
        senderNodeId: '!abc12345',
      };

      act(() => {
        messageHandler({
          data: {
            type: 'NOTIFICATION_CLICK',
            payload: navigationData,
          },
        });
      });

      await waitFor(() => {
        expect(result.current.pendingNavigation).toEqual(navigationData);
      });
    });

    it('should ignore messages without NOTIFICATION_CLICK type', async () => {
      const { result } = renderHook(() => usePushNotificationNavigation());

      const messageHandler = mockAddEventListener.mock.calls.find(
        call => call[0] === 'message'
      )?.[1];

      act(() => {
        messageHandler({
          data: {
            type: 'OTHER_MESSAGE',
            payload: { type: 'channel', channelId: 1 },
          },
        });
      });

      // Should still be null
      expect(result.current.pendingNavigation).toBeNull();
    });

    it('should ignore messages without payload', async () => {
      const { result } = renderHook(() => usePushNotificationNavigation());

      const messageHandler = mockAddEventListener.mock.calls.find(
        call => call[0] === 'message'
      )?.[1];

      act(() => {
        messageHandler({
          data: {
            type: 'NOTIFICATION_CLICK',
          },
        });
      });

      expect(result.current.pendingNavigation).toBeNull();
    });
  });

  describe('URL hash navigation', () => {
    it('should parse navigation data from URL hash via hashchange event', async () => {
      const navigationData: NotificationNavigationData = {
        type: 'channel',
        channelId: 3,
        messageId: 'msg_456',
      };

      // Mount the hook first
      const { result } = renderHook(() => usePushNotificationNavigation());

      // Then set URL hash and trigger hashchange event (simulates notification click while app is open)
      const params = new URLSearchParams();
      params.set('notificationNav', JSON.stringify(navigationData));
      
      act(() => {
        window.history.replaceState(null, '', `${window.location.pathname}#${params.toString()}`);
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });

      await waitFor(() => {
        expect(result.current.pendingNavigation).toEqual(navigationData);
      });

      // Hash should be cleared after reading
      expect(window.location.hash).toBe('');
    });

    it('should parse DM navigation data from URL hash via hashchange event', async () => {
      const navigationData: NotificationNavigationData = {
        type: 'dm',
        senderNodeId: '!node123',
        messageId: 'msg_dm_789',
      };

      // Mount the hook first
      const { result } = renderHook(() => usePushNotificationNavigation());

      // Then set URL hash and trigger hashchange
      const params = new URLSearchParams();
      params.set('notificationNav', JSON.stringify(navigationData));
      
      act(() => {
        window.history.replaceState(null, '', `${window.location.pathname}#${params.toString()}`);
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });

      await waitFor(() => {
        expect(result.current.pendingNavigation).toEqual(navigationData);
      });
    });

    it('should handle invalid JSON in URL hash gracefully', async () => {
      const { result } = renderHook(() => usePushNotificationNavigation());
      
      // Set invalid JSON in hash and trigger hashchange
      act(() => {
        window.history.replaceState(null, '', `${window.location.pathname}#notificationNav=not-valid-json`);
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });

      // Should not crash and pendingNavigation should remain null
      expect(result.current.pendingNavigation).toBeNull();
    });

    it('should ignore empty URL hash', () => {
      window.history.replaceState(null, '', window.location.pathname);

      const { result } = renderHook(() => usePushNotificationNavigation());

      expect(result.current.pendingNavigation).toBeNull();
    });

    it('should ignore URL hash without notificationNav parameter', () => {
      window.history.replaceState(null, '', `${window.location.pathname}#someOtherParam=value`);

      const { result } = renderHook(() => usePushNotificationNavigation());

      expect(result.current.pendingNavigation).toBeNull();
    });
  });

  describe('clearPendingNavigation', () => {
    it('should clear pendingNavigation when called', async () => {
      const { result } = renderHook(() => usePushNotificationNavigation());

      // First, set some navigation data
      const messageHandler = mockAddEventListener.mock.calls.find(
        call => call[0] === 'message'
      )?.[1];

      act(() => {
        messageHandler({
          data: {
            type: 'NOTIFICATION_CLICK',
            payload: { type: 'channel', channelId: 1 },
          },
        });
      });

      await waitFor(() => {
        expect(result.current.pendingNavigation).not.toBeNull();
      });

      // Now clear it
      act(() => {
        result.current.clearPendingNavigation();
      });

      expect(result.current.pendingNavigation).toBeNull();
    });

    it('should be stable across re-renders (memoized)', () => {
      const { result, rerender } = renderHook(() => usePushNotificationNavigation());

      const firstClear = result.current.clearPendingNavigation;

      rerender();

      expect(result.current.clearPendingNavigation).toBe(firstClear);
    });
  });

  describe('hashchange event handling', () => {
    it('should handle hashchange events', async () => {
      const { result } = renderHook(() => usePushNotificationNavigation());

      // Verify initial state is null
      expect(result.current.pendingNavigation).toBeNull();

      const navigationData: NotificationNavigationData = {
        type: 'channel',
        channelId: 7,
        messageId: 'msg_hashchange',
      };

      // Simulate hash change
      const params = new URLSearchParams();
      params.set('notificationNav', JSON.stringify(navigationData));
      
      act(() => {
        window.history.replaceState(null, '', `${window.location.pathname}#${params.toString()}`);
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });

      await waitFor(() => {
        expect(result.current.pendingNavigation).toEqual(navigationData);
      });
    });
  });

  describe('edge cases', () => {
    it('should handle navigation data with only required fields', async () => {
      const { result } = renderHook(() => usePushNotificationNavigation());

      const messageHandler = mockAddEventListener.mock.calls.find(
        call => call[0] === 'message'
      )?.[1];

      // Minimal channel navigation (no messageId)
      act(() => {
        messageHandler({
          data: {
            type: 'NOTIFICATION_CLICK',
            payload: { type: 'channel', channelId: 0 },
          },
        });
      });

      await waitFor(() => {
        expect(result.current.pendingNavigation).toEqual({
          type: 'channel',
          channelId: 0,
        });
      });
    });

    it('should work without service worker support', () => {
      // Remove serviceWorker from navigator
      Object.defineProperty(global, 'navigator', {
        value: {},
        writable: true,
        configurable: true,
      });

      // Should not throw
      const { result } = renderHook(() => usePushNotificationNavigation());

      expect(result.current.pendingNavigation).toBeNull();
      expect(result.current.clearPendingNavigation).toBeDefined();
    });
  });
});
