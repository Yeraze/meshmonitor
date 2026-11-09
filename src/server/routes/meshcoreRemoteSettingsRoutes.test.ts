/**
 * Route tests — remote structured Repeater / Room Server settings (#6256, P10 WP2).
 *
 * Real-middleware harness against the singleton's :memory: DB; only the source
 * registry (non-DB) is mocked. The transport's 1 s gap is set to 0 here; its
 * own unit test covers the gap with fake timers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { resetRemoteSettingsStateForTests, REMOTE_SETTINGS_BUDGET_MAX } from './meshcoreRemoteSettingsRoutes.js';

const { state, sendCliMock, recordMeshTxMock, getSessionMock } = vi.hoisted(() => ({
  state: { connected: true, receiveOnly: false, contacts: new Map<string, { advType: number; advName?: string }>() },
  sendCliMock: vi.fn(),
  recordMeshTxMock: vi.fn(),
  getSessionMock: vi.fn(),
}));

vi.mock('../services/meshcoreRemoteRepeaterTransport.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../services/meshcoreRemoteRepeaterTransport.js')>();
  return {
    ...orig,
    createRemoteRepeaterTransport: (m: Parameters<typeof orig.createRemoteRepeaterTransport>[0], pk: string, o: Parameters<typeof orig.createRemoteRepeaterTransport>[2] = {}) =>
      orig.createRemoteRepeaterTransport(m, pk, { ...o, minGapMs: 0 }),
  };
});

vi.mock('../sourceManagerRegistry.js', () => {
  const stubFor = (sourceId: string) => ({
    sourceId,
    sourceType: 'meshcore' as const,
    getConnectionStatus: () => ({ connected: state.connected, deviceType: 1, config: null }),
    getContact: (pk: string) => state.contacts.get(pk.toLowerCase()),
    getAdminSession: getSessionMock,
    sendCliCommand: sendCliMock,
    recordMeshTx: recordMeshTxMock,
    isReceiveOnly: () => state.receiveOnly,
    canTransmit: () => !state.receiveOnly,
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

const REPEATER = 'aa'.repeat(32);
const ROOM = 'bb'.repeat(32);
const COMPANION = 'cc'.repeat(32);

const GET_REPLIES: Record<string, string> = {
  ver: 'v1.18.0 (Build: 1-Jan-2026)',
  'get name': '> Hill Repeater',
  'get lat': '> 12.5',
  'get lon': '> -80.25',
  'get tx': '> 22',
  'get radio': '> 869.618,62.5,8,8',
  'get advert.interval': '> 60',
  'get flood.advert.interval': '> 12',
  'get flood.max': '> 3',
  'get repeat': '> on',
  'get af': '> 1',
  'get rxdelay': '> 0',
  'get txdelay': '> 0.5',
  'get direct.txdelay': '> 0.2',
  'get guest.password': '> hunter2',
  'get allow.read.only': '> off',
};

function defaultReply(_pk: string, cmd: string) {
  if (/^set flood\.max /.test(cmd)) GET_REPLIES['get flood.max'] = `> ${cmd.split(' ')[2]}`;
  if (/^set |^password /.test(cmd)) return Promise.resolve({ reply: 'OK', elapsedMs: 10 });
  return Promise.resolve({ reply: GET_REPLIES[cmd] ?? '> 0', elapsedMs: 10 });
}

const sentCommands = () => sendCliMock.mock.calls.map((c) => c[1] as string);

describe('meshcore remote settings routes (#6256)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    resetRemoteSettingsStateForTests();
    sendCliMock.mockReset().mockImplementation(defaultReply);
    recordMeshTxMock.mockReset();
    getSessionMock.mockReset().mockResolvedValue({ active: true, loggedInAt: 1, isAdmin: true });
    state.connected = true;
    state.receiveOnly = false;
    state.contacts = new Map([
      [REPEATER, { advType: 2, advName: 'Hill Repeater' }],
      [ROOM, { advType: 3, advName: 'Club Room' }],
      [COMPANION, { advType: 1, advName: 'Phone' }],
    ]);
    GET_REPLIES['get flood.max'] = '> 3';
    harness = await createRouteTestApp({ mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes) });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const readUrl = (s: string, pk = REPEATER) => `/sources/${s}/meshcore/admin/settings/${pk}/read`;
  const patchUrl = (s: string, pk = REPEATER) => `/sources/${s}/meshcore/admin/settings/${pk}`;

  describe('permissions', () => {
    it('needs remote_admin:write on THIS source for read and save', async () => {
      await harness.grant(harness.limited.id, 'remote_admin', 'read', harness.sourceA);
      await harness.grant(harness.limited.id, 'remote_admin', 'write', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.post(readUrl(harness.sourceA)).send({ groups: ['adverts'] })).status).toBe(403);
      expect((await agent.patch(patchUrl(harness.sourceA)).send({ floodMax: 4 })).status).toBe(403);
      expect((await agent.post(readUrl(harness.sourceB)).send({ groups: ['access'] })).status).toBe(200);
      expect(sendCliMock).toHaveBeenCalled();
    });

    it('refuses a receive-only source with TX_DISABLED and sends nothing', async () => {
      state.receiveOnly = true;
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(readUrl(harness.sourceA)).send({ groups: ['adverts'] });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('TX_DISABLED');
      expect(sendCliMock).not.toHaveBeenCalled();
    });
  });

  describe('validation comes before the connection and session checks', () => {
    beforeEach(() => {
      state.connected = false;
      getSessionMock.mockResolvedValue({ active: false, loggedInAt: null, isAdmin: null, reason: 'none' });
    });

    it.each([
      [{ advertInterval: 59 }, 'advertInterval'],
      [{ floodAdvertInterval: 169 }, 'floodAdvertInterval'],
      [{ floodMax: 65 }, 'floodMax'],
      [{ name: 'x'.repeat(32) }, 'name'],
      [{ name: 'bad\nname' }, 'name'],
      [{ adminPassword: 'secret' }, 'adminPassword'],
      [{ radio: '869.618,62.5,8,8' }, 'radio'],
    ])('400 VALIDATION for %j', async (body, field) => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.patch(patchUrl(harness.sourceA)).send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION');
      expect(res.body.field).toBe(field);
      expect(sendCliMock).not.toHaveBeenCalled();
      expect(getSessionMock).not.toHaveBeenCalled();
    });

    it('a Room Server refuses the forwarding knobs', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.patch(patchUrl(harness.sourceA, ROOM)).send({ repeat: false });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('repeat');
    });

    it('a valid body on a disconnected source is 409 SOURCE_NOT_CONNECTED', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.patch(patchUrl(harness.sourceA)).send({ floodMax: 4 });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SOURCE_NOT_CONNECTED');
    });

    it('rejects a bad groups list', async () => {
      const agent = await harness.loginAs(harness.admin);
      for (const groups of [undefined, [], ['radio'], 'adverts']) {
        const res = await agent.post(readUrl(harness.sourceA)).send({ groups });
        expect(res.status).toBe(400);
        expect(res.body.field).toBe('groups');
      }
    });
  });

  describe('target and session checks', () => {
    it('404 for an unknown contact, 409 for a Companion target', async () => {
      const agent = await harness.loginAs(harness.admin);
      const missing = await agent.post(readUrl(harness.sourceA, 'dd'.repeat(32))).send({ groups: ['adverts'] });
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('CONTACT_NOT_FOUND');
      const companion = await agent.post(readUrl(harness.sourceA, COMPANION)).send({ groups: ['adverts'] });
      expect(companion.status).toBe(409);
      expect(companion.body.code).toBe('NOT_REMOTE_ADMIN_TARGET');
    });

    it('needs a remembered admin session and never logs in on its own', async () => {
      getSessionMock.mockResolvedValue({ active: false, loggedInAt: null, isAdmin: null, reason: 'none' });
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(readUrl(harness.sourceA)).send({ groups: ['adverts'] });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ADMIN_SESSION_REQUIRED');
      expect(sendCliMock).not.toHaveBeenCalled();
    });
  });

  describe('read', () => {
    it('sends ver once plus only the requested group, and records a mesh TX per command', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(readUrl(harness.sourceA)).send({ groups: ['adverts'] });
      expect(res.status).toBe(200);
      expect(sentCommands()).toEqual([
        'ver',
        'get advert.interval',
        'get flood.advert.interval',
        'get flood.max',
        'get repeat',
        'get af',
        'get rxdelay',
        'get txdelay',
        'get direct.txdelay',
      ]);
      expect(recordMeshTxMock).toHaveBeenCalledTimes(9);
      expect(res.body.data).toMatchObject({
        deviceType: 'repeater',
        firmware: 'v1.18.0 (Build: 1-Jan-2026)',
        sent: 9,
        values: { advertInterval: 60, floodMax: 3, repeat: true },
      });

      sendCliMock.mockClear();
      const access = await agent.post(readUrl(harness.sourceA)).send({ groups: ['access'] });
      expect(sentCommands()).toEqual(['get guest.password', 'get allow.read.only']);
      expect(access.body.data.guestPasswordSet).toBe(true);
      expect(JSON.stringify(access.body)).not.toContain('hunter2');
    });

    it('a Room Server read skips the forwarding knobs', async () => {
      const agent = await harness.loginAs(harness.admin);
      await agent.post(readUrl(harness.sourceA, ROOM)).send({ groups: ['adverts'] });
      expect(sentCommands()).toEqual(['ver', 'get advert.interval', 'get flood.advert.interval', 'get af']);
    });

    it('stops at the first timeout', async () => {
      sendCliMock.mockImplementation((pk: string, cmd: string) =>
        cmd === 'get flood.max' ? Promise.reject(new Error('CLI command timed out')) : defaultReply(pk, cmd));
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(readUrl(harness.sourceA)).send({ groups: ['adverts'] });
      expect(res.status).toBe(200);
      expect(res.body.data.stoppedAt).toBe('floodMax');
      expect(sentCommands()).not.toContain('get repeat');
    });
  });

  describe('save', () => {
    it('sends only the patch keys, reads back only those, and logs one redacted history row per set', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.patch(patchUrl(harness.sourceA)).send({ floodMax: 4, guestPassword: 'swordfish' });
      expect(res.status).toBe(200);
      const cmds = sentCommands();
      expect(cmds.filter((c) => c.startsWith('set '))).toHaveLength(2);
      expect(cmds).toContain('set flood.max 4');
      expect(cmds.some((c) => c.startsWith('get ') && !['get flood.max', 'get guest.password'].includes(c))).toBe(false);
      expect(res.body.data.results.floodMax).toMatchObject({ ok: true, changed: true });
      expect(JSON.stringify(res.body)).not.toContain('swordfish');

      await new Promise((r) => setTimeout(r, 20));
      const rows = await harness.db.meshcoreCliHistory.list({ scopes: 'all' });
      const mine = rows.filter((r) => r.targetPublicKey === REPEATER);
      expect(mine).toHaveLength(2);
      expect(mine.map((r) => r.command).join(' ')).not.toContain('swordfish');

      const { logs } = await harness.db.getAuditLogsAsync({ action: 'meshcore_remote_settings_update' });
      expect(logs.length).toBeGreaterThan(0);
      expect(JSON.stringify(logs)).not.toContain('swordfish');
      expect(JSON.stringify(logs)).toContain('[changed]');
    });

    it('stops at the first timeout and marks the rest NOT_SENT, with no retry', async () => {
      sendCliMock.mockImplementation((pk: string, cmd: string) =>
        cmd.startsWith('set flood.max') ? Promise.reject(new Error('CLI command timed out')) : defaultReply(pk, cmd));
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.patch(patchUrl(harness.sourceA)).send({ floodMax: 4, af: 2 });
      expect(res.status).toBe(200);
      const results = res.body.data.results;
      const codes = Object.values(results).map((r) => (r as { code?: string }).code);
      expect(codes).toContain('NOT_SENT');
      expect(sentCommands().filter((c) => c.startsWith('set flood.max'))).toHaveLength(1);
    });
  });

  describe('limits', () => {
    it('refuses with 429 once the per-source budget would be exceeded', async () => {
      const agent = await harness.loginAs(harness.admin);
      let used = 0;
      // adverts = 8 keys (+ ver on the first read)
      while (used + 8 <= REMOTE_SETTINGS_BUDGET_MAX) {
        const res = await agent.post(readUrl(harness.sourceA)).send({ groups: ['adverts'] });
        expect(res.status).toBe(200);
        used += res.body.data.sent;
      }
      const sentBefore = sendCliMock.mock.calls.length;
      const res = await agent.post(readUrl(harness.sourceA)).send({ groups: ['adverts'] });
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('REMOTE_SETTINGS_BUDGET');
      expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
      expect(sendCliMock.mock.calls.length).toBe(sentBefore);
      // The budget is per source.
      expect((await agent.post(readUrl(harness.sourceB)).send({ groups: ['access'] })).status).toBe(200);
    });

    it('allows one operation at a time per target', async () => {
      let release: () => void = () => {};
      sendCliMock.mockImplementationOnce(() => new Promise((resolve) => {
        release = () => resolve({ reply: 'v1.18.0', elapsedMs: 1 });
      }));
      const agent = await harness.loginAs(harness.admin);
      const first = agent.post(readUrl(harness.sourceA)).send({ groups: ['access'] }).then((r) => r);
      await vi.waitFor(() => expect(sendCliMock).toHaveBeenCalledTimes(1));
      const second = await agent.post(readUrl(harness.sourceA)).send({ groups: ['access'] });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('REMOTE_SETTINGS_BUSY');
      // Another target on the same source is not blocked.
      const other = await agent.post(readUrl(harness.sourceA, ROOM)).send({ groups: ['access'] });
      expect(other.status).toBe(200);
      release();
      expect((await first).status).toBe(200);
    });
  });
});
