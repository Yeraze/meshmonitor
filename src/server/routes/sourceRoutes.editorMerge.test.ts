/**
 * Saving a source as a non-admin editor (`sources:write`).
 *
 * An editor is shown the config with every credential masked, and saves the
 * whole config back. These tests pin what the server stores:
 *
 *   - a masked field the editor did not touch keeps its stored value,
 *   - a field they changed is written, a field they cleared is cleared,
 *   - a stored credential is never sent to an endpoint it was not stored for,
 *   - list entries are matched by what they are, never by position,
 *   - no save, on this source or another, hands a stored credential back.
 *
 * Real session + auth middleware + permission SQL via createRouteTestApp.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import type { Source } from '../../db/repositories/sources.js';
import { observerBrokerKey } from '../meshcoreConfig.js';
import {
  MeshCoreObserverCredentialStore,
  getMeshCoreObserverCredentialStore,
  setMeshCoreObserverCredentialStoreForTesting,
} from '../services/meshcoreObserverCredentialStore.js';
import {
  maskSourceConfigForEditor,
  maskUrlForEditor,
  mergeSourceConfigOnSave,
  mergeUrlFromEditor,
  splitUrl,
  urlEndpointIdentity,
} from '../utils/sourceConfigRedaction.js';

const registry = vi.hoisted(() => ({
  getManager: vi.fn(),
  getAllManagers: vi.fn().mockReturnValue([]),
  addManager: vi.fn(),
  removeManager: vi.fn(),
  startManager: vi.fn(),
  stopManager: vi.fn(),
  reconfigureObserver: vi.fn().mockResolvedValue(false),
}));

// Non-DB mocks only: nothing here may open a real device or broker connection.
vi.mock('../sourceManagerRegistry.js', () => ({ sourceManagerRegistry: registry }));
vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

const SECRET = 'SECRETSENTINEL';

const IDS = {
  ingest: 'edmerge-ingest',
  ingest2: 'edmerge-ingest-2',
  bridge: 'edmerge-bridge',
  broker: 'edmerge-broker',
  rns: 'edmerge-rns',
  mc: 'edmerge-meshcore',
} as const;

const STORED: Record<keyof typeof IDS, { type: Source['type']; config: Record<string, unknown> }> = {
  ingest: {
    type: 'meshcore_mqtt',
    config: {
      brokerUrl: `mqtts://urluser:${SECRET}-urlpw@broker.example:8883/feed?token=${SECRET}-query`,
      region: 'MCO',
      username: 'ingest-user',
      password: `${SECRET}-ingest`,
      autoConnect: false,
      futureField: `${SECRET}-future`,
    },
  },
  ingest2: {
    type: 'meshcore_mqtt',
    config: { brokerUrl: 'mqtts://other.example:8883', region: 'TPA', autoConnect: false },
  },
  bridge: {
    type: 'mqtt_bridge',
    config: {
      upstream: { url: 'mqtt://upstream.example:1883', username: 'bridge-user', password: `${SECRET}-bridge` },
      subscriptions: ['msh/#'],
    },
  },
  broker: {
    type: 'mqtt_broker',
    config: {
      listener: { port: 47201, host: '0.0.0.0' },
      auth: { username: 'broker-user', password: `${SECRET}-broker` },
      gateway: { nodeNum: 2147483649, nodeId: '!80000001', longName: 'GW', shortName: 'GW' },
      rootTopic: 'msh',
    },
  },
  rns: {
    type: 'reticulum',
    config: { mode: 'attach', configDir: '/rns', token: `${SECRET}-token`, autoConnect: false },
  },
  mc: {
    type: 'meshcore',
    config: {
      transport: 'usb',
      port: '/dev/ttyUSB7',
      deviceType: 'companion',
      autoConnect: false,
      observer: {
        enabled: false,
        iataCode: 'MCO',
        brokers: [
          { url: `wss://a-user:${SECRET}-a@a.example:443/mqtt`, tokenAudience: 'a.example', label: 'A' },
          { url: `wss://b-user:${SECRET}-b@b.example:443/mqtt`, tokenAudience: 'b.example', label: 'B' },
        ],
      },
    },
  },
};

describe('saving a source as a non-admin editor', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    registry.getManager.mockReset().mockReturnValue(null);
    harness = await createRouteTestApp({ mount: (app) => app.use('/', sourceRoutes) });
    for (const key of Object.keys(IDS) as Array<keyof typeof IDS>) {
      await harness.db.sources.deleteSource(IDS[key]).catch(() => {});
      await harness.db.sources.createSource({
        id: IDS[key],
        name: `Editor merge ${key}`,
        type: STORED[key].type,
        config: STORED[key].config,
        // Disabled: no route under test may try to start a manager.
        enabled: false,
      });
    }
    await harness.grant(harness.limited.id, 'sources', 'read');
    await harness.grant(harness.limited.id, 'sources', 'write');
  });

  afterEach(async () => {
    for (const id of Object.values(IDS)) await harness.db.sources.deleteSource(id).catch(() => {});
    await harness.cleanup();
  });

  const editor = () => harness.loginAs(harness.limited);
  const admin = () => harness.loginAs(harness.admin);

  async function stored(id: string): Promise<Record<string, any>> {
    return (await harness.db.sources.getSource(id))!.config as Record<string, any>;
  }

  /** Load as the caller, apply `change` to the config, save, and return the response. */
  async function editAs(
    agent: Awaited<ReturnType<typeof editor>>,
    id: string,
    change: (config: Record<string, any>) => Record<string, any>,
  ) {
    const loaded = (await agent.get(`/${id}`)).body.config as Record<string, any>;
    const res = await agent.put(`/${id}`).send({ config: change(structuredClone(loaded)) });
    return res;
  }

  function expectNoSecret(body: unknown): void {
    expect(JSON.stringify(body)).not.toContain(SECRET);
  }

  describe('a password bound to a broker URL (meshcore_mqtt)', () => {
    it('keeps the stored password and URL credentials when neither is touched', async () => {
      const res = await editAs(await editor(), IDS.ingest, (c) => ({ ...c, region: 'JFK' }));
      expect(res.status).toBe(200);
      expectNoSecret(res.body);
      expect(await stored(IDS.ingest)).toEqual({ ...STORED.ingest.config, region: 'JFK' });
    });

    it('keeps the stored password when the field comes back blank', async () => {
      const res = await editAs(await editor(), IDS.ingest, (c) => ({ ...c, password: '' }));
      expect(res.status).toBe(200);
      expect((await stored(IDS.ingest)).password).toBe(`${SECRET}-ingest`);
    });

    it('writes a new password', async () => {
      const res = await editAs(await editor(), IDS.ingest, (c) => ({ ...c, password: 'typed-by-editor' }));
      expect(res.status).toBe(200);
      expect((await stored(IDS.ingest)).password).toBe('typed-by-editor');
      expect(res.body.config.password).toBeUndefined();
      expect(res.body.maskedConfigFields).toContain('password');
    });

    it('clears the password on an explicit null', async () => {
      const res = await editAs(await editor(), IDS.ingest, (c) => ({ ...c, password: null }));
      expect(res.status).toBe(200);
      expect(await stored(IDS.ingest)).not.toHaveProperty('password');
      expect(res.body.maskedConfigFields).not.toContain('password');
    });

    it('keeps the password when only the path changes', async () => {
      const res = await editAs(await editor(), IDS.ingest, (c) => ({
        ...c,
        brokerUrl: 'mqtts://broker.example:8883/other',
      }));
      expect(res.status).toBe(200);
      const cfg = await stored(IDS.ingest);
      expect(cfg.password).toBe(`${SECRET}-ingest`);
      expect(cfg.brokerUrl).toBe(
        `mqtts://urluser:${SECRET}-urlpw@broker.example:8883/other?token=${SECRET}-query`,
      );
    });

    it.each([
      ['another host', 'mqtts://elsewhere.example:8883/feed'],
      ['another port', 'mqtts://broker.example:8884/feed'],
      ['another scheme', 'mqtt://broker.example:8883/feed'],
    ])('drops every stored credential when the editor points it at %s', async (_what, url) => {
      const agent = await editor();
      const res = await editAs(agent, IDS.ingest, (c) => ({ ...c, brokerUrl: url }));
      expect(res.status).toBe(200);
      expectNoSecret(res.body);

      const cfg = await stored(IDS.ingest);
      expect(cfg.brokerUrl).toBe(url);
      expect(cfg).not.toHaveProperty('password');
      // The username is not a credential: it stays as the editor saved it.
      expect(cfg.username).toBe('ingest-user');

      // Nor does a later read, or pointing it back, bring the credential out.
      expectNoSecret((await agent.get(`/${IDS.ingest}`)).body);
      await editAs(agent, IDS.ingest, (c) => ({ ...c, brokerUrl: 'mqtts://broker.example:8883/feed' }));
      expect(JSON.stringify(await stored(IDS.ingest))).not.toContain(`${SECRET}-ingest`);
      expect(JSON.stringify(await stored(IDS.ingest))).not.toContain(`${SECRET}-urlpw`);
    });

    it('takes a new password together with a new host', async () => {
      const res = await editAs(await editor(), IDS.ingest, (c) => ({
        ...c,
        brokerUrl: 'mqtts://elsewhere.example:8883',
        password: 'for-the-new-host',
      }));
      expect(res.status).toBe(200);
      const cfg = await stored(IDS.ingest);
      expect(cfg.password).toBe('for-the-new-host');
      expect(cfg.brokerUrl).toBe('mqtts://elsewhere.example:8883');
    });

    it('takes new URL credentials, and keeps the hidden query string', async () => {
      const res = await editAs(await editor(), IDS.ingest, (c) => ({
        ...c,
        brokerUrl: 'mqtts://new:creds@broker.example:8883/feed',
      }));
      expect(res.status).toBe(200);
      expect((await stored(IDS.ingest)).brokerUrl).toBe(
        `mqtts://new:creds@broker.example:8883/feed?token=${SECRET}-query`,
      );
    });

    it('clears URL credentials on an explicit empty part', async () => {
      const res = await editAs(await editor(), IDS.ingest, (c) => ({
        ...c,
        brokerUrl: 'mqtts://@broker.example:8883/feed?',
      }));
      expect(res.status).toBe(200);
      const cfg = await stored(IDS.ingest);
      expect(cfg.brokerUrl).toBe('mqtts://broker.example:8883/feed');
      // Same endpoint, so the password field is untouched.
      expect(cfg.password).toBe(`${SECRET}-ingest`);
    });

    it('keeps a stored field the editor is never shown', async () => {
      const agent = await editor();
      expect((await agent.get(`/${IDS.ingest}`)).body.config).not.toHaveProperty('futureField');
      await editAs(agent, IDS.ingest, (c) => ({ ...c, region: 'JFK' }));
      expect((await stored(IDS.ingest)).futureField).toBe(`${SECRET}-future`);
    });

    it('does not carry one source\'s credentials into another source', async () => {
      const agent = await editor();
      const first = (await agent.get(`/${IDS.ingest}`)).body.config as Record<string, any>;
      // Save the first source's masked config, host and all, over the second.
      const res = await agent.put(`/${IDS.ingest2}`).send({ config: { ...first, region: 'TPA' } });
      expect(res.status).toBe(200);
      expectNoSecret(res.body);
      const cfg = await stored(IDS.ingest2);
      expect(JSON.stringify(cfg)).not.toContain(SECRET);
      expect(cfg.brokerUrl).toBe('mqtts://broker.example:8883/feed');
    });

    it('does not let a credential be read back through another field', async () => {
      const agent = await editor();
      // Nothing an editor is given refers to the stored value, so the most they
      // can do is name the field elsewhere — which stores what they typed.
      const res = await editAs(agent, IDS.ingest, (c) => ({ ...c, username: 'password', region: 'password' }));
      expect(res.status).toBe(200);
      expectNoSecret(res.body);
      expectNoSecret((await agent.get('/')).body);
      expect((await stored(IDS.ingest)).username).toBe('password');
    });

    it('an admin keeps the stored password across a host change, as before', async () => {
      const res = await editAs(await admin(), IDS.ingest, (c) => {
        const { password: _blank, ...rest } = c;
        return { ...rest, brokerUrl: 'mqtts://elsewhere.example:8883' };
      });
      expect(res.status).toBe(200);
      const cfg = await stored(IDS.ingest);
      expect(cfg.password).toBe(`${SECRET}-ingest`);
      expect(cfg.brokerUrl).toBe('mqtts://elsewhere.example:8883');
    });
  });

  describe('a nested password (mqtt_bridge upstream)', () => {
    it('keeps the stored password when the editor changes something else', async () => {
      const res = await editAs(await editor(), IDS.bridge, (c) => ({ ...c, subscriptions: ['msh/US/#'] }));
      expect(res.status).toBe(200);
      expectNoSecret(res.body);
      expect(await stored(IDS.bridge)).toEqual({ ...STORED.bridge.config, subscriptions: ['msh/US/#'] });
    });

    it('drops it when the upstream host changes', async () => {
      const res = await editAs(await editor(), IDS.bridge, (c) => ({
        ...c,
        upstream: { ...c.upstream, url: 'mqtt://elsewhere.example:1883' },
      }));
      expect(res.status).toBe(200);
      expect((await stored(IDS.bridge)).upstream).toEqual({
        url: 'mqtt://elsewhere.example:1883',
        username: 'bridge-user',
      });
    });

    it('writes a changed password and clears on null', async () => {
      const agent = await editor();
      await editAs(agent, IDS.bridge, (c) => ({ ...c, upstream: { ...c.upstream, password: 'changed' } }));
      expect((await stored(IDS.bridge)).upstream.password).toBe('changed');
      await editAs(agent, IDS.bridge, (c) => ({ ...c, upstream: { ...c.upstream, password: null } }));
      expect((await stored(IDS.bridge)).upstream).not.toHaveProperty('password');
    });
  });

  describe('a listener password (mqtt_broker)', () => {
    it('keeps the stored password, whatever else changes: it is sent nowhere', async () => {
      const res = await editAs(await editor(), IDS.broker, (c) => ({
        ...c,
        listener: { port: 47202, host: '127.0.0.1' },
        auth: { username: 'renamed' },
      }));
      expect(res.status).toBe(200);
      expectNoSecret(res.body);
      const cfg = await stored(IDS.broker);
      expect(cfg.auth).toEqual({ username: 'renamed', password: `${SECRET}-broker` });
      expect(cfg.listener).toEqual({ port: 47202, host: '127.0.0.1' });
    });

    it('writes a changed password', async () => {
      await editAs(await editor(), IDS.broker, (c) => ({ ...c, auth: { ...c.auth, password: 'changed' } }));
      expect((await stored(IDS.broker)).auth.password).toBe('changed');
    });
  });

  describe('a token (reticulum)', () => {
    it.each(['editor', 'admin'] as const)('%s: a blank token keeps the stored one', async (who) => {
      const agent = who === 'admin' ? await admin() : await editor();
      const res = await editAs(agent, IDS.rns, (c) => {
        const { token: _blank, ...rest } = c;
        return { ...rest, configDir: '/rns2' };
      });
      expect(res.status).toBe(200);
      expect(await stored(IDS.rns)).toEqual({ ...STORED.rns.config, configDir: '/rns2' });
    });

    it('is never shown to an editor', async () => {
      const agent = await editor();
      const body = (await agent.get(`/${IDS.rns}`)).body;
      expectNoSecret(body);
      expect(body.maskedConfigFields).toEqual(['token']);
    });

    it('keeps the token when the editor writes out the default bridge URL', async () => {
      await editAs(await editor(), IDS.rns, (c) => ({ ...c, bridgeUrl: 'ws://127.0.0.1:8765' }));
      expect((await stored(IDS.rns)).token).toBe(`${SECRET}-token`);
    });

    it('drops the token when the editor points the bridge elsewhere', async () => {
      const res = await editAs(await editor(), IDS.rns, (c) => ({ ...c, bridgeUrl: 'ws://elsewhere.example:8765' }));
      expect(res.status).toBe(200);
      expectNoSecret(res.body);
      expect(await stored(IDS.rns)).not.toHaveProperty('token');
    });

    it('writes a new token and clears on null', async () => {
      const agent = await editor();
      await editAs(agent, IDS.rns, (c) => ({ ...c, token: 'changed' }));
      expect((await stored(IDS.rns)).token).toBe('changed');
      await editAs(agent, IDS.rns, (c) => ({ ...c, token: null }));
      expect(await stored(IDS.rns)).not.toHaveProperty('token');
    });
  });

  describe('a list of brokers (meshcore observer)', () => {
    const urlA = `wss://a-user:${SECRET}-a@a.example:443/mqtt`;
    const urlB = `wss://b-user:${SECRET}-b@b.example:443/mqtt`;
    const brokerUrls = async () =>
      ((await stored(IDS.mc)).observer.brokers as Array<{ url: string }>).map((b) => b.url);

    it('shows the editor each broker without its credentials', async () => {
      const body = (await (await editor()).get(`/${IDS.mc}`)).body;
      expectNoSecret(body);
      expect(body.config.observer.brokers.map((b: { url: string }) => b.url)).toEqual([
        'wss://a.example:443/mqtt',
        'wss://b.example:443/mqtt',
      ]);
    });

    it('keeps each broker\'s own credentials when the list is reordered', async () => {
      const res = await editAs(await editor(), IDS.mc, (c) => ({
        ...c,
        observer: { ...c.observer, brokers: [...c.observer.brokers].reverse() },
      }));
      expect(res.status).toBe(200);
      expectNoSecret(res.body);
      expect(await brokerUrls()).toEqual([urlB, urlA]);
    });

    it('keeps the remaining broker\'s own credentials when the first is removed', async () => {
      const res = await editAs(await editor(), IDS.mc, (c) => ({
        ...c,
        observer: { ...c.observer, brokers: c.observer.brokers.slice(1) },
      }));
      expect(res.status).toBe(200);
      expect(await brokerUrls()).toEqual([urlB]);
    });

    it('gives a broker put in another\'s place none of its credentials', async () => {
      const res = await editAs(await editor(), IDS.mc, (c) => ({
        ...c,
        observer: {
          ...c.observer,
          brokers: [{ ...c.observer.brokers[0], url: 'wss://elsewhere.example:443/mqtt' }, c.observer.brokers[1]],
        },
      }));
      expect(res.status).toBe(200);
      expect(await brokerUrls()).toEqual(['wss://elsewhere.example:443/mqtt', urlB]);
    });

    it('gives a new broker inserted at the front no stored credentials', async () => {
      const res = await editAs(await editor(), IDS.mc, (c) => ({
        ...c,
        observer: {
          ...c.observer,
          brokers: [{ url: 'wss://new.example:443/mqtt', tokenAudience: 'new.example' }, ...c.observer.brokers],
        },
      }));
      expect(res.status).toBe(200);
      expect(await brokerUrls()).toEqual(['wss://new.example:443/mqtt', urlA, urlB]);
    });

    it('takes credentials the editor types for one broker, leaving the other alone', async () => {
      const res = await editAs(await editor(), IDS.mc, (c) => ({
        ...c,
        observer: {
          ...c.observer,
          brokers: [{ ...c.observer.brokers[0], url: 'wss://typed:creds@a.example:443/mqtt' }, c.observer.brokers[1]],
        },
      }));
      expect(res.status).toBe(200);
      expect(await brokerUrls()).toEqual(['wss://typed:creds@a.example:443/mqtt', urlB]);
    });
  });

  describe('the Observer\'s stored broker login', () => {
    // The single (pre-#5014) login is used for whichever broker
    // `observer.brokerUrl` names, so it must not follow an editor's change.
    const withLegacyBroker = async () => {
      await harness.db.sources.updateSource(IDS.mc, {
        config: {
          ...STORED.mc.config,
          observer: { enabled: false, iataCode: 'MCO', authMode: 'password', brokerUrl: 'wss://legacy.example:443/mqtt' },
        },
      });
    };

    beforeEach(() => {
      setMeshCoreObserverCredentialStoreForTesting(new MeshCoreObserverCredentialStore('test-secret', true));
    });
    afterEach(() => setMeshCoreObserverCredentialStoreForTesting(null));

    const repoint = (c: Record<string, any>) => ({
      ...c,
      observer: { ...c.observer, brokerUrl: 'wss://elsewhere.example:443/mqtt' },
    });

    it('lets an editor change the broker when no login is stored', async () => {
      await withLegacyBroker();
      const res = await editAs(await editor(), IDS.mc, repoint);
      expect(res.status).toBe(200);
      expect((await stored(IDS.mc)).observer.brokerUrl).toBe('wss://elsewhere.example:443/mqtt');
    });

    it('refuses an editor\'s change of broker while a login is stored', async () => {
      await withLegacyBroker();
      await getMeshCoreObserverCredentialStore().store(IDS.mc, 'legacy-user', `${SECRET}-legacy`);

      const res = await editAs(await editor(), IDS.mc, repoint);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('OBSERVER_CREDENTIALS_STORED');
      expectNoSecret(res.body);
      expect((await stored(IDS.mc)).observer.brokerUrl).toBe('wss://legacy.example:443/mqtt');

      // Another path on the same host is the same broker.
      const samePlace = await editAs(await editor(), IDS.mc, (c) => ({
        ...c,
        observer: { ...c.observer, brokerUrl: 'wss://legacy.example:443/other' },
      }));
      expect(samePlace.status).toBe(200);
    });

    it('leaves an admin free to change it', async () => {
      await withLegacyBroker();
      await getMeshCoreObserverCredentialStore().store(IDS.mc, 'legacy-user', `${SECRET}-legacy`);
      const res = await editAs(await admin(), IDS.mc, repoint);
      expect(res.status).toBe(200);
    });
  });

  it.each([
    ['a backslash, which ws/wss parsers read as the end of the host', 'mqtts://elsewhere.example\\@broker.example:8883/feed'],
    ['a percent-escaped host', 'mqtts://broker.exampl%65:8883/feed'],
    ['a tab inside the host', 'mqtts://broker.\texample:8883/feed'],
  ])('drops stored credentials for a URL holding %s', async (_what, url) => {
    const res = await editAs(await editor(), IDS.ingest, (c) => ({ ...c, brokerUrl: url }));
    expect(res.status).toBe(200);
    const cfg = await stored(IDS.ingest);
    expect(cfg).not.toHaveProperty('password');
    expect(JSON.stringify(cfg)).not.toContain(`${SECRET}-urlpw`);
  });

  it('leaves a per-broker Observer login behind when its broker is pointed elsewhere', async () => {
    const store = new MeshCoreObserverCredentialStore('test-secret', true);
    setMeshCoreObserverCredentialStoreForTesting(store);
    try {
      const oldKey = observerBrokerKey(`wss://a-user:${SECRET}-a@a.example:443/mqtt`);
      await store.storeForBroker(IDS.mc, oldKey, 'a-login', `${SECRET}-a-login`);
      const res = await editAs(await editor(), IDS.mc, (c) => ({
        ...c,
        observer: {
          ...c.observer,
          brokers: [{ ...c.observer.brokers[0], url: 'wss://elsewhere.example:443/mqtt' }, c.observer.brokers[1]],
        },
      }));
      expect(res.status).toBe(200);
      // Logins are stored per broker key; the new broker has none.
      expect((await store.loadForBroker(IDS.mc, observerBrokerKey('wss://elsewhere.example:443/mqtt'))).kind).toBe('none');
      expect((await store.loadForBroker(IDS.mc, oldKey)).kind).toBe('ok');
    } finally {
      setMeshCoreObserverCredentialStoreForTesting(null);
    }
  });

  it.each([[['x']], [null], ['text']])('refuses a config that is not an object: %j', async (bad) => {
    const res = await (await editor()).put(`/${IDS.ingest}`).send({ config: bad });
    expect(res.status).toBe(400);
    expect(await stored(IDS.ingest)).toEqual(STORED.ingest.config);
  });
});

