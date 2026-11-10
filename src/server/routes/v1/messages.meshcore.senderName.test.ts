/**
 * v1 POST /messages `senderName` on a MeshCore source (#6282): default off,
 * allowlist only, per-source, audited, no message text in the audit row.
 * Real auth + permission rows and real per-source settings (createRouteTestApp);
 * the manager is a stub. No RF.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const registry = vi.hoisted(() => ({ managers: new Map<string, unknown>() }));
vi.mock('../../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (id: string) => registry.managers.get(id),
    getAllManagers: () => [...registry.managers.values()],
  },
}));
vi.mock('../../meshtasticManager.js', () => ({ default: {}, fallbackManager: {} }));
vi.mock('../../messageQueueService.js', () => ({ messageQueueService: {} }));

import databaseService from '../../../services/database.js';
import { createRouteTestApp, type RouteTestHarness } from '../../test-helpers/routeTestApp.js';
import { attachSource } from './sourceParam.js';
import messagesRouter from './messages.js';
import { MeshCoreSenderNameError } from '../../errors/meshcoreSenderNameError.js';
import { TxDisabledError } from '../../errors/txDisabledError.js';

const MC = 'sn-mc-source';
const MC2 = 'sn-mc-source-2';
const MT = 'sn-mt-source';
const PK = 'ab'.repeat(32);
const POLICY_KEY = 'meshcoreSenderNameOverride';
const ENABLED = JSON.stringify({ enabled: true, allowedNames: ['Alerts Bot', 'Zoë'] });

const makeStub = (over: Record<string, unknown> = {}) => ({
  sourceType: 'meshcore',
  isReceiveOnly: vi.fn(() => false),
  isConnected: vi.fn(() => true),
  getLocalNode: vi.fn(() => ({ name: 'Bob' }) as { name?: string } | null),
  sendMessageWithResult: vi.fn(async () => ({ ok: true, message: { id: `${MC}_row1` } })),
  sendChannelMessageAs: vi.fn(async () => ({ ok: true, message: { id: `${MC}_raw1`, scopeName: 'usa' } })),
  ...over,
});

describe('v1 POST /messages senderName — MeshCore', () => {
  let h: RouteTestHarness;
  let user: { id: number; username: string; isAdmin: boolean };
  let stub: ReturnType<typeof makeStub>;
  let audit: ReturnType<typeof vi.spyOn>;

  const wipe = async () => {
    for (const id of [MC, MC2, MT]) await databaseService.sources.deleteSource(id).catch(() => {});
  };
  const post = (body: unknown, sourceId = MC) =>
    request(h.app).post(`/v1/sources/${sourceId}/messages`).send(body as object);
  const grant = async (resource: string, acts: Array<'read' | 'write'>, sourceId = MC) => {
    await databaseService.auth.createPermission({
      userId: h.limited.id, resource,
      canRead: acts.includes('read'), canWrite: acts.includes('write'), canViewOnMap: false,
      sourceId, grantedAt: Date.now(), grantedBy: null,
    } as never);
  };
  const auditActions = () => audit.mock.calls.map((c) => c[1]);

  beforeEach(async () => {
    registry.managers.clear();
    h = await createRouteTestApp({
      useOptionalAuth: false,
      mount: (app) => {
        app.use((req: any, _res: any, next: any) => { req.user = user; next(); });
        app.use('/v1/sources/:sourceId/messages', attachSource('messages', 'read'), messagesRouter);
      },
    });
    user = h.limited;
    await wipe();
    await databaseService.sources.createSource({ id: MC, name: 'MC', type: 'meshcore', config: {}, enabled: true });
    await databaseService.sources.createSource({ id: MC2, name: 'MC2', type: 'meshcore', config: {}, enabled: true });
    await databaseService.sources.createSource({ id: MT, name: 'MT', type: 'meshtastic_tcp', config: {}, enabled: true });
    stub = makeStub();
    registry.managers.set(MC, stub);
    registry.managers.set(MC2, makeStub());
    await h.revokeAll(h.limited.id);
    await grant('messages', ['read']);
    await grant('channel_1', ['write']);
    await grant('messages', ['read'], MC2);
    await grant('channel_1', ['write'], MC2);
    await databaseService.settings.setSourceSetting(MC, POLICY_KEY, ENABLED);
    audit = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await wipe();
    await h.cleanup();
  });

  it('sends raw under an allowlisted name and audits it without the text', async () => {
    const res = await post({ text: 'secret words', channel: 1, senderName: '  Alerts Bot ', scope: 'usa' }).expect(201);
    expect(stub.sendChannelMessageAs).toHaveBeenCalledWith('secret words', 1, 'Alerts Bot', 'usa');
    expect(stub.sendMessageWithResult).not.toHaveBeenCalled();
    expect(res.body.data).toMatchObject({ messageId: `${MC}_raw1`, senderName: 'Alerts Bot', protocol: 'meshcore' });
    expect(auditActions()).toContain('meshcore_message_sent_as');
    const call = audit.mock.calls.find((c) => c[1] === 'meshcore_message_sent_as')!;
    expect(call[2]).toBe('messages');
    const details = JSON.parse(call[3] as string);
    expect(details).toMatchObject({
      sourceId: MC, channelIdx: 1, senderName: 'Alerts Bot', scope: 'usa', textBytes: 12, via: 'v1', userId: h.limited.id,
    });
    expect(call[3]).not.toContain('secret words');
  });

  it('allows a non-ASCII allowlisted name', async () => {
    await post({ text: 'hi', channel: 1, senderName: 'Zoë' }).expect(201);
    expect(stub.sendChannelMessageAs.mock.calls[0][2]).toBe('Zoë');
  });

  it('absent senderName takes the normal path', async () => {
    await post({ text: 'hi', channel: 1 }).expect(201);
    expect(stub.sendMessageWithResult).toHaveBeenCalled();
    expect(stub.sendChannelMessageAs).not.toHaveBeenCalled();
    expect(auditActions()).not.toContain('meshcore_message_sent_as');
  });

  it("the node's own name takes the normal path, even when the override is off", async () => {
    await databaseService.settings.setSourceSetting(MC, POLICY_KEY, JSON.stringify({ enabled: false, allowedNames: [] }));
    await post({ text: 'hi', channel: 1, senderName: ' Bob ' }).expect(201);
    expect(stub.sendMessageWithResult).toHaveBeenCalled();
    expect(stub.sendChannelMessageAs).not.toHaveBeenCalled();
  });

  it('403 SENDER_NAME_DISABLED by default (no setting) and when switched off', async () => {
    await databaseService.settings.setSourceSetting(MC, POLICY_KEY, '');
    let res = await post({ text: 'hi', channel: 1, senderName: 'Alerts Bot' }).expect(403);
    expect(res.body.code).toBe('SENDER_NAME_DISABLED');
    await databaseService.settings.setSourceSetting(MC, POLICY_KEY, JSON.stringify({ enabled: false, allowedNames: ['Alerts Bot'] }));
    res = await post({ text: 'hi', channel: 1, senderName: 'Alerts Bot' }).expect(403);
    expect(res.body.code).toBe('SENDER_NAME_DISABLED');
    expect(stub.sendChannelMessageAs).not.toHaveBeenCalled();
    expect(auditActions()).toContain('meshcore_message_sent_as_denied');
  });

  it('403 SENDER_NAME_NOT_ALLOWED for a name off the list (case-sensitive)', async () => {
    for (const name of ['Someone Else', 'alerts bot']) {
      const res = await post({ text: 'hi', channel: 1, senderName: name }).expect(403);
      expect(res.body.code).toBe('SENDER_NAME_NOT_ALLOWED');
    }
    expect(stub.sendChannelMessageAs).not.toHaveBeenCalled();
  });

  it('the policy is per source: enabled on one source does not open another', async () => {
    const other = (registry.managers.get(MC2) as ReturnType<typeof makeStub>);
    const res = await post({ text: 'hi', channel: 1, senderName: 'Alerts Bot' }, MC2).expect(403);
    expect(res.body.code).toBe('SENDER_NAME_DISABLED');
    expect(other.sendChannelMessageAs).not.toHaveBeenCalled();
  });

  it('still needs the normal write grant on that channel', async () => {
    await h.revokeAll(h.limited.id);
    await grant('messages', ['read']);
    await post({ text: 'hi', channel: 1, senderName: 'Alerts Bot' }).expect(403);
    expect(stub.sendChannelMessageAs).not.toHaveBeenCalled();
  });

  it('400 for a DM, a non-string, a bad name, or a missing channel', async () => {
    user = h.admin;
    await post({ text: 'hi', toNodeId: `mc:${PK}`, senderName: 'Alerts Bot' }).expect(400);
    await post({ text: 'hi', channel: 1, senderName: 5 }).expect(400);
    await post({ text: 'hi', channel: 1, senderName: 'a:b' }).expect(400);
    await post({ text: 'hi', channel: 1, senderName: 'x'.repeat(32) }).expect(400);
    expect(stub.sendChannelMessageAs).not.toHaveBeenCalled();
  });

  it('413 over the raw cap (155 - name - 2), accepted at the cap', async () => {
    const cap = 155 - ('Alerts Bot'.length + 2);
    await post({ text: 'x'.repeat(cap + 1), channel: 1, senderName: 'Alerts Bot' }).expect(413);
    await post({ text: 'x'.repeat(cap), channel: 1, senderName: 'Alerts Bot' }).expect(201);
  });

  it('maps manager refusals: old firmware 422, client repeat 409', async () => {
    stub.sendChannelMessageAs.mockRejectedValueOnce(new MeshCoreSenderNameError('FIRMWARE_UNSUPPORTED', 'old'));
    let res = await post({ text: 'hi', channel: 1, senderName: 'Alerts Bot' }).expect(422);
    expect(res.body.code).toBe('FIRMWARE_UNSUPPORTED');
    stub.sendChannelMessageAs.mockRejectedValueOnce(new MeshCoreSenderNameError('CLIENT_REPEAT_ON', 'rpt'));
    res = await post({ text: 'hi', channel: 1, senderName: 'Alerts Bot' }).expect(409);
    expect(res.body.code).toBe('CLIENT_REPEAT_ON');
    expect(auditActions()).not.toContain('meshcore_message_sent_as');
  });

  it('TX disabled mid-send is 409 TX_DISABLED', async () => {
    stub.sendChannelMessageAs.mockRejectedValueOnce(new TxDisabledError());
    const res = await post({ text: 'hi', channel: 1, senderName: 'Alerts Bot' }).expect(409);
    expect(res.body.code).toBe('TX_DISABLED');
  });

  it('receive-only is refused before the override path runs', async () => {
    stub.isReceiveOnly.mockReturnValue(true);
    await post({ text: 'hi', channel: 1, senderName: 'Alerts Bot' }).expect(409);
    expect(stub.sendChannelMessageAs).not.toHaveBeenCalled();
  });

  it('400 on a Meshtastic source', async () => {
    registry.managers.set(MT, { sourceType: 'meshtastic_tcp' });
    await grant('messages', ['read', 'write'], MT);
    const res = await post({ text: 'hi', channel: 0, senderName: 'Alerts Bot' }, MT);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
  });
});
