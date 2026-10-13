/**
 * Route tests — POST /messages/:messageId/reaction (#5762).
 *
 * Real-middleware harness (createRouteTestApp); only the source-manager
 * registry is mocked (non-DB). The manager decides each refusal; the route
 * maps it to a status + code through fail().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import {
  MeshCoreReactionError,
  MESHCORE_REACTION_ERROR_STATUS,
  type MeshCoreReactionErrorCode,
} from '../errors/meshcoreReactionError.js';
import { TxDisabledError } from '../errors/txDisabledError.js';

const { reactMock, receiveOnly } = vi.hoisted(() => ({
  reactMock: vi.fn(),
  receiveOnly: { value: false },
}));

vi.mock('../sourceManagerRegistry.js', () => {
  const stubFor = (sourceId: string) => ({
    sourceId,
    sourceType: 'meshcore' as const,
    sendReaction: reactMock,
    isReceiveOnly: () => receiveOnly.value,
    canTransmit: () => !receiveOnly.value,
  });
  const managers = new Map([
    ['rt-source-a', stubFor('rt-source-a')],
    ['rt-source-b', stubFor('rt-source-b')],
  ]);
  return {
    sourceManagerRegistry: {
      getManager: (sourceId: string) => managers.get(sourceId),
      getAllManagers: () => Array.from(managers.values()),
    },
  };
});

const ROW = { id: 'sent-r1', text: '👍', isReaction: true, reactionEmoji: '👍', reactionTargetId: 'm1', mc1Hash: 'secret' };

describe('meshcoreMessagingRoutes — reaction (#5762)', () => {
  let harness: RouteTestHarness;
  const urlFor = (sourceId: string, id = 'm1') =>
    `/sources/${sourceId}/meshcore/messages/${id}/reaction`;

  beforeEach(async () => {
    reactMock.mockReset();
    receiveOnly.value = false;
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('returns 401 when unauthenticated', async () => {
    const agent = await harness.loginAs(null);
    expect((await agent.post(urlFor(harness.sourceA)).send({ emoji: '👍' })).status).toBe(401);
    expect(reactMock).not.toHaveBeenCalled();
  });

  it('refuses messages:read alone', async () => {
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.post(urlFor(harness.sourceA)).send({ emoji: '👍' })).status).toBe(403);
    expect(reactMock).not.toHaveBeenCalled();
  });

  it('needs messages:write on THIS source', async () => {
    reactMock.mockResolvedValue(ROW);
    await harness.grant(harness.limited.id, 'messages', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.post(urlFor(harness.sourceA)).send({ emoji: '👍' })).status).toBe(200);
    expect((await agent.post(urlFor(harness.sourceB)).send({ emoji: '👍' })).status).toBe(403);
    expect(reactMock).toHaveBeenCalledTimes(1);
  });

  it('returns the stored row in the ok() envelope without mc1Hash', async () => {
    reactMock.mockResolvedValue(ROW);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(urlFor(harness.sourceA)).send({ emoji: '👍' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.message).toMatchObject({ id: 'sent-r1', reactionEmoji: '👍' });
    expect(res.body.data.message).not.toHaveProperty('mc1Hash');
    expect(reactMock).toHaveBeenCalledWith('m1', '👍');
  });

  it('refuses with 409 TX_DISABLED on a receive-only source without calling the manager', async () => {
    receiveOnly.value = true;
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(urlFor(harness.sourceA)).send({ emoji: '👍' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TX_DISABLED');
    expect(reactMock).not.toHaveBeenCalled();
  });

  it('maps a TxDisabledError thrown mid-request to 409 TX_DISABLED', async () => {
    reactMock.mockRejectedValue(new TxDisabledError());
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(urlFor(harness.sourceA)).send({ emoji: '👍' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TX_DISABLED');
  });

  it.each(Object.entries(MESHCORE_REACTION_ERROR_STATUS) as Array<[MeshCoreReactionErrorCode, number]>)(
    'maps %s to HTTP %i',
    async (code, status) => {
      reactMock.mockRejectedValue(new MeshCoreReactionError(code, `refused: ${code}`));
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(urlFor(harness.sourceA)).send({ emoji: '👍' });
      expect(res.status).toBe(status);
      expect(res.body).toMatchObject({ success: false, code, error: `refused: ${code}` });
    },
  );

  it('returns existingId on DUPLICATE_REACTION', async () => {
    reactMock.mockRejectedValue(new MeshCoreReactionError('DUPLICATE_REACTION', 'dup', 'sent-old'));
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(urlFor(harness.sourceA)).send({ emoji: '👍' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'DUPLICATE_REACTION', existingId: 'sent-old' });
  });

  it.each([
    ['missing emoji', {}],
    ['non-string emoji', { emoji: 5 }],
    ['empty emoji', { emoji: '' }],
    ['over-long emoji', { emoji: 'x'.repeat(65) }],
  ])('returns 400 INVALID_INPUT for %s', async (_n, body) => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(urlFor(harness.sourceA)).send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(reactMock).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_INPUT for an over-long message id', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(urlFor(harness.sourceA, 'x'.repeat(129))).send({ emoji: '👍' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
  });

  it('returns 500 INTERNAL_ERROR on an unexpected failure', async () => {
    reactMock.mockRejectedValue(new Error('boom'));
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(urlFor(harness.sourceA)).send({ emoji: '👍' });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });
});