describe('URL masking and merge', () => {
  it('splits a URL without normalizing it', () => {
    expect(splitUrl('wss://u:p@Host:443/mqtt?x=1#f')).toEqual({
      scheme: 'wss://',
      userinfo: 'u:p',
      hostport: 'Host:443',
      path: '/mqtt',
      query: '?x=1',
      fragment: '#f',
    });
    expect(splitUrl('host:1883')).toEqual({
      scheme: '',
      userinfo: null,
      hostport: 'host:1883',
      path: '',
      query: null,
      fragment: null,
    });
  });

  it('takes the last @ as the end of the credentials: a password may hold one', () => {
    expect(splitUrl('mqtt://u:p@ss@host')?.userinfo).toBe('u:p@ss');
    expect(maskUrlForEditor('mqtt://u:p@ss@host')).toEqual({ url: 'mqtt://host', masked: true });
  });

  it('masks a bare host:port with credentials', () => {
    expect(maskUrlForEditor('u:p@host:1883')).toEqual({ url: 'host:1883', masked: true });
  });

  it('reports a plain URL as not masked', () => {
    expect(maskUrlForEditor('mqtt://host:1883/x')).toEqual({ url: 'mqtt://host:1883/x', masked: false });
  });

  it.each(['mqtt://u:pa/ss@host', 'mqtt://u:pa?ss@host', 'mqtt://u:pa#ss@host', 'mqtt://host/pa@th'])(
    'withholds a URL whole when its credentials cannot be told apart: %s',
    (url) => {
      expect(splitUrl(url)).toBeNull();
      expect(maskUrlForEditor(url)).toEqual({ url: undefined, masked: true });
      // Left blank, it is kept; anything typed replaces it whole.
      expect(mergeUrlFromEditor(url, undefined)).toBe(url);
      expect(mergeUrlFromEditor(url, '')).toBe(url);
      expect(mergeUrlFromEditor(url, 'mqtt://host')).toBe('mqtt://host');
    },
  );

  it('compares endpoints by scheme, host and port, ignoring case and path', () => {
    expect(urlEndpointIdentity('WSS://u:p@Host:443/a?b')).toBe(urlEndpointIdentity('wss://host:443/c'));
    expect(urlEndpointIdentity('wss://host:443')).not.toBe(urlEndpointIdentity('ws://host:443'));
    expect(urlEndpointIdentity('wss://host:443')).not.toBe(urlEndpointIdentity('wss://host:444'));
    // A default port written out reads as a change: the safe direction.
    expect(urlEndpointIdentity('mqtt://host')).not.toBe(urlEndpointIdentity('mqtt://host:1883'));
  });

  it('keeps hidden parts for a host it has no identity for, when the text is the same', () => {
    const stored = 'mqtts://u:p@b\u00fccher.example:8883/feed';
    expect(urlEndpointIdentity(stored)).toBeNull();
    expect(mergeUrlFromEditor(stored, 'mqtts://b\u00fccher.example:8883/feed')).toBe(stored);
    expect(mergeUrlFromEditor(stored, 'mqtts://B\u00fccher.example:8883/feed')).toBe(
      'mqtts://B\u00fccher.example:8883/feed',
    );
  });

  it('merges each hidden part on its own', () => {
    const stored = 'wss://u:p@host/mqtt?t=1#f';
    expect(mergeUrlFromEditor(stored, 'wss://host/mqtt')).toBe(stored);
    expect(mergeUrlFromEditor(stored, 'wss://@host/mqtt')).toBe('wss://host/mqtt?t=1#f');
    expect(mergeUrlFromEditor(stored, 'wss://host/mqtt?')).toBe('wss://u:p@host/mqtt#f');
    expect(mergeUrlFromEditor(stored, 'wss://host/mqtt#')).toBe('wss://u:p@host/mqtt?t=1');
    expect(mergeUrlFromEditor(stored, 'wss://n:w@host/mqtt?t=2')).toBe('wss://n:w@host/mqtt?t=2#f');
    expect(mergeUrlFromEditor(stored, 'wss://other/mqtt')).toBe('wss://other/mqtt');
    expect(mergeUrlFromEditor(undefined, 'wss://host/mqtt')).toBe('wss://host/mqtt');
  });
});

