/**
 * Saved MQTT broker presets (#5794): the CRUD routes, who sees a preset's
 * login, and the server-side fill on an mqtt_bridge save.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mqttBrokerPresetRoutes from './mqttBrokerPresetRoutes.js';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    startManager: vi.fn(),
    stopManager: vi.fn(),
    removeManager: vi.fn(),
    addManager: vi.fn(),
    getAllManagers: vi.fn().mockReturnValue([]),
  },
}));
vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

const FLORIDA = {
  name: 'Florida Mesh Broker',
  host: 'broker.fl-mesh.org',
  port: 1883,
  tls: false,
  username: 'fluser',
  password: 'flpass',
  rootTopic: 'msh/US/FL',
};

const BRIDGE_ID = 'rt-preset-bridge';

describe('mqtt broker preset routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => {
        app.use('/mqtt-broker-presets', mqttBrokerPresetRoutes);
        app.use('/sources', sourceRoutes);
      },
    });
    for (const p of await harness.db.mqttBrokerPresets.listAsync()) await harness.db.mqttBrokerPresets.deleteAsync(p.id);
  });

  afterEach(async () => {
    await harness.db.sources.deleteSource(BRIDGE_ID).catch(() => {});
    await harness.cleanup();
  });

  async function createAsAdmin(body: Record<string, unknown> = FLORIDA) {
    const admin = await harness.loginAs(harness.admin);
    return admin.post('/mqtt-broker-presets').send(body);
  }

  it('lets an admin create, list with the login, edit, and delete', async () => {
    const admin = await harness.loginAs(harness.admin);
    const created = await createAsAdmin();
    expect(created.status).toBe(200);
    const id = created.body.data.id;
    expect(created.body.data).toMatchObject({ ...FLORIDA, hasUsername: true, hasPassword: true });

    const list = await admin.get('/mqtt-broker-presets');
    expect(list.body.data.canManage).toBe(true);
    expect(list.body.data.presets).toEqual([expect.objectContaining({ id, username: 'fluser', password: 'flpass' })]);

    // A missing password keeps the stored one; a rename is just a new name.
    const renamed = await admin.put(`/mqtt-broker-presets/${id}`).send({ ...FLORIDA, name: 'FL', password: undefined });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data).toMatchObject({ name: 'FL', password: 'flpass' });

    const cleared = await admin.put(`/mqtt-broker-presets/${id}`).send({ ...FLORIDA, name: 'FL', password: null });
    expect(cleared.body.data.password).toBeNull();

    expect((await admin.delete(`/mqtt-broker-presets/${id}`)).status).toBe(200);
    expect((await admin.delete(`/mqtt-broker-presets/${id}`)).status).toBe(404);
  });

  it('refuses a duplicate name, case-insensitively', async () => {
    await createAsAdmin();
    const dup = await createAsAdmin({ ...FLORIDA, name: 'florida mesh broker' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('BROKER_PRESET_NAME_TAKEN');
  });

  it.each([
    [{ ...FLORIDA, name: '' }, 'name'],
    [{ ...FLORIDA, host: 'mqtt://broker.fl-mesh.org' }, 'host'],
    [{ ...FLORIDA, host: 'broker.fl-mesh.org:1883' }, 'host'],
    [{ ...FLORIDA, port: 70000 }, 'port'],
    [{ ...FLORIDA, tls: 'yes' }, 'tls'],
    [{ ...FLORIDA, rootTopic: 'msh/#' }, 'rootTopic'],
  ])('rejects an invalid body (%#: %s)', async (body, field) => {
    const res = await createAsAdmin(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.error).toContain(field);
  });

  it('strips a trailing slash from the root topic and lowercases the host', async () => {
    const res = await createAsAdmin({ ...FLORIDA, host: 'Broker.FL-Mesh.org', rootTopic: 'msh/US/FL/' });
    expect(res.body.data).toMatchObject({ host: 'broker.fl-mesh.org', rootTopic: 'msh/US/FL' });
  });

  it('shows a non-admin editor the preset without its login, and no write access', async () => {
    const { body } = await createAsAdmin();
    const id = body.data.id;
    await harness.grant(harness.limited.id, 'sources', 'write', harness.sourceA);
    const editor = await harness.loginAs(harness.limited);

    const list = await editor.get('/mqtt-broker-presets');
    expect(list.status).toBe(200);
    expect(list.body.data.canManage).toBe(false);
    const [preset] = list.body.data.presets;
    expect(preset).toEqual({
      id,
      name: FLORIDA.name,
      host: FLORIDA.host,
      port: 1883,
      tls: false,
      rootTopic: 'msh/US/FL',
      hasUsername: true,
      hasPassword: true,
    });
    expect(JSON.stringify(list.body)).not.toContain('flpass');

    expect((await editor.post('/mqtt-broker-presets').send({ ...FLORIDA, name: 'x' })).status).toBe(403);
    expect((await editor.put(`/mqtt-broker-presets/${id}`).send(FLORIDA)).status).toBe(403);
    expect((await editor.delete(`/mqtt-broker-presets/${id}`)).status).toBe(403);
  });

  it('lets a configuration:write holder read presets too', async () => {
    await createAsAdmin();
    await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
    const editor = await harness.loginAs(harness.limited);
    expect((await editor.get('/mqtt-broker-presets')).status).toBe(200);
  });

  it('refuses the list to a user who can edit nothing, and to anonymous', async () => {
    await createAsAdmin();
    await harness.grant(harness.limited.id, 'sources', 'read', harness.sourceA);
    const reader = await harness.loginAs(harness.limited);
    expect((await reader.get('/mqtt-broker-presets')).status).toBe(403);
    const anon = await harness.loginAs(null);
    expect((await anon.get('/mqtt-broker-presets')).status).toBe(401);
  });

  describe('bridge save fills a hidden login', () => {
    async function seedBridge(upstream: Record<string, unknown>) {
      await harness.db.sources.deleteSource(BRIDGE_ID).catch(() => {});
      await harness.db.sources.createSource({
        id: BRIDGE_ID,
        name: 'Preset bridge',
        type: 'mqtt_bridge',
        config: { upstream, subscriptions: ['msh/#'] },
        enabled: false,
      });
    }

    async function editorAgent() {
      await harness.grant(harness.limited.id, 'sources', 'write');
      await harness.grant(harness.limited.id, 'sources', 'read');
      return harness.loginAs(harness.limited);
    }

    it('copies the preset login into the stored config and drops the id', async () => {
      const { body } = await createAsAdmin();
      await seedBridge({ url: 'mqtt://old.example.org:1883' });
      const editor = await editorAgent();

      const res = await editor.put(`/sources/${BRIDGE_ID}`).send({
        config: {
          upstream: { url: 'mqtt://broker.fl-mesh.org:1883', brokerPresetId: body.data.id },
          subscriptions: ['msh/US/FL/#'],
        },
      });
      expect(res.status).toBe(200);
      const stored = await harness.db.sources.getSource(BRIDGE_ID);
      expect((stored!.config as any).upstream).toEqual({
        url: 'mqtt://broker.fl-mesh.org:1883',
        username: 'fluser',
        password: 'flpass',
      });
      // The editor is not shown the login it just saved.
      expect(JSON.stringify(res.body)).not.toContain('flpass');
    });

    it('keeps a password the editor typed', async () => {
      const { body } = await createAsAdmin();
      await seedBridge({ url: 'mqtt://old.example.org:1883' });
      const editor = await editorAgent();
      await editor.put(`/sources/${BRIDGE_ID}`).send({
        config: {
          upstream: { url: 'mqtt://broker.fl-mesh.org:1883', password: 'mine', brokerPresetId: body.data.id },
        },
      });
      const stored = await harness.db.sources.getSource(BRIDGE_ID);
      expect((stored!.config as any).upstream).toMatchObject({ username: 'fluser', password: 'mine' });
    });

    it('refuses the fill when the URL points somewhere else', async () => {
      const { body } = await createAsAdmin();
      await seedBridge({ url: 'mqtt://old.example.org:1883' });
      const editor = await editorAgent();
      const res = await editor.put(`/sources/${BRIDGE_ID}`).send({
        config: { upstream: { url: 'mqtt://attacker.example.org:1883', brokerPresetId: body.data.id } },
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BROKER_PRESET_ENDPOINT_MISMATCH');
      const stored = await harness.db.sources.getSource(BRIDGE_ID);
      expect((stored!.config as any).upstream.url).toBe('mqtt://old.example.org:1883');
    });

    it('refuses a deleted preset, and a TLS mismatch', async () => {
      const { body } = await createAsAdmin();
      await seedBridge({ url: 'mqtt://old.example.org:1883' });
      const editor = await editorAgent();
      const tls = await editor.put(`/sources/${BRIDGE_ID}`).send({
        config: { upstream: { url: 'mqtts://broker.fl-mesh.org:1883', brokerPresetId: body.data.id } },
      });
      expect(tls.body.code).toBe('BROKER_PRESET_ENDPOINT_MISMATCH');

      await harness.db.mqttBrokerPresets.deleteAsync(body.data.id);
      const gone = await editor.put(`/sources/${BRIDGE_ID}`).send({
        config: { upstream: { url: 'mqtt://broker.fl-mesh.org:1883', brokerPresetId: body.data.id } },
      });
      expect(gone.status).toBe(404);
      expect(gone.body.code).toBe('BROKER_PRESET_NOT_FOUND');
    });
  });
});
