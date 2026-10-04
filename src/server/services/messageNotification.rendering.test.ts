/**
 * Message notifications are rendered once per recipient, after the filter
 * decision, by each delivery wrapper (#5593).
 *
 * Runs the real web push / Apprise / desktop wrappers and the real filter.
 * Covers: the default shows the source exactly once; a custom template is
 * used; the `[localNodeName]` prefix combines with a custom template; nothing
 * but title/body/type/urls reaches Apprise; keyword filters match the raw
 * message text, never the rendered string.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fixturePrefs,
  subscriptionFor,
  type FixtureState,
} from '../test-helpers/messageNotificationFixture.js';

const h = vi.hoisted(() => {
  process.env.ENABLE_DESKTOP_NOTIFICATIONS = 'true';
  return { state: null as unknown as FixtureState, notify: vi.fn() };
});

vi.mock('../../services/database.js', async () => {
  const { buildDatabaseMock: build, emptyState: empty } = await import('../test-helpers/messageNotificationFixture.js');
  h.state = empty();
  return { default: build(h.state) };
});
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../meshtasticManager.js', () => ({
  fallbackManager: { getLocalNodeInfo: vi.fn(() => ({ longName: 'LocalNode' })), sourceId: 'src-a' },
}));
vi.mock('../sourceManagerRegistry.js', () => ({ sourceManagerRegistry: {} }));
vi.mock('../sourceManagerTypes.js', () => ({ getPrimaryMeshtasticManager: () => undefined }));
vi.mock('node-notifier', () => ({ default: { notify: h.notify } }));

import { pushNotificationService } from './pushNotificationService.js';
import { appriseNotificationService } from './appriseNotificationService.js';
import { desktopNotificationService } from './desktopNotificationService.js';
import type { MessageTemplateContext } from '../../utils/notificationTemplate.js';

const SOURCE = 'src-a';
const SOURCE_NAME = 'Home Base';

const context = (over: Partial<MessageTemplateContext> = {}): MessageTemplateContext => ({
  sourceName: SOURCE_NAME,
  channelName: 'LongFast',
  senderName: 'Alice Mobile',
  senderShortName: 'ALC',
  text: 'meet at the summit',
  serviceLabel: 'Meshtastic',
  isDM: false,
  ...over,
});

const payloadFor = (message: MessageTemplateContext) => ({
  title: 'fallback title',
  body: 'fallback body',
  sourceId: SOURCE,
  sourceName: SOURCE_NAME,
  data: { type: 'channel' as const, sourceId: SOURCE, channelId: 0, messageId: 'm1' },
  message,
});

const filterFor = (message: MessageTemplateContext) => ({
  messageText: message.text,
  channelId: 0,
  isDirectMessage: message.isDM,
  sourceId: SOURCE,
  sourceName: SOURCE_NAME,
});

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

function resetState() {
  h.state.prefs.clear();
  h.state.deniedUsers.clear();
  h.state.subscriptions = [];
  h.state.appriseUsers = [];
  h.state.users = [];
}

describe('message notification rendering in each delivery wrapper (#5593)', () => {
  let pushSend: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    resetState();
    h.notify.mockClear();
    await appriseNotificationService.waitForInit();
    pushSend = vi.spyOn(pushNotificationService, 'sendToSubscription').mockResolvedValue(true);
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ sent_to: 1 }) }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const useUser = (userId: number, prefs = fixturePrefs()) => {
    h.state.prefs.set(`${userId}|${SOURCE}`, prefs);
    h.state.subscriptions.push(subscriptionFor(userId, SOURCE));
    h.state.appriseUsers.push(userId);
    h.state.users.push({ id: userId, isActive: true });
  };

  const appriseBodies = () => fetchMock.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body));

  describe('default template', () => {
    it('web push: one send, source name exactly once, no [source] prefix', async () => {
      useUser(1);
      const result = await pushNotificationService.broadcastWithFiltering(payloadFor(context()), filterFor(context()));

      expect(result).toEqual({ sent: 1, failed: 0, filtered: 0 });
      expect(pushSend).toHaveBeenCalledTimes(1);
      const sent = pushSend.mock.calls[0][1] as { title: string; body: string; message?: unknown; data?: unknown };
      expect(sent.title).toBe('LongFast · Home Base');
      expect(sent.body).toBe('Alice Mobile: meet at the summit');
      expect(occurrences(`${sent.title}\n${sent.body}`, SOURCE_NAME)).toBe(1);
      // The render input never goes on the wire; navigation data still does.
      expect(sent.message).toBeUndefined();
      expect(sent.data).toMatchObject({ type: 'channel', channelId: 0 });
    });

    it('Apprise: one call, source name exactly once, only title/body/type/urls in the request', async () => {
      useUser(1);
      const result = await appriseNotificationService.broadcastWithFiltering(payloadFor(context()), filterFor(context()));

      expect(result).toEqual({ sent: 1, failed: 0, filtered: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [body] = appriseBodies();
      expect(Object.keys(body).sort()).toEqual(['body', 'title', 'type', 'urls']);
      expect(body.title).toBe('LongFast · Home Base');
      expect(body.body).toBe('Alice Mobile: meet at the summit');
      expect(occurrences(`${body.title}\n${body.body}`, SOURCE_NAME)).toBe(1);
    });

    it('desktop: one notification, source name exactly once', async () => {
      useUser(1);
      const result = await desktopNotificationService.broadcastWithFiltering(payloadFor(context()), filterFor(context()));

      expect(result).toEqual({ sent: 1, failed: 0, filtered: 0 });
      expect(h.notify).toHaveBeenCalledTimes(1);
      const sent = h.notify.mock.calls[0][0] as { title: string; message: string };
      expect(sent.title).toBe('LongFast · Home Base');
      expect(sent.message).toBe('Alice Mobile: meet at the summit');
      expect(occurrences(`${sent.title}\n${sent.message}`, SOURCE_NAME)).toBe(1);
    });

    it('a direct message leads with the sender and still shows the source once', async () => {
      useUser(1);
      const dm = context({ isDM: true, channelName: '' });
      await pushNotificationService.broadcastWithFiltering(payloadFor(dm), filterFor(dm));
      const sent = pushSend.mock.calls[0][1] as { title: string; body: string };
      expect(sent.title).toBe('Alice Mobile · Home Base');
      expect(sent.body).toBe('meet at the summit');
      expect(occurrences(`${sent.title}\n${sent.body}`, SOURCE_NAME)).toBe(1);
    });

    it('an anonymous subscription gets the default', async () => {
      h.state.subscriptions.push(subscriptionFor(null, SOURCE));
      await pushNotificationService.broadcastWithFiltering(payloadFor(context()), filterFor(context()));
      expect(pushSend).toHaveBeenCalledTimes(1);
      expect((pushSend.mock.calls[0][1] as { title: string }).title).toBe('LongFast · Home Base');
    });
  });

  describe('custom template', () => {
    const custom = fixturePrefs({
      messageTitleTemplate: '{{ senderShortName }} in {{ channelName }}',
      messageBodyTemplate: '{{ text }}',
    });

    it('each wrapper renders the recipient\'s own template, once', async () => {
      useUser(1, custom);
      await pushNotificationService.broadcastWithFiltering(payloadFor(context()), filterFor(context()));
      await appriseNotificationService.broadcastWithFiltering(payloadFor(context()), filterFor(context()));
      await desktopNotificationService.broadcastWithFiltering(payloadFor(context()), filterFor(context()));

      expect(pushSend).toHaveBeenCalledTimes(1);
      expect(pushSend.mock.calls[0][1]).toMatchObject({ title: 'ALC in LongFast', body: 'meet at the summit' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(appriseBodies()[0]).toMatchObject({ title: 'ALC in LongFast', body: 'meet at the summit' });
      expect(h.notify).toHaveBeenCalledTimes(1);
      expect(h.notify.mock.calls[0][0]).toMatchObject({ title: 'ALC in LongFast', message: 'meet at the summit' });
    });

    it('two recipients of one message each get their own rendering', async () => {
      useUser(1, custom);
      useUser(2);
      await pushNotificationService.broadcastWithFiltering(payloadFor(context()), filterFor(context()));
      const titles = pushSend.mock.calls.map((c) => (c[1] as { title: string }).title);
      expect(titles).toEqual(['ALC in LongFast', 'LongFast · Home Base']);
    });
  });

  describe('[localNodeName] prefix (prefixWithNodeName)', () => {
    it('goes in front of the body, after rendering — default template', async () => {
      useUser(1, fixturePrefs({ prefixWithNodeName: true }));
      await pushNotificationService.broadcastWithFiltering(payloadFor(context()), filterFor(context()));
      await appriseNotificationService.broadcastWithFiltering(payloadFor(context()), filterFor(context()));

      expect(pushSend.mock.calls[0][1]).toMatchObject({
        title: 'LongFast · Home Base',
        body: '[LocalNode] Alice Mobile: meet at the summit',
      });
      expect(appriseBodies()[0]).toMatchObject({
        title: 'LongFast · Home Base',
        body: '[LocalNode] Alice Mobile: meet at the summit',
      });
    });

    it('goes in front of a custom body too, and never into the title', async () => {
      useUser(1, fixturePrefs({
        prefixWithNodeName: true,
        messageTitleTemplate: '{{ sourceName }}',
        messageBodyTemplate: '{{ senderShortName }}: {{ text }}',
      }));
      await pushNotificationService.broadcastWithFiltering(payloadFor(context()), filterFor(context()));
      await appriseNotificationService.broadcastWithFiltering(payloadFor(context()), filterFor(context()));

      for (const sent of [pushSend.mock.calls[0][1] as { title: string; body: string }, appriseBodies()[0]]) {
        expect(sent.title).toBe('Home Base');
        expect(sent.body).toBe('[LocalNode] ALC: meet at the summit');
        expect(occurrences(sent.body, '[LocalNode]')).toBe(1);
      }
    });
  });

  describe('keyword filters match the raw message text, not the rendered string', () => {
    it('a blacklist word that appears only in the rendered string does not filter', async () => {
      // "Home" is in the source name, so it is in the rendered title — but it
      // is not in the message text.
      useUser(1, fixturePrefs({ blacklist: ['Home'] }));
      const result = await pushNotificationService.broadcastWithFiltering(payloadFor(context()), filterFor(context()));
      expect(result).toEqual({ sent: 1, failed: 0, filtered: 0 });
    });

    it('a blacklist word in the text filters even when the template hides the text', async () => {
      useUser(1, fixturePrefs({ blacklist: ['summit'], messageTitleTemplate: 'Mesh', messageBodyTemplate: '{{ senderName }}' }));
      const result = await pushNotificationService.broadcastWithFiltering(payloadFor(context()), filterFor(context()));
      expect(result).toEqual({ sent: 0, failed: 0, filtered: 1 });
      expect(pushSend).not.toHaveBeenCalled();
    });

    it('a whitelist word in the text allows a disabled channel even when the template hides the text', async () => {
      useUser(1, fixturePrefs({
        enabledChannels: [],
        whitelist: ['summit'],
        messageTitleTemplate: 'Mesh',
        messageBodyTemplate: '{{ senderName }}',
      }));
      const result = await pushNotificationService.broadcastWithFiltering(payloadFor(context()), filterFor(context()));
      expect(result).toEqual({ sent: 1, failed: 0, filtered: 0 });
      expect(pushSend.mock.calls[0][1]).toMatchObject({ title: 'Mesh', body: 'Alice Mobile' });
    });

    it('a whitelist word that appears only in a template literal does not allow', async () => {
      useUser(1, fixturePrefs({
        enabledChannels: [],
        whitelist: ['urgent'],
        messageTitleTemplate: 'urgent',
        messageBodyTemplate: 'urgent {{ text }}',
      }));
      const result = await pushNotificationService.broadcastWithFiltering(payloadFor(context()), filterFor(context()));
      expect(result).toEqual({ sent: 0, failed: 0, filtered: 1 });
    });
  });

  describe('a payload with no message context (legacy caller)', () => {
    it('keeps the [source] title prefix, which is its only mention of the source', async () => {
      useUser(1);
      const legacy = { title: 'Something', body: 'happened', sourceId: SOURCE, sourceName: SOURCE_NAME };
      await pushNotificationService.broadcastWithFiltering(legacy, filterFor(context()));
      expect(pushSend.mock.calls[0][1]).toMatchObject({ title: '[Home Base] Something', body: 'happened' });
    });
  });
});
