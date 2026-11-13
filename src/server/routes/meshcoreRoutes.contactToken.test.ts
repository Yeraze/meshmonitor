/**
 * Route tests — import a MeshCore One contact-share token (#6370).
 *
 *  POST /sources/:id/meshcore/contacts/import-token: nodes:write, per-source
 *  scoped, validates the token with the shared parser, and maps every
 *  importContactFromToken outcome onto the ok()/fail() envelope the same way
 *  add-to-device does.
 *
 * Real-middleware harness (createRouteTestApp); only the source-manager
 * registry is mocked (non-DB).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const { importMock, sendMock } = vi.hoisted(() => ({ importMock: vi.fn(), sendMock: vi.fn() }));

vi.mock('../sourceManagerRegistry.js', () => {
  const stubFor = (sourceId: string) => ({
    sourceId,
    sourceType: 'meshcore' as const,
    importContactFromToken: importMock,
    sendMessage: sendMock,
    getLocalNode: () => ({ name: 'Bob' }),
    isReceiveOnly: () => false,
    canTransmit: () => true,
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

const KEY = 'ab'.repeat(32);
const TOKEN = `<${KEY.toUpperCase()}:2:Ridge: North>`;

describe('meshcoreRoutes — contact-share token import (#6370)', () => {
  let harness: RouteTestHarness;
  const urlFor = (sourceId: string) => `/sources/${sourceId}/meshcore/contacts/import-token`;

  beforeEach(async () => {
    importMock.mockReset();
    sendMock.mockReset().mockResolvedValue(true);
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('returns 401 when unauthenticated', async () => {
    const agent = await harness.loginAs(null);
    expect((await agent.post(urlFor(harness.sourceA)).send({ token: TOKEN })).status).toBe(401);
    expect(importMock).not.toHaveBeenCalled();
  });

  it('returns 403 with only nodes:read', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.post(urlFor(harness.sourceA)).send({ token: TOKEN })).status).toBe(403);
    expect(importMock).not.toHaveBeenCalled();
  });

  it('per-source scoping: nodes:write on sourceA does not authorize sourceB', async () => {
    importMock.mockResolvedValue({ status: 'added', evicted: [], count: 3, maxContacts: 100 });
    await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.post(urlFor(harness.sourceA)).send({ token: TOKEN })).status).toBe(200);
    expect((await agent.post(urlFor(harness.sourceB)).send({ token: TOKEN })).status).toBe(403);
    expect(importMock).toHaveBeenCalledTimes(1);
  });

  it('parses the token and passes key (lower case), type and name to the manager', async () => {
    importMock.mockResolvedValue({ status: 'added', evicted: [], count: 3, maxContacts: 100 });
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(urlFor(harness.sourceA)).send({ token: TOKEN });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { status: 'added', evicted: [], count: 3, maxContacts: 100 },
    });
    expect(importMock).toHaveBeenCalledWith(
      { publicKey: KEY, type: 2, name: 'Ridge: North' },
      { confirmFull: false },
    );
  });

  it.each([
    ['missing token', {}],
    ['not a string', { token: 42 }],
    ['short key', { token: `<${KEY.slice(2)}:1:A>` }],
    ['type 4', { token: `<${KEY}:4:Sensor>` }],
    ['type 0', { token: `<${KEY}:0:None>` }],
    ['blank name', { token: `<${KEY}:1:   >` }],
  ])('rejects %s with 400 INVALID_CONTACT_TOKEN', async (_label, body) => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(urlFor(harness.sourceA)).send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CONTACT_TOKEN');
    expect(importMock).not.toHaveBeenCalled();
  });

  it('asks for confirmation when the table is full, then imports with confirmFull', async () => {
    importMock.mockResolvedValueOnce({ status: 'confirm_full', count: 100, maxContacts: 100 });
    const agent = await harness.loginAs(harness.admin);
    const first = await agent.post(urlFor(harness.sourceA)).send({ token: TOKEN });
    expect(first.status).toBe(409);
    expect(first.body).toMatchObject({ success: false, code: 'CONTACT_TABLE_FULL_CONFIRM', count: 100, maxContacts: 100 });

    importMock.mockResolvedValueOnce({ status: 'added', evicted: [], count: 100, maxContacts: 100 });
    const second = await agent.post(urlFor(harness.sourceA)).send({ token: TOKEN, confirmFull: true });
    expect(second.status).toBe(200);
    expect(importMock).toHaveBeenLastCalledWith(
      { publicKey: KEY, type: 2, name: 'Ridge: North' },
      { confirmFull: true },
    );
  });

  it('reports a contact already on the radio as success', async () => {
    importMock.mockResolvedValue({ status: 'already_on_device' });
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(urlFor(harness.sourceA)).send({ token: TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ status: 'already_on_device' });
  });

  it.each([
    [{ status: 'favorites_unprotected', unprotected: [KEY] }, 409, 'FAVORITES_NOT_PROTECTED'],
    [{ status: 'table_full', count: 100, maxContacts: 100 }, 409, 'CONTACT_TABLE_FULL'],
    [{ status: 'self' }, 400, 'CANNOT_IMPORT_SELF'],
    [{ status: 'unavailable' }, 409, 'COMPANION_NOT_CONNECTED'],
    [{ status: 'failed', error: 'radio said no' }, 502, 'ADD_CONTACT_FAILED'],
  ])('maps %o to %i %s', async (outcome, status, code) => {
    importMock.mockResolvedValue(outcome);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(urlFor(harness.sourceA)).send({ token: TOKEN });
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ success: false, code });
  });

  it('a message carrying a token is sent to the radio unchanged (no < > rewriting)', async () => {
    const agent = await harness.loginAs(harness.admin);
    const text = `${TOKEN} <${'cd'.repeat(32)}:1:Al>`; // 153 bytes, under the 160-byte DM cap
    const res = await agent
      .post(`/sources/${harness.sourceA}/meshcore/messages/send`)
      .send({ text, toPublicKey: 'ef'.repeat(32) });
    expect(res.status).toBe(200);
    expect(sendMock).toHaveBeenCalledWith(text, 'ef'.repeat(32), undefined, undefined);
  });
});