describe('mergeSourceConfigOnSave', () => {
  it('passes a config of an unknown source type through untouched', () => {
    expect(mergeSourceConfigOnSave('some_new_type', { password: 'stored' }, { a: 1 }, 'editor')).toEqual({ a: 1 });
  });

  it('removes a block the save leaves out, secret included', () => {
    const merged = mergeSourceConfigOnSave(
      'mqtt_broker',
      { auth: { username: 'u', password: 'stored' }, rootTopic: 'msh' },
      { rootTopic: 'msh' },
      'editor',
    );
    expect(merged).toEqual({ rootTopic: 'msh' });
  });

  it('does not match a list entry when two stored entries share its identity', () => {
    const stored = {
      observer: {
        brokers: [{ url: 'wss://one:1@host/mqtt' }, { url: 'wss://two:2@host/mqtt' }],
      },
    };
    const merged = mergeSourceConfigOnSave(
      'meshcore',
      stored,
      { observer: { brokers: [{ url: 'wss://host/mqtt' }] } },
      'editor',
    );
    expect(merged).toEqual({ observer: { brokers: [{ url: 'wss://host/mqtt' }] } });
  });

  it('an admin save is taken as sent, apart from blank credentials', () => {
    const merged = mergeSourceConfigOnSave(
      'meshcore_mqtt',
      { brokerUrl: 'mqtts://u:p@host', region: 'MCO', password: 'stored', futureField: 'x' },
      { brokerUrl: 'mqtts://host', region: 'MCO', password: '' },
      'admin',
    );
    expect(merged).toEqual({ brokerUrl: 'mqtts://host', region: 'MCO', password: 'stored' });
  });

  it('masks nothing it cannot classify into the open', () => {
    const { config, masked } = maskSourceConfigForEditor('meshcore_mqtt', {
      brokerUrl: 'mqtts://host',
      region: 'MCO',
      password: 'p',
      apiKey: 'k',
      surprise: { token: 't' },
    });
    expect(config).toEqual({ brokerUrl: 'mqtts://host', region: 'MCO' });
    expect(masked).toEqual(['password']);
  });
});
