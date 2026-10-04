/**
 * Message-notification templates are per user AND per source (#5593).
 *
 * A template saved for source A must never shape a notification from source
 * B, and one user's template must never shape another user's notification.
 * Real routes, real repository, real per-recipient renderer against the
 * harness DB.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { pushRouter } from './notificationRoutes.js';
import { renderMessagePayloadForUserAsync } from '../utils/notificationFiltering.js';
import type { MessageTemplateContext } from '../../utils/notificationTemplate.js';

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    getAllManagers: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('../meshtasticManager.js', () => ({
  fallbackManager: { getLocalNodeInfo: vi.fn().mockReturnValue(null) },
}));

const message = (sourceName: string): MessageTemplateContext => ({
  sourceName,
  channelName: 'LongFast',
  senderName: 'Alice Mobile',
  senderShortName: 'ALC',
  text: 'hello',
  serviceLabel: 'Meshtastic',
  isDM: false,
});

const payload = (sourceName: string) => ({ title: 'fallback', body: 'fallback', message: message(sourceName) });

describe('message templates — per-source and per-user isolation', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: app => app.use('/push', pushRouter) });
    for (const user of [harness.limited, harness.admin]) {
      await harness.grant(user.id, 'messages', 'read', harness.sourceA);
      await harness.grant(user.id, 'messages', 'read', harness.sourceB);
    }
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('a template saved for source A is not returned for source B', async () => {
    const agent = await harness.loginAs(harness.limited);
    await agent.post('/push/preferences').send({
      sourceId: harness.sourceA,
      messageTitleTemplate: 'A-only {{ channelName }}',
      messageBodyTemplate: 'A-only {{ text }}',
    }).expect(200);

    const a = await agent.get(`/push/preferences?sourceId=${harness.sourceA}`);
    expect(a.body.messageTitleTemplate).toBe('A-only {{ channelName }}');

    const b = await agent.get(`/push/preferences?sourceId=${harness.sourceB}`);
    expect(b.body.messageTitleTemplate).toBeNull();
    expect(b.body.messageBodyTemplate).toBeNull();
  });

  it('a notification from source B renders the default while source A renders the custom template', async () => {
    const agent = await harness.loginAs(harness.limited);
    await agent.post('/push/preferences').send({
      sourceId: harness.sourceA,
      messageTitleTemplate: 'A-only {{ channelName }}',
      messageBodyTemplate: 'A-only {{ text }}',
    }).expect(200);

    const fromA = await renderMessagePayloadForUserAsync(harness.limited.id, payload('Source A'), harness.sourceA, 'Source A');
    expect(fromA).toEqual({ title: 'A-only LongFast', body: 'A-only hello' });

    const fromB = await renderMessagePayloadForUserAsync(harness.limited.id, payload('Source B'), harness.sourceB, 'Source B');
    expect(fromB).toEqual({ title: 'LongFast · Source B', body: 'Alice Mobile: hello' });
  });

  it('source B keeps its own template when source A is changed or cleared', async () => {
    const agent = await harness.loginAs(harness.limited);
    await agent.post('/push/preferences').send({ sourceId: harness.sourceA, messageTitleTemplate: 'A1' }).expect(200);
    await agent.post('/push/preferences').send({ sourceId: harness.sourceB, messageTitleTemplate: 'B1' }).expect(200);
    await agent.post('/push/preferences').send({ sourceId: harness.sourceA, messageTitleTemplate: null }).expect(200);

    expect((await harness.db.notifications.getUserPreferences(harness.limited.id, harness.sourceA))?.messageTitleTemplate).toBeNull();
    expect((await harness.db.notifications.getUserPreferences(harness.limited.id, harness.sourceB))?.messageTitleTemplate).toBe('B1');

    const fromB = await renderMessagePayloadForUserAsync(harness.limited.id, payload('Source B'), harness.sourceB, 'Source B');
    expect(fromB.title).toBe('B1');
  });

  it('a first save for source B does not copy source A\'s template', async () => {
    const agent = await harness.loginAs(harness.limited);
    await agent.post('/push/preferences').send({ sourceId: harness.sourceA, messageTitleTemplate: 'A1', messageBodyTemplate: 'A1 body' }).expect(200);
    // An unrelated first save on B (creates B's row from the defaults).
    await agent.post('/push/preferences').send({ sourceId: harness.sourceB, enableWebPush: false }).expect(200);

    expect(await harness.db.notifications.getUserPreferences(harness.limited.id, harness.sourceB)).toMatchObject({
      enableWebPush: false,
      messageTitleTemplate: null,
      messageBodyTemplate: null,
    });
  });

  it('one user\'s template is not used for another user on the same source', async () => {
    const agent = await harness.loginAs(harness.limited);
    await agent.post('/push/preferences').send({ sourceId: harness.sourceA, messageTitleTemplate: 'mine {{ channelName }}' }).expect(200);

    const other = await renderMessagePayloadForUserAsync(harness.admin.id, payload('Source A'), harness.sourceA, 'Source A');
    expect(other.title).toBe('LongFast · Source A');
    const anonymous = await renderMessagePayloadForUserAsync(null, payload('Source A'), harness.sourceA, 'Source A');
    expect(anonymous.title).toBe('LongFast · Source A');
    const mine = await renderMessagePayloadForUserAsync(harness.limited.id, payload('Source A'), harness.sourceA, 'Source A');
    expect(mine.title).toBe('mine LongFast');
  });
});
