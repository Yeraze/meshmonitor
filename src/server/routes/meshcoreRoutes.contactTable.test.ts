/**
 * Route tests — the companion's contact table (#5349).
 *
 *  - POST /contacts/:publicKey/add-to-device: nodes:write, per-source scoped,
 *    maps every addContactToDevice outcome onto the ok()/fail() envelope
 *    (409 CONTACT_TABLE_FULL_CONFIRM → confirmFull:true → added).
 *  - Login / status / CLI to a node the radio doesn't hold answer
 *    409 CONTACT_NOT_ON_DEVICE instead of a generic 401 / 404 / 502.
 *
 * Real-middleware harness (createRouteTestApp); only the source-manager
 * registry is mocked (non-DB).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { MeshCoreContactNotOnDeviceError } from '../meshcoreDeviceContactErrors.js';

const { addMock, loginMock, statusMock, cliMock, roomLoginMock } = vi.hoisted(() => ({
  addMock: vi.fn(),
  loginMock: vi.fn(),
  statusMock: vi.fn(),
  cliMock: vi.fn(),
  roomLoginMock: vi.fn(),
}));

vi.mock('../sourceManagerRegistry.js', () => {
  const stubFor = (sourceId: string) => ({
    sourceId,
    sourceType: 'meshcore' as const,
    addContactToDevice: addMock,
    loginToNodeDetailed: loginMock,
    requestNodeStatusDetailed: statusMock,
    sendCliCommand: cliMock,
    loginToRoomWithOutcome: roomLoginMock,
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

const PK = '5708bb' + '22'.repeat(29);

describe('meshcoreRoutes — contact table (#5349)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    for (const m of [addMock, loginMock, statusMock, cliMock, roomLoginMock]) m.mockReset();
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  describe('POST /contacts/:publicKey/add-to-device', () => {
    const urlFor = (sourceId: string, publicKey = PK) =>
      `/sources/${sourceId}/meshcore/contacts/${publicKey}/add-to-device`;

    it('returns 401 when unauthenticated', async () => {
      const agent = await harness.loginAs(null);
      expect((await agent.post(urlFor(harness.sourceA))).status).toBe(401);
      expect(addMock).not.toHaveBeenCalled();
    });

    it('returns 403 with only nodes:read', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.post(urlFor(harness.sourceA))).status).toBe(403);
      expect(addMock).not.toHaveBeenCalled();
    });

    it('per-source scoping: nodes:write on sourceA does not authorize sourceB', async () => {
      addMock.mockResolvedValue({ status: 'added', evicted: [], count: 3, maxContacts: 100 });
      await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.post(urlFor(harness.sourceA))).status).toBe(200);
      expect((await agent.post(urlFor(harness.sourceB))).status).toBe(403);
    });

    it('rejects a malformed key with 400 INVALID_PUBLIC_KEY', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(urlFor(harness.sourceA, 'abc'));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_PUBLIC_KEY');
      expect(addMock).not.toHaveBeenCalled();
    });

    it('returns the added result in the ok() envelope', async () => {
      addMock.mockResolvedValue({ status: 'added', evicted: [], count: 3, maxContacts: 100 });
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(urlFor(harness.sourceA)).send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: { status: 'added', evicted: [], count: 3, maxContacts: 100 },
      });
      expect(addMock).toHaveBeenCalledWith(PK, { confirmFull: false });
    });

    it('asks for confirmation when the table is full, then adds with confirmFull', async () => {
      addMock.mockResolvedValueOnce({ status: 'confirm_full', count: 100, maxContacts: 100 });
      const agent = await harness.loginAs(harness.admin);
      const first = await agent.post(urlFor(harness.sourceA)).send({});
      expect(first.status).toBe(409);
      expect(first.body).toMatchObject({
        success: false,
        code: 'CONTACT_TABLE_FULL_CONFIRM',
        count: 100,
        maxContacts: 100,
      });

      addMock.mockResolvedValueOnce({ status: 'added', evicted: ['aa'.repeat(32)], count: 100, maxContacts: 100 });
      const second = await agent.post(urlFor(harness.sourceA)).send({ confirmFull: true });
      expect(second.status).toBe(200);
      expect(second.body.data.evicted).toEqual(['aa'.repeat(32)]);
      expect(addMock).toHaveBeenLastCalledWith(PK, { confirmFull: true });
    });

    it('blocks with 409 FAVORITES_NOT_PROTECTED', async () => {
      addMock.mockResolvedValue({ status: 'favorites_unprotected', unprotected: ['aa'.repeat(32)] });
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(urlFor(harness.sourceA)).send({ confirmFull: true });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'FAVORITES_NOT_PROTECTED', unprotected: ['aa'.repeat(32)] });
    });

    it('maps the firmware refusal to 409 CONTACT_TABLE_FULL', async () => {
      addMock.mockResolvedValue({ status: 'table_full', count: 100, maxContacts: 100 });
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(urlFor(harness.sourceA)).send({ confirmFull: true });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONTACT_TABLE_FULL');
    });

    it('maps unknown_type to 422 UNKNOWN_NODE_TYPE', async () => {
      addMock.mockResolvedValue({ status: 'unknown_type' });
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(urlFor(harness.sourceA));
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('UNKNOWN_NODE_TYPE');
    });
  });

  describe('409 CONTACT_NOT_ON_DEVICE', () => {
    it('POST /admin/login', async () => {
      loginMock.mockResolvedValue({ result: null, outcome: 'not_on_device' });
      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .post(`/sources/${harness.sourceA}/meshcore/admin/login`)
        .send({ publicKey: PK, password: 'pw' });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ success: false, code: 'CONTACT_NOT_ON_DEVICE' });
      expect(res.body.error).toMatch(/not in the radio's contact list/);
    });

    it('POST /admin/login still answers 401 for an ordinary failure', async () => {
      loginMock.mockResolvedValue({ result: null, outcome: 'no_reply' });
      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .post(`/sources/${harness.sourceA}/meshcore/admin/login`)
        .send({ publicKey: PK, password: 'pw' });
      expect(res.status).toBe(401);
    });

    it('GET /admin/status/:publicKey', async () => {
      statusMock.mockResolvedValue({ status: null, notOnDevice: true });
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/sources/${harness.sourceA}/meshcore/admin/status/${PK}`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONTACT_NOT_ON_DEVICE');
    });

    it('POST /admin/cli', async () => {
      cliMock.mockRejectedValue(new MeshCoreContactNotOnDeviceError(PK));
      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .post(`/sources/${harness.sourceA}/meshcore/admin/cli`)
        .send({ publicKey: PK, command: 'ver' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONTACT_NOT_ON_DEVICE');
    });

    it('POST /rooms/login', async () => {
      roomLoginMock.mockResolvedValue('not_on_device');
      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .post(`/sources/${harness.sourceA}/meshcore/rooms/login`)
        .send({ publicKey: PK, password: 'pw' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONTACT_NOT_ON_DEVICE');
    });
  });
});
