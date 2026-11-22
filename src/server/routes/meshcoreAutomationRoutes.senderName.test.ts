/**
 * Sender name on timer / responder / announce saves (#6341 P4 WP2): syntax-only
 * validation (an off-list name is accepted), clearing, and the audit row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import automationRoutes from './meshcoreAutomationRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';

const base = (sourceId: string) => `/api/sources/${sourceId}/meshcore/automation`;
const timer = (over: Record<string, unknown> = {}) => ({
  id: 't1', name: 'T', enabled: true, scheduleType: 'interval', intervalMinutes: 60,
  responseType: 'text', response: 'hi', destination: 'channel', channelIndexes: [0], ...over,
});
const responder = (over: Record<string, unknown> = {}) => ({
  id: 'r1', name: 'R', enabled: true, pattern: 'ping', response: 'pong',
  channels: [0], listenDMs: false, replyAsDM: false, cooldownSeconds: 60, ...over,
});

describe('meshcore automation routes: sender name (#6341 P4)', () => {
  let h: RouteTestHarness;
  let audit: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    h = await createRouteTestApp({
      mount: (app) => app.use(
        '/api/sources/:id/meshcore',
        (_req, res, next) => {
          res.locals.meshcoreManager = {
            resetAutoResponderRegexCache: vi.fn(),
            startTimerTriggers: vi.fn().mockResolvedValue(undefined),
            startAutoAnnounce: vi.fn().mockResolvedValue(undefined),
          };
          next();
        },
        automationRoutes,
      ),
    });
    await databaseService.auth.createPermission({
      userId: h.limited.id, resource: 'automation', canRead: true, canWrite: true,
      canViewOnMap: false, sourceId: h.sourceA, grantedAt: Date.now(), grantedBy: null,
    });
    audit = vi.spyOn(databaseService, 'auditLogAsync');
  });
  afterEach(async () => {
    audit.mockRestore();
    await databaseService.settings.deleteSourceSettings(h.sourceA);
    await h.cleanup();
  });

  const sets = () => audit.mock.calls.filter((c) => c[1] === 'meshcore_sender_name_automation_set');

  it('timer: rejects a bad name with 400 and stores nothing', async () => {
    const agent = await h.loginAs(h.limited);
    const res = await agent.post(`${base(h.sourceA)}/timers`).send({ triggers: [timer({ senderName: 'a: b' })] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(await databaseService.settings.getSettingForSource(h.sourceA, 'meshcoreTimerTriggers')).toBeNull();
  });

  it('timer: accepts an off-list name, trims it, audits once, and not again when unchanged', async () => {
    const agent = await h.loginAs(h.limited);
    const url = `${base(h.sourceA)}/timers`;
    expect((await agent.post(url).send({ triggers: [timer({ senderName: '  Alerts Bot ' })] })).status).toBe(200);
    const stored = JSON.parse((await databaseService.settings.getSettingForSource(h.sourceA, 'meshcoreTimerTriggers'))!);
    expect(stored[0].senderName).toBe('Alerts Bot');
    expect(sets()).toHaveLength(1);
    expect(sets()[0][2]).toBe('automation');
    expect(JSON.parse(sets()[0][3] as string)).toMatchObject({ sourceId: h.sourceA, kind: 'timer', senderName: 'Alerts Bot' });
    await agent.post(url).send({ triggers: [timer({ senderName: 'Alerts Bot' })] });
    expect(sets()).toHaveLength(1);
    await agent.post(url).send({ triggers: [timer({ senderName: 'Other' })] });
    expect(sets()).toHaveLength(2);
  });

  it('timer: a blank name clears the field', async () => {
    const agent = await h.loginAs(h.limited);
    const url = `${base(h.sourceA)}/timers`;
    await agent.post(url).send({ triggers: [timer({ senderName: 'Alerts Bot' })] });
    await agent.post(url).send({ triggers: [timer({ senderName: '' })] });
    const stored = JSON.parse((await databaseService.settings.getSettingForSource(h.sourceA, 'meshcoreTimerTriggers'))!);
    expect(stored[0]).not.toHaveProperty('senderName');
  });

  it('responder: syntax 400, accepts and audits a name', async () => {
    const agent = await h.loginAs(h.limited);
    const url = `${base(h.sourceA)}/responder`;
    expect((await agent.post(url).send({ triggers: [responder({ senderName: '#room' })] })).status).toBe(400);
    expect((await agent.post(url).send({ triggers: [responder({ senderName: 'Bot' })] })).status).toBe(200);
    expect(JSON.parse(sets()[0][3] as string)).toMatchObject({ kind: 'responder', senderName: 'Bot' });
  });

  it('announce: GET/POST round trip, bad name 400, clear with empty string', async () => {
    const agent = await h.loginAs(h.limited);
    const url = `${base(h.sourceA)}/announce`;
    expect((await agent.post(url).send({ senderName: 'x'.repeat(40) })).status).toBe(400);
    expect((await agent.post(url).send({ senderName: ' Announcer ' })).status).toBe(200);
    expect((await agent.get(url)).body.data.senderName).toBe('Announcer');
    expect(JSON.parse(sets()[0][3] as string)).toMatchObject({ sourceId: h.sourceA, kind: 'announce', senderName: 'Announcer' });
    expect((await agent.post(url).send({ senderName: '' })).status).toBe(200);
    expect((await agent.get(url)).body.data.senderName).toBe('');
    expect(sets()).toHaveLength(1);
  });
});
