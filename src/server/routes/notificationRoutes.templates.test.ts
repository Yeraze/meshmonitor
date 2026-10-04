/**
 * Message-notification templates on POST/GET /push/preferences (#5593).
 *
 * Runs the real session + requireAuth + requirePermission chain and the real
 * notifications repository against the harness DB.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { pushRouter } from './notificationRoutes.js';
import {
  MESSAGE_BODY_TEMPLATE_MAX,
  MESSAGE_TITLE_TEMPLATE_MAX,
} from '../../utils/notificationTemplate.js';

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    getAllManagers: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('../meshtasticManager.js', () => ({
  fallbackManager: { getLocalNodeInfo: vi.fn().mockReturnValue(null) },
}));

describe('/push/preferences — message templates', () => {
  let harness: RouteTestHarness;

  const rowFor = (sourceId: string) =>
    harness.db.notifications.getUserPreferences(harness.limited.id, sourceId);

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: app => app.use('/push', pushRouter) });
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceB);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('GET answers null templates for a user who has saved none', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/push/preferences?sourceId=${harness.sourceA}`);
    expect(res.status).toBe(200);
    expect(res.body.messageTitleTemplate).toBeNull();
    expect(res.body.messageBodyTemplate).toBeNull();
  });

  it('saves both templates and reads them back', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/push/preferences').send({
      sourceId: harness.sourceA,
      messageTitleTemplate: '{{ channelName }}',
      messageBodyTemplate: '{{ senderShortName }}: {{ text }}',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    const read = await agent.get(`/push/preferences?sourceId=${harness.sourceA}`);
    expect(read.body).toMatchObject({
      messageTitleTemplate: '{{ channelName }}',
      messageBodyTemplate: '{{ senderShortName }}: {{ text }}',
    });
  });

  describe('partial save', () => {
    it('a save that omits the templates keeps them', async () => {
      const agent = await harness.loginAs(harness.limited);
      await agent.post('/push/preferences').send({
        sourceId: harness.sourceA,
        messageTitleTemplate: '{{ sourceName }}',
        messageBodyTemplate: '{{ text }}',
      }).expect(200);

      // e.g. a mute set from the Channels view, or an older client.
      await agent.post('/push/preferences').send({
        sourceId: harness.sourceA,
        mutedChannels: [{ channelId: 2, muteUntil: null }],
        enableWebPush: false,
      }).expect(200);

      expect(await rowFor(harness.sourceA)).toMatchObject({
        messageTitleTemplate: '{{ sourceName }}',
        messageBodyTemplate: '{{ text }}',
        mutedChannels: [{ channelId: 2, muteUntil: null }],
        enableWebPush: false,
      });
    });

    it('a template save keeps every other setting and the mute lists', async () => {
      const agent = await harness.loginAs(harness.limited);
      await agent.post('/push/preferences').send({
        sourceId: harness.sourceA,
        enableApprise: true,
        appriseUrls: ['mailto://x'],
        blacklist: ['spam'],
        prefixWithNodeName: true,
        mutedDMs: [{ nodeUuid: '!aaaa', muteUntil: null }],
      }).expect(200);

      await agent.post('/push/preferences').send({
        sourceId: harness.sourceA,
        messageBodyTemplate: '{{ text }}',
      }).expect(200);

      expect(await rowFor(harness.sourceA)).toMatchObject({
        enableApprise: true,
        appriseUrls: ['mailto://x'],
        blacklist: ['spam'],
        prefixWithNodeName: true,
        mutedDMs: [{ nodeUuid: '!aaaa', muteUntil: null }],
        messageTitleTemplate: null,
        messageBodyTemplate: '{{ text }}',
      });
    });

    it('saving one template leaves the other as it was', async () => {
      const agent = await harness.loginAs(harness.limited);
      await agent.post('/push/preferences').send({
        sourceId: harness.sourceA,
        messageTitleTemplate: 'T {{ sourceName }}',
        messageBodyTemplate: 'B {{ text }}',
      }).expect(200);
      await agent.post('/push/preferences').send({
        sourceId: harness.sourceA,
        messageTitleTemplate: 'T2',
      }).expect(200);
      expect(await rowFor(harness.sourceA)).toMatchObject({
        messageTitleTemplate: 'T2',
        messageBodyTemplate: 'B {{ text }}',
      });
    });

    it('null and blank both clear a template back to the default', async () => {
      const agent = await harness.loginAs(harness.limited);
      await agent.post('/push/preferences').send({
        sourceId: harness.sourceA,
        messageTitleTemplate: 'T',
        messageBodyTemplate: 'B',
      }).expect(200);
      await agent.post('/push/preferences').send({
        sourceId: harness.sourceA,
        messageTitleTemplate: null,
        messageBodyTemplate: '   ',
      }).expect(200);
      expect(await rowFor(harness.sourceA)).toMatchObject({
        messageTitleTemplate: null,
        messageBodyTemplate: null,
      });
    });
  });

  describe('validation', () => {
    const post = async (body: Record<string, unknown>) => {
      const agent = await harness.loginAs(harness.limited);
      return agent.post('/push/preferences').send({ sourceId: harness.sourceA, ...body });
    };

    it('rejects an unknown token with the fail() envelope and names it', async () => {
      const res = await post({ messageBodyTemplate: '{{ senderName }}: {{ message_body }}' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        success: false,
        code: 'TEMPLATE_UNKNOWN_TOKEN',
        field: 'messageBodyTemplate',
        unknownTokens: ['message_body'],
      });
      expect(res.body.error).toContain('{{ message_body }}');
      // Nothing was written.
      expect(await rowFor(harness.sourceA)).toBeNull();
    });

    it('rejects an Automation Engine token — only the notification tokens are valid here', async () => {
      const res = await post({ messageTitleTemplate: '{{ trigger.text }}' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('TEMPLATE_UNKNOWN_TOKEN');
    });

    it('rejects a template over the length cap', async () => {
      const title = await post({ messageTitleTemplate: 'a'.repeat(MESSAGE_TITLE_TEMPLATE_MAX + 1) });
      expect(title.status).toBe(400);
      expect(title.body).toMatchObject({ success: false, code: 'TEMPLATE_TOO_LONG', field: 'messageTitleTemplate' });

      const body = await post({ messageBodyTemplate: 'a'.repeat(MESSAGE_BODY_TEMPLATE_MAX + 1) });
      expect(body.status).toBe(400);
      expect(body.body).toMatchObject({ success: false, code: 'TEMPLATE_TOO_LONG', field: 'messageBodyTemplate' });
    });

    it('accepts a template exactly at the cap', async () => {
      const res = await post({
        messageTitleTemplate: 'a'.repeat(MESSAGE_TITLE_TEMPLATE_MAX),
        messageBodyTemplate: 'b'.repeat(MESSAGE_BODY_TEMPLATE_MAX),
      });
      expect(res.status).toBe(200);
    });

    it('rejects markup and control characters', async () => {
      const markup = await post({ messageBodyTemplate: '<b>{{ text }}</b>' });
      expect(markup.status).toBe(400);
      expect(markup.body.code).toBe('TEMPLATE_INVALID_CHARACTERS');

      const newlineTitle = await post({ messageTitleTemplate: 'a\nb' });
      expect(newlineTitle.status).toBe(400);
      expect(newlineTitle.body.code).toBe('TEMPLATE_INVALID_CHARACTERS');
    });

    it('rejects a non-string', async () => {
      const res = await post({ messageTitleTemplate: 42 });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'TEMPLATE_NOT_STRING' });
    });

    it('a rejected template does not save the valid fields sent with it', async () => {
      const agent = await harness.loginAs(harness.limited);
      await agent.post('/push/preferences').send({ sourceId: harness.sourceA, enableWebPush: true }).expect(200);
      const res = await agent.post('/push/preferences').send({
        sourceId: harness.sourceA,
        enableWebPush: false,
        messageTitleTemplate: '{{ nope }}',
      });
      expect(res.status).toBe(400);
      expect(await rowFor(harness.sourceA)).toMatchObject({ enableWebPush: true, messageTitleTemplate: null });
    });
  });

  it('requires messages:read on the source being saved', async () => {
    await harness.revokeAll(harness.limited.id);
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/push/preferences').send({
      sourceId: harness.sourceB,
      messageTitleTemplate: 'T',
    });
    expect(res.status).toBe(403);
    expect(await rowFor(harness.sourceB)).toBeNull();
  });
});
