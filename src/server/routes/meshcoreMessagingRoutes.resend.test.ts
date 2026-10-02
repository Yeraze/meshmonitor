/**
 * Route tests — POST /messages/:messageId/resend (#5512).
 *
 * Real-middleware harness (createRouteTestApp); only the source-manager
 * registry is mocked (non-DB). The manager decides each refusal; the route
 * maps it to a status + code through fail().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { MeshCoreResendError } from '../errors/meshcoreResendError.js';
import { TxDisabledError } from '../errors/txDisabledError.js';

const { resendMock, receiveOnly } = vi.hoisted(() => ({
  resendMock: vi.fn(),
  receiveOnly: { value: false },
}));

vi.mock('../sourceManagerRegistry.js', () => {
  const stubFor = (sourceId: string) => ({
    sourceId,
    sourceType: 'meshcore' as const,
    resendChannelMessage: resendMock,
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

describe('meshcoreMessagingRoutes — resend (#5512)', () => {
  let harness: RouteTestHarness;
  const urlFor = (sourceId: string, id = 'sent-1') =>
    `/sources/${sourceId}/meshcore/messages/${id}/resend`;

  beforeEach(async () => {
    resendMock.mockReset();
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
    expect((await agent.post(urlFor(harness.sourceA))).status).toBe(401);
    expect(resendMock).not.toHaveBeenCalled();
  });

  it('refuses messages:read alone', async () => {
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.post(urlFor(harness.sourceA))).status).toBe(403);
    expect(resendMock).not.toHaveBeenCalled();
  });

  it('needs messages:write on THIS source', async () => {
    resendMock.mockResolvedValue({ id: 'sent-1', resendCount: 1, lastResendAt: 1000 });
    await harness.grant(harness.limited.id, 'messages', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.post(urlFor(harness.sourceA))).status).toBe(200);
    expect((await agent.post(urlFor(harness.sourceB))).status).toBe(403);
    expect(resendMock).toHaveBeenCalledTimes(1);
  });

  it('returns the new resend state in the ok() envelope', async () => {
    resendMock.mockResolvedValue({ id: 'sent-1', resendCount: 2, lastResendAt: 5000 });
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(urlFor(harness.sourceA));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { id: 'sent-1', resendCount: 2, lastResendAt: 5000 } });
    expect(resendMock).toHaveBeenCalledWith('sent-1');
  });

  it('refuses with 409 TX_DISABLED on a receive-only source without calling the manager', async () => {
    receiveOnly.value = true;
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(urlFor(harness.sourceA));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TX_DISABLED');
    expect(resendMock).not.toHaveBeenCalled();
  });

  it('maps a TxDisabledError thrown mid-request to 409 TX_DISABLED', async () => {
    resendMock.mockRejectedValue(new TxDisabledError());
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(urlFor(harness.sourceA));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TX_DISABLED');
  });

  it.each([
    ['ALREADY_HEARD', 409],
    ['RESEND_TOO_OLD', 409],
    ['RESEND_UNAVAILABLE', 409],
    ['AUTO_RETRY_PENDING', 409],
    ['RESEND_LIMIT', 429],
    ['NOT_CHANNEL_MESSAGE', 400],
    ['NOT_OWN_MESSAGE', 400],
    ['MESSAGE_NOT_FOUND', 404],
    ['SEND_FAILED', 502],
  ] as const)('maps %s to HTTP %i', async (code, status) => {
    resendMock.mockRejectedValue(new MeshCoreResendError(code, `refused: ${code}`));
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(urlFor(harness.sourceA));
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ success: false, code, error: `refused: ${code}` });
  });

  it('returns 429 RESEND_COOLDOWN with retryAfterSeconds', async () => {
    resendMock.mockRejectedValue(new MeshCoreResendError('RESEND_COOLDOWN', 'wait', 12));
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(urlFor(harness.sourceA));
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ success: false, code: 'RESEND_COOLDOWN', retryAfterSeconds: 12 });
  });

  it('returns 500 INTERNAL_ERROR on an unexpected failure', async () => {
    resendMock.mockRejectedValue(new Error('boom'));
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(urlFor(harness.sourceA));
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });
});
