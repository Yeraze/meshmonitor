/**
 * Tests for Push Notification Navigation Service Worker Logic
 * 
 * Since the service worker code runs in a different context,
 * these tests validate the data structures and logic patterns used.
 */
import { describe, it, expect } from 'vitest';
// The real implementation the service worker calls — importing it (rather than
// re-deriving the URL inline) is what lets these tests catch a regression.
import {
  buildNotificationUrl,
  type NotificationNavigationData,
} from './utils/notificationUrl';

interface PushNotificationPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  data?: NotificationNavigationData;
}

describe('Push Notification Navigation Data', () => {
  describe('channel navigation data', () => {
    it('should have correct structure for channel message', () => {
      const data: NotificationNavigationData = {
        type: 'channel',
        channelId: 0,
        messageId: 'ch0_123456789',
      };

      expect(data.type).toBe('channel');
      expect(data.channelId).toBe(0);
      expect(data.messageId).toBe('ch0_123456789');
      expect(data.senderNodeId).toBeUndefined();
    });

    it('should handle channel without messageId', () => {
      const data: NotificationNavigationData = {
        type: 'channel',
        channelId: 5,
      };

      expect(data.type).toBe('channel');
      expect(data.channelId).toBe(5);
      expect(data.messageId).toBeUndefined();
    });

    it('should handle primary channel (0)', () => {
      const data: NotificationNavigationData = {
        type: 'channel',
        channelId: 0,
        messageId: 'primary_msg_1',
      };

      expect(data.channelId).toBe(0);
    });

    it('should handle secondary channels (1-7)', () => {
      for (let i = 1; i <= 7; i++) {
        const data: NotificationNavigationData = {
          type: 'channel',
          channelId: i,
          messageId: `ch${i}_msg`,
        };

        expect(data.channelId).toBe(i);
      }
    });
  });

  describe('DM navigation data', () => {
    it('should have correct structure for DM message', () => {
      const data: NotificationNavigationData = {
        type: 'dm',
        messageId: 'dm_987654321',
        senderNodeId: '!abc12345',
      };

      expect(data.type).toBe('dm');
      expect(data.messageId).toBe('dm_987654321');
      expect(data.senderNodeId).toBe('!abc12345');
      expect(data.channelId).toBeUndefined();
    });

    it('should handle DM without messageId', () => {
      const data: NotificationNavigationData = {
        type: 'dm',
        senderNodeId: '!node9876',
      };

      expect(data.type).toBe('dm');
      expect(data.senderNodeId).toBe('!node9876');
      expect(data.messageId).toBeUndefined();
    });

    it('should handle different node ID formats', () => {
      const nodeIds = ['!abc12345', '!DEADBEEF', '!00112233'];

      nodeIds.forEach(nodeId => {
        const data: NotificationNavigationData = {
          type: 'dm',
          senderNodeId: nodeId,
        };

        expect(data.senderNodeId).toBe(nodeId);
      });
    });
  });

  // Regression coverage for #4463: the service worker used to cold-launch the
  // app at `${scope}#notificationNav=...`. The app is path-routed, so the scope
  // root renders DashboardPage — which never mounts the navigation handler, so
  // the deep link was silently dropped on every platform.
  describe('buildNotificationUrl (#4463)', () => {
    const SCOPE = 'https://mesh.example.com/meshmonitor/';

    const decodeNav = (url: string): NotificationNavigationData => {
      const parsed = new URL(url);
      return JSON.parse(parsed.searchParams.get('notificationNav')!);
    };

    it('targets the source-scoped messages route for a DM', () => {
      const data: NotificationNavigationData = {
        type: 'dm',
        sourceId: 'src-a',
        messageId: 'dm_msg_1',
        senderNodeId: '!sender123',
      };

      const url = new URL(buildNotificationUrl(SCOPE, data));

      expect(url.pathname).toBe('/meshmonitor/source/src-a/messages');
      expect(decodeNav(url.href)).toEqual(data);
    });

    it('targets the source-scoped channels route for a channel message', () => {
      const data: NotificationNavigationData = {
        type: 'channel',
        sourceId: 'src-b',
        channelId: 3,
        messageId: 'msg_12345',
      };

      const url = new URL(buildNotificationUrl(SCOPE, data));

      expect(url.pathname).toBe('/meshmonitor/source/src-b/channels');
      expect(decodeNav(url.href)).toEqual(data);
    });

    it('never puts the payload in the hash — the app no longer routes on it', () => {
      const url = new URL(
        buildNotificationUrl(SCOPE, { type: 'dm', sourceId: 'src-a', senderNodeId: '!x' })
      );

      expect(url.hash).toBe('');
      expect(url.searchParams.get('notificationNav')).not.toBeNull();
    });

    it('does not land on the scope root when a sourceId is present', () => {
      const url = buildNotificationUrl(SCOPE, {
        type: 'channel',
        sourceId: 'src-a',
        channelId: 0,
      });

      expect(new URL(url).pathname).not.toBe('/meshmonitor/');
    });

    it('works for a root-mounted deployment (no BASE_URL)', () => {
      const url = new URL(
        buildNotificationUrl('https://mesh.example.com/', {
          type: 'dm',
          sourceId: 'src-a',
          senderNodeId: '!x',
        })
      );

      expect(url.pathname).toBe('/source/src-a/messages');
    });

    it('percent-encodes a sourceId containing URL-significant characters', () => {
      const url = new URL(
        buildNotificationUrl(SCOPE, { type: 'dm', sourceId: 'a/b?c', senderNodeId: '!x' })
      );

      expect(url.pathname).toBe('/meshmonitor/source/a%2Fb%3Fc/messages');
    });

    it('falls back to the scope root but keeps the payload when sourceId is absent', () => {
      // Pre-4.13.4 notifications already delivered to a device carry no sourceId.
      const data: NotificationNavigationData = { type: 'channel', channelId: 1 };

      const url = new URL(buildNotificationUrl(SCOPE, data));

      expect(url.pathname).toBe('/meshmonitor/');
      expect(decodeNav(url.href)).toEqual(data);
    });

    it('returns the bare scope when there is no navigation payload', () => {
      expect(buildNotificationUrl(SCOPE)).toBe(SCOPE);
      expect(buildNotificationUrl(SCOPE, null)).toBe(SCOPE);
    });

    it('round-trips special characters in messageId', () => {
      const data: NotificationNavigationData = {
        type: 'channel',
        sourceId: 'src-a',
        channelId: 1,
        messageId: 'msg_with_special_chars_!@#$%&=?',
      };

      expect(decodeNav(buildNotificationUrl(SCOPE, data)).messageId).toBe(data.messageId);
    });
  });

  describe('URL hash encoding/decoding', () => {
    it('should correctly encode channel navigation to URL hash', () => {
      const data: NotificationNavigationData = {
        type: 'channel',
        channelId: 3,
        messageId: 'msg_12345',
      };

      const params = new URLSearchParams();
      params.set('notificationNav', JSON.stringify(data));
      const hash = params.toString();

      expect(hash).toContain('notificationNav');
      expect(hash).toContain('channel');
    });

    it('should correctly decode channel navigation from URL hash', () => {
      const originalData: NotificationNavigationData = {
        type: 'channel',
        channelId: 5,
        messageId: 'msg_67890',
      };

      const params = new URLSearchParams();
      params.set('notificationNav', JSON.stringify(originalData));
      const hash = params.toString();

      // Decode
      const decodedParams = new URLSearchParams(hash);
      const navDataStr = decodedParams.get('notificationNav');
      const decodedData = JSON.parse(navDataStr!) as NotificationNavigationData;

      expect(decodedData).toEqual(originalData);
    });

    it('should correctly encode DM navigation to URL hash', () => {
      const data: NotificationNavigationData = {
        type: 'dm',
        messageId: 'dm_msg_1',
        senderNodeId: '!sender123',
      };

      const params = new URLSearchParams();
      params.set('notificationNav', JSON.stringify(data));
      const hash = params.toString();

      expect(hash).toContain('notificationNav');
      expect(hash).toContain('dm');
    });

    it('should correctly decode DM navigation from URL hash', () => {
      const originalData: NotificationNavigationData = {
        type: 'dm',
        messageId: 'dm_msg_2',
        senderNodeId: '!sender456',
      };

      const params = new URLSearchParams();
      params.set('notificationNav', JSON.stringify(originalData));
      const hash = params.toString();

      // Decode
      const decodedParams = new URLSearchParams(hash);
      const navDataStr = decodedParams.get('notificationNav');
      const decodedData = JSON.parse(navDataStr!) as NotificationNavigationData;

      expect(decodedData).toEqual(originalData);
    });

    it('should handle special characters in messageId', () => {
      const originalData: NotificationNavigationData = {
        type: 'channel',
        channelId: 1,
        messageId: 'msg_with_special_chars_!@#$%',
      };

      const params = new URLSearchParams();
      params.set('notificationNav', JSON.stringify(originalData));
      const hash = params.toString();

      const decodedParams = new URLSearchParams(hash);
      const navDataStr = decodedParams.get('notificationNav');
      const decodedData = JSON.parse(navDataStr!) as NotificationNavigationData;

      expect(decodedData.messageId).toBe(originalData.messageId);
    });
  });

  describe('push notification payload structure', () => {
    it('should include navigation data in notification payload', () => {
      const payload: PushNotificationPayload = {
        title: 'New Message from Node123',
        body: 'Hello, how are you?',
        icon: '/logo.png',
        badge: '/logo.png',
        data: {
          type: 'dm',
          messageId: 'msg_123',
          senderNodeId: '!node123',
        },
      };

      expect(payload.data).toBeDefined();
      expect(payload.data?.type).toBe('dm');
    });

    it('should serialize payload correctly for web push', () => {
      const payload: PushNotificationPayload = {
        title: 'Channel Message',
        body: 'Test message in channel',
        data: {
          type: 'channel',
          channelId: 0,
          messageId: 'ch0_789',
        },
      };

      const serialized = JSON.stringify(payload);
      const deserialized = JSON.parse(serialized) as PushNotificationPayload;

      expect(deserialized.data).toEqual(payload.data);
    });

    it('should handle payload without navigation data', () => {
      const payload: PushNotificationPayload = {
        title: 'Simple Notification',
        body: 'No navigation data',
      };

      expect(payload.data).toBeUndefined();
    });
  });

  describe('service worker message structure', () => {
    it('should have correct structure for NOTIFICATION_CLICK message', () => {
      const message = {
        type: 'NOTIFICATION_CLICK',
        payload: {
          type: 'channel' as const,
          channelId: 2,
          messageId: 'msg_sw_1',
        },
      };

      expect(message.type).toBe('NOTIFICATION_CLICK');
      expect(message.payload.type).toBe('channel');
      expect(message.payload.channelId).toBe(2);
    });

    it('should correctly identify NOTIFICATION_CLICK messages', () => {
      const validMessage = { type: 'NOTIFICATION_CLICK', payload: { type: 'dm' } };
      const invalidMessage1 = { type: 'OTHER_TYPE', payload: { type: 'dm' } };
      const invalidMessage2 = { type: 'NOTIFICATION_CLICK' }; // Missing payload

      const isValid = (msg: any): boolean => 
        msg?.type === 'NOTIFICATION_CLICK' && !!msg?.payload;

      expect(isValid(validMessage)).toBe(true);
      expect(isValid(invalidMessage1)).toBe(false);
      expect(isValid(invalidMessage2)).toBe(false);
    });
  });
});

describe('Message Highlight Logic', () => {
  describe('data-message-id attribute', () => {
    it('should generate correct selector for message ID', () => {
      const messageId = 'ch0_123456789';
      const selector = `[data-message-id="${messageId}"]`;

      expect(selector).toBe('[data-message-id="ch0_123456789"]');
    });

    it('should handle message IDs with underscores', () => {
      const messageId = 'dm_user_123_456';
      const selector = `[data-message-id="${messageId}"]`;

      expect(selector).toContain(messageId);
    });
  });

  describe('highlight animation timing', () => {
    it('should use 300ms delay before scrolling', () => {
      const SCROLL_DELAY = 300;
      expect(SCROLL_DELAY).toBe(300);
    });

    it('should use 2000ms duration for highlight effect', () => {
      const HIGHLIGHT_DURATION = 2000;
      expect(HIGHLIGHT_DURATION).toBe(2000);
    });
  });
});
