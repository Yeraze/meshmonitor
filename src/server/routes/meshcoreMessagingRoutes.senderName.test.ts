/**
 * Internal route POST /sources/:id/meshcore/messages/send with `senderName`
 * (#6282), and the policy routes GET/PUT /config/sender-names. Real auth and
 * permission rows plus real per-source settings (createRouteTestApp); the
 * manager is a stub. No RF.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import databaseService from '../../services/database.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { MeshCoreSenderNameError } from '../errors/meshcoreSenderNameError.js';

const { stubs, receiveOnly } = vi.hoisted(() => ({
  stubs: new Map<string, any>(),
  receiveOnly: { value: false },
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (sourceId: string) => stubs.get(sourceId),
    getAllManagers: () => Array.from(stubs.values()),
  },
}));

const POLICY_KEY = 'meshcoreSenderNameOverride';

describe('meshcore internal send + sender-name policy (#6282)', () => {
  let h: RouteTestHarness;
  let audit: ReturnType<typeof vi.spyOn>;
  const send = (sourceId: string) => `/sources/${sourceId}/meshcore/messages/send`;
  const policyUrl = (sourceId: string) => `/sources/${sourceId}/meshcore/config/sender-names`;
  const mk = (sourceId: string) => ({
    sourceId,
    sourceType: 'meshcore' as const,
    isReceiveOnly: () => receiveOnly.value,
    canTransmit: () => !receiveOnly.value,
    getLocalNode: () => ({ name: 'Bob' }),
    sendMessage: vi.fn(async () => true),
    sendChannelMessageAs: vi.fn(async () => ({ ok: true, message: { id: 'raw-1', scopeName: null } })),
  });

  beforeEach(async () => {
    receiveOnly.value = false;
    h = await createRouteTestApp({ mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes) });
    stubs.clear();
    stubs.set(h.sourceA, mk(h.sourceA));
    stubs.set(h.sourceB, mk(h.sourceB));
    // The :memory: DB is shared across tests: start every source at the default.
    await databaseService.settings.setSourceSetting(h.sourceA, POLICY_KEY, '');
    await databaseService.settings.setSourceSetting(h.sourceB, POLICY_KEY, '');
    audit = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await h.cleanup();
  });

  const enable = (sourceId: string, names = ['Alerts Bot']) =>
    databaseService.settings.setSourceSetting(sourceId, POLICY_KEY, JSON.stringify({ enabled: true, allowedNames: names }));

  describe('send with senderName', () => {
    it('default off: 403 SENDER_NAME_DISABLED, nothing sent', async () => {
      const agent = await h.loginAs(h.admin);
      const res = await agent.post(send(h.sourceA)).send({ text: 'hi', channelIdx: 1, senderName: 'Alerts Bot' });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ success: false, code: 'SENDER_NAME_DISABLED' });
      expect(stubs.get(h.sourceA).sendChannelMessageAs).not.toHaveBeenCalled();
      expect(stubs.get(h.sourceA).sendMessage).not.toHaveBeenCalled();
    });

    it('allowlisted name sends raw and audits without the text', async () => {
      await enable(h.sourceA);
      const agent = await h.loginAs(h.admin);
      const res = await agent.post(send(h.sourceA)).send({ text: 'private text', channelIdx: 1, senderName: 'Alerts Bot', scope: 'usa' });
      expect(res.status).toBe(200);
      expect(stubs.get(h.sourceA).sendChannelMessageAs).toHaveBeenCalledWith('private text', 1, 'Alerts Bot', 'usa');
      expect(stubs.get(h.sourceA).sendMessage).not.toHaveBeenCalled();
      const call = audit.mock.calls.find((c) => c[1] === 'meshcore_message_sent_as')!;
      expect(call).toBeTruthy();
      expect(JSON.parse(call[3] as string)).toMatchObject({
        sourceId: h.sourceA, channelIdx: 1, senderName: 'Alerts Bot', textBytes: 12, messageId: 'raw-1', via: 'api',
      });
      expect(call[3]).not.toContain('private text');
    });

    it('NOT_ALLOWED for an unlisted name; audited as denied', async () => {
      await enable(h.sourceA);
      const agent = await h.loginAs(h.admin);
      const res = await agent.post(send(h.sourceA)).send({ text: 'hi', channelIdx: 1, senderName: 'Mallory' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('SENDER_NAME_NOT_ALLOWED');
      expect(audit.mock.calls.some((c) => c[1] === 'meshcore_message_sent_as_denied')).toBe(true);
    });

    it("a grant on another source does not help, and one source's policy does not open another", async () => {
      await enable(h.sourceA);
      await h.grant(h.limited.id, 'messages', 'write', h.sourceB);
      const agent = await h.loginAs(h.limited);
      expect((await agent.post(send(h.sourceA)).send({ text: 'hi', channelIdx: 1, senderName: 'Alerts Bot' })).status).toBe(403);
      const resB = await agent.post(send(h.sourceB)).send({ text: 'hi', channelIdx: 1, senderName: 'Alerts Bot' });
      expect(resB.status).toBe(403);
      expect(resB.body.code).toBe('SENDER_NAME_DISABLED');
      expect(stubs.get(h.sourceA).sendChannelMessageAs).not.toHaveBeenCalled();
      expect(stubs.get(h.sourceB).sendChannelMessageAs).not.toHaveBeenCalled();
    });

    it('a user with messages:write on the source and an allowed name can send', async () => {
      await enable(h.sourceA);
      await h.grant(h.limited.id, 'messages', 'write', h.sourceA);
      const agent = await h.loginAs(h.limited);
      expect((await agent.post(send(h.sourceA)).send({ text: 'hi', channelIdx: 1, senderName: 'Alerts Bot' })).status).toBe(200);
    });

    it('400 for a DM, a missing channel, a bad name', async () => {
      await enable(h.sourceA);
      const agent = await h.loginAs(h.admin);
      const pk = 'cd'.repeat(32);
      expect((await agent.post(send(h.sourceA)).send({ text: 'hi', toPublicKey: pk, senderName: 'Alerts Bot' })).status).toBe(400);
      expect((await agent.post(send(h.sourceA)).send({ text: 'hi', senderName: 'Alerts Bot' })).status).toBe(400);
      expect((await agent.post(send(h.sourceA)).send({ text: 'hi', channelIdx: 1, senderName: 'a: b' })).status).toBe(400);
      expect(stubs.get(h.sourceA).sendChannelMessageAs).not.toHaveBeenCalled();
    });

    it('400 over the raw cap', async () => {
      await enable(h.sourceA);
      const agent = await h.loginAs(h.admin);
      const cap = 155 - ('Alerts Bot'.length + 2);
      expect((await agent.post(send(h.sourceA)).send({ text: 'x'.repeat(cap + 1), channelIdx: 1, senderName: 'Alerts Bot' })).status).toBe(400);
      expect((await agent.post(send(h.sourceA)).send({ text: 'x'.repeat(cap), channelIdx: 1, senderName: 'Alerts Bot' })).status).toBe(200);
    });

    it('maps FIRMWARE_UNSUPPORTED to 422 and does not audit a sent-as row', async () => {
      await enable(h.sourceA);
      stubs.get(h.sourceA).sendChannelMessageAs.mockRejectedValueOnce(new MeshCoreSenderNameError('FIRMWARE_UNSUPPORTED', 'old'));
      const agent = await h.loginAs(h.admin);
      const res = await agent.post(send(h.sourceA)).send({ text: 'hi', channelIdx: 1, senderName: 'Alerts Bot' });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('FIRMWARE_UNSUPPORTED');
      expect(audit.mock.calls.some((c) => c[1] === 'meshcore_message_sent_as')).toBe(false);
    });

    it('receive-only: 409 before the override path', async () => {
      await enable(h.sourceA);
      receiveOnly.value = true;
      const agent = await h.loginAs(h.admin);
      const res = await agent.post(send(h.sourceA)).send({ text: 'hi', channelIdx: 1, senderName: 'Alerts Bot' });
      expect(res.status).toBe(409);
      expect(stubs.get(h.sourceA).sendChannelMessageAs).not.toHaveBeenCalled();
    });

    it("the node's own name and absent senderName use the normal path", async () => {
      const agent = await h.loginAs(h.admin);
      expect((await agent.post(send(h.sourceA)).send({ text: 'hi', channelIdx: 1, senderName: 'Bob' })).status).toBe(200);
      expect((await agent.post(send(h.sourceA)).send({ text: 'hi', channelIdx: 1 })).status).toBe(200);
      expect(stubs.get(h.sourceA).sendMessage).toHaveBeenCalledTimes(2);
      expect(stubs.get(h.sourceA).sendChannelMessageAs).not.toHaveBeenCalled();
    });
  });

  describe('policy routes', () => {
    it('GET defaults to off with no names', async () => {
      const agent = await h.loginAs(h.admin);
      const res = await agent.get(policyUrl(h.sourceA));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { enabled: false, allowedNames: [] } });
    });

    it('PUT needs configuration:write on THAT source', async () => {
      await h.grant(h.limited.id, 'configuration', 'write', h.sourceA);
      const agent = await h.loginAs(h.limited);
      const body = { enabled: true, allowedNames: ['Alerts Bot'] };
      expect((await agent.put(policyUrl(h.sourceA)).send(body)).status).toBe(200);
      expect((await agent.put(policyUrl(h.sourceB)).send(body)).status).toBe(403);
    });

    it('messages:write alone cannot edit the list', async () => {
      await h.grant(h.limited.id, 'messages', 'write', h.sourceA);
      const agent = await h.loginAs(h.limited);
      expect((await agent.put(policyUrl(h.sourceA)).send({ enabled: true, allowedNames: ['x'] })).status).toBe(403);
    });

    it('PUT normalises, stores, and audits the change', async () => {
      const agent = await h.loginAs(h.admin);
      const res = await agent.put(policyUrl(h.sourceA)).send({ enabled: true, allowedNames: ['  Alerts Bot ', 'Alerts Bot', 'Zoë'] });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ enabled: true, allowedNames: ['Alerts Bot', 'Zoë'] });
      const get = await agent.get(policyUrl(h.sourceA));
      expect(get.body.data.allowedNames).toEqual(['Alerts Bot', 'Zoë']);
      const call = audit.mock.calls.find((c) => c[1] === 'meshcore_sender_names_updated')!;
      expect(call[2]).toBe('configuration');
      expect(JSON.parse(call[3] as string)).toMatchObject({ sourceId: h.sourceA, enabledBefore: false, enabled: true });
      // Per source: B is untouched.
      expect((await agent.get(policyUrl(h.sourceB))).body.data).toEqual({ enabled: false, allowedNames: [] });
    });

    it.each([
      [{ enabled: 'yes', allowedNames: [] }],
      [{ enabled: true, allowedNames: 'x' }],
      [{ enabled: true, allowedNames: ['a:b'] }],
      [{ enabled: true, allowedNames: ['#x'] }],
      [{ enabled: true, allowedNames: Array.from({ length: 17 }, (_, i) => `n${i}`) }],
      [{ enabled: true, allowedNames: ['x'.repeat(32)] }],
    ])('PUT rejects %j with 400', async (body) => {
      const agent = await h.loginAs(h.admin);
      const res = await agent.put(policyUrl(h.sourceA)).send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_INPUT');
    });

    it('anonymous cannot read (no configuration:read grant) or write', async () => {
      const agent = await h.loginAs(null);
      expect((await agent.get(policyUrl(h.sourceA))).status).toBe(403);
      expect((await agent.put(policyUrl(h.sourceA)).send({ enabled: true, allowedNames: [] })).status).toBe(401);
    });
  });
});
