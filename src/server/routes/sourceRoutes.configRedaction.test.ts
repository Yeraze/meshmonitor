/**
 * What each kind of caller may read from a source's `config`.
 *
 * One source of EVERY type is stored with every credential-like and
 * endpoint-like field set to a sentinel string. Each route that returns a
 * source row is then fetched as each kind of caller, and the serialized body is
 * searched for sentinels that caller must not see.
 *
 * The fixture is tied to the allowlist in utils/sourceConfigRedaction.ts:
 *
 *   - a new source type does not compile until it has a fixture here and a
 *     spec there (both are `Record`s over `Source['type']`),
 *   - a field classified in the spec but missing from the fixture fails
 *     "fixture covers every classified field",
 *   - a field in the fixture that the spec does not classify fails
 *     "fixture holds no unclassified field" — so adding a field to a fixture is
 *     not a way round classifying it.
 *
 * Real session + auth middleware + permission SQL via createRouteTestApp.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import type { Source } from '../../db/repositories/sources.js';
import {
  SOURCE_CONFIG_SPECS,
  classifiedFieldPaths,
  projectSourceConfig,
  redactEndpointUrl,
} from '../utils/sourceConfigRedaction.js';

const registry = vi.hoisted(() => ({
  getManager: vi.fn(),
  getAllManagers: vi.fn().mockReturnValue([]),
  addManager: vi.fn(),
  removeManager: vi.fn(),
  startManager: vi.fn(),
  stopManager: vi.fn(),
}));

// Non-DB mocks only: nothing here may open a real device or broker connection.
vi.mock('../sourceManagerRegistry.js', () => ({ sourceManagerRegistry: registry }));
vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

// ---------------------------------------------------------------------------
// Sentinels. The prefix says who may see the value.
// ---------------------------------------------------------------------------

/** Observer key material: never leaves the process, admins included. */
const KEY = 'KEYSENTINEL';
/** Passwords: admin only. */
const PW = 'PWSENTINEL';
/** Usernames, tokens, URL credentials, unneeded and unclassified fields: no viewer. */
const PRIV = 'PRIVSENTINEL';
/** Connection endpoints: signed-in `sources:read` and up. */
const EP = 'EPSENTINEL';

/** Ports are numbers, so they get distinctive values instead of a prefix. */
const ENDPOINT_PORTS = [47101, 47102, 47103, 47104, 47105, 47106];

const url = (scheme: string, tag: string) =>
  `${scheme}://${PRIV}-user-${tag}:${PRIV}-urlpw-${tag}@${EP}-${tag}.example:8883/path?token=${PRIV}-query-${tag}#${PRIV}-frag-${tag}`;

/** Stored on every fixture: a field no spec knows about. */
const UNCLASSIFIED = 'futureField';

const FIXTURES: Record<Source['type'], Record<string, unknown>> = {
  meshtastic_tcp: {
    host: `${EP}-mt-host`,
    port: ENDPOINT_PORTS[0],
    heartbeatIntervalSeconds: 30,
    virtualNode: { enabled: true, port: ENDPOINT_PORTS[1], allowAdminCommands: true },
    mqttLink: { enabled: true, mqttBrokerSourceId: 'cfgred-mqtt_broker' },
    passiveMode: true,
    passiveResyncStaleMs: 60000,
    autoConnect: false,
    [UNCLASSIFIED]: `${PRIV}-future-mt`,
  },
  meshcore: {
    transport: 'tcp',
    port: `${EP}-mc-legacy-serial`,
    serialPort: `${EP}-mc-serial`,
    baudRate: 115200,
    tcpHost: `${EP}-mc-host`,
    tcpPort: ENDPOINT_PORTS[2],
    deviceType: 'companion',
    autoConnect: false,
    heartbeatIntervalSeconds: 30,
    virtualNode: {
      enabled: true,
      port: ENDPOINT_PORTS[3],
      allowAdminCommands: true,
      allowPkiExport: true,
      allowPkiImport: true,
    },
    observer: {
      enabled: true,
      authMode: 'password',
      brokerUrl: url('mqtts', 'obs-legacy'),
      iataCode: `${EP}-iata`,
      tokenAudience: `${PRIV}-audience`,
      privateKey: `${KEY}-observer-private`,
      brokers: [
        {
          url: url('wss', 'obs-broker'),
          authMode: 'password',
          tokenAudience: `${PRIV}-broker-audience`,
          label: `${EP}-broker-label`,
          password: `${KEY}-broker-password`,
        },
      ],
    },
    [UNCLASSIFIED]: `${PRIV}-future-mc`,
  },
  meshcore_mqtt: {
    brokerUrl: url('mqtts', 'ingest'),
    region: 'MCO',
    username: `${PRIV}-ingest-user`,
    password: `${PW}-ingest`,
    rejectUnauthorized: false,
    autoConnect: false,
    [UNCLASSIFIED]: `${PRIV}-future-ingest`,
  },
  mqtt_bridge: {
    brokerSourceId: 'cfgred-mqtt_broker',
    upstream: {
      url: url('mqtt', 'bridge'),
      username: `${PRIV}-bridge-user`,
      password: `${PW}-bridge`,
    },
    subscriptions: [`${EP}-topic/#`],
    mode: 'bidirectional',
    downlinkFilters: { geo: { minLat: 1 }, note: `${PRIV}-downlink-filter` },
    uplinkFilters: { note: `${PRIV}-uplink-filter` },
    downlinkTopicRewrite: { from: `${PRIV}-rewrite-from`, to: `${PRIV}-rewrite-to` },
    uplinkTopicRewrite: { from: `${PRIV}-up-from`, to: `${PRIV}-up-to` },
    forwardingMode: 'per_gateway',
    ignoreOkToMqtt: true,
    dropAutomationUplinks: true,
    autoConnect: false,
    [UNCLASSIFIED]: `${PRIV}-future-bridge`,
  },
  mqtt_broker: {
    listener: { port: ENDPOINT_PORTS[4], host: `${EP}-listener-host` },
    auth: { username: `${PRIV}-broker-user`, password: `${PW}-broker` },
    gateway: { nodeNum: 123456, nodeId: '!0001e240', longName: `${PRIV}-gw-long`, shortName: 'GW' },
    rootTopic: `${EP}-root-topic`,
    zeroHopInjection: true,
    downlinkHopLimitOverride: 0,
    hopLimitPolicy: { note: `${PRIV}-hop-policy` },
    autoConnect: false,
    // Legacy top-level credential names the old denylist knew about.
    password: `${PW}-legacy-top`,
    apiKey: `${PW}-legacy-apikey`,
    [UNCLASSIFIED]: `${PRIV}-future-broker`,
  },
  reticulum: {
    mode: 'tcp_peer',
    bridgeUrl: url('ws', 'rns-bridge'),
    token: `${PRIV}-rns-token`,
    autoConnect: false,
    configDir: `${PRIV}-rns-config-dir`,
    peers: [{ host: `${EP}-rns-peer`, port: ENDPOINT_PORTS[5] }],
    device: `${EP}-rns-device`,
    frequency: 915000000,
    bandwidth: 125000,
    spreadingFactor: 8,
    codingRate: 5,
    txPower: 17,
    stAlock: 10,
    ltAlock: 5,
    remoteAllowed: [`${PRIV}-remote-identity`],
    [UNCLASSIFIED]: `${PRIV}-future-rns`,
  },
};

/** Fields the fixtures carry on purpose that no spec classifies. */
const DELIBERATELY_UNCLASSIFIED: Record<Source['type'], string[]> = {
  meshtastic_tcp: [UNCLASSIFIED],
  // Key material: removed for every caller before the allowlist is consulted.
  meshcore: [UNCLASSIFIED, 'observer.privateKey', 'observer.brokers.password'],
  meshcore_mqtt: [UNCLASSIFIED],
  mqtt_bridge: [UNCLASSIFIED],
  mqtt_broker: [UNCLASSIFIED, 'password', 'apiKey'],
  reticulum: [UNCLASSIFIED],
};

const TYPES = Object.keys(FIXTURES) as Array<Source['type']>;
const idFor = (type: Source['type']) => `cfgred-${type}`;

/** Dotted paths present in a fixture; a list contributes its first entry's keys. */
function fixturePaths(value: unknown, prefix = ''): string[] {
  const target = Array.isArray(value) ? value[0] : value;
  if (!target || typeof target !== 'object') return [];
  return Object.entries(target as Record<string, unknown>).flatMap(([key, child]) => [
    `${prefix}${key}`,
    ...fixturePaths(child, `${prefix}${key}.`),
  ]);
}

// ---------------------------------------------------------------------------
// Callers
// ---------------------------------------------------------------------------

type Caller = 'anonymous' | 'anonymousWithRead' | 'limited' | 'viewer' | 'editor' | 'admin';
const CALLERS: Caller[] = ['anonymous', 'anonymousWithRead', 'limited', 'viewer', 'editor', 'admin'];

/** Which sentinel families each caller must never receive. */
const FORBIDDEN: Record<Caller, string[]> = {
  anonymous: [KEY, PW, PRIV, EP],
  // `sources:read` granted to the anonymous account buys nothing: no login,
  // no endpoint.
  anonymousWithRead: [KEY, PW, PRIV, EP],
  limited: [KEY, PW, PRIV, EP],
  viewer: [KEY, PW, PRIV],
  // An editor saves the whole config back, so gets it all bar the passwords.
  editor: [KEY, PW],
  admin: [KEY],
};

const seesEndpoints = (caller: Caller) => !FORBIDDEN[caller].includes(EP);

function expectNoForbidden(body: unknown, caller: Caller, where: string): void {
  const text = JSON.stringify(body);
  for (const family of FORBIDDEN[caller]) {
    expect(text, `${where} as ${caller}: must not contain a ${family} value`).not.toContain(family);
  }
  if (!seesEndpoints(caller)) {
    for (const port of ENDPOINT_PORTS) {
      expect(text, `${where} as ${caller}: must not contain port ${port}`).not.toMatch(
        new RegExp(`(?<!\\d)${port}(?!\\d)`),
      );
    }
  }
}

describe('source config redaction', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    registry.getManager.mockReset().mockReturnValue(null);
    harness = await createRouteTestApp({ mount: (app) => app.use('/', sourceRoutes) });
    for (const type of TYPES) {
      await harness.db.sources.deleteSource(idFor(type)).catch(() => {});
      await harness.db.sources.createSource({
        id: idFor(type),
        name: `Redaction ${type}`,
        type,
        config: FIXTURES[type],
        // Disabled: no route under test may try to start a manager.
        enabled: false,
      });
    }
  });

  afterEach(async () => {
    for (const type of TYPES) await harness.db.sources.deleteSource(idFor(type)).catch(() => {});
    await harness.revokeAll(harness.anonymous.id);
    await harness.cleanup();
  });

  async function agentFor(caller: Caller) {
    await harness.revokeAll(harness.limited.id);
    await harness.revokeAll(harness.anonymous.id);
    switch (caller) {
      case 'anonymous':
        return harness.loginAs(null);
      case 'anonymousWithRead':
        await harness.grant(harness.anonymous.id, 'sources', 'read');
        return harness.loginAs(null);
      case 'limited':
        return harness.loginAs(harness.limited);
      case 'viewer':
        await harness.grant(harness.limited.id, 'sources', 'read');
        return harness.loginAs(harness.limited);
      case 'editor':
        await harness.grant(harness.limited.id, 'sources', 'read');
        await harness.grant(harness.limited.id, 'sources', 'write');
        return harness.loginAs(harness.limited);
      case 'admin':
        return harness.loginAs(harness.admin);
    }
  }

  const ours = (rows: Array<{ id: string }>) => rows.filter((r) => r.id.startsWith('cfgred-'));

  describe('fixtures track the allowlist', () => {
    it('has a fixture and a spec for the same set of source types', () => {
      expect(Object.keys(SOURCE_CONFIG_SPECS).sort()).toEqual([...TYPES].sort());
    });

    it.each(TYPES)('fixture covers every classified field: %s', (type) => {
      const present = new Set(fixturePaths(FIXTURES[type]));
      const missing = Object.keys(classifiedFieldPaths(type)).filter((p) => !present.has(p));
      expect(missing, 'add a sentinel for each of these to FIXTURES').toEqual([]);
    });

    it.each(TYPES)('fixture holds no unclassified field: %s', (type) => {
      const classified = classifiedFieldPaths(type);
      // Children of a field withheld as a whole (`auth`, `gateway`, filters...)
      // need no rule of their own: the parent never leaves.
      const underWithheldParent = (path: string) =>
        path
          .split('.')
          .slice(0, -1)
          .some((_, i, parts) => classified[parts.slice(0, i + 1).join('.')] === 'withheld');
      const extra = fixturePaths(FIXTURES[type]).filter(
        (p) => !(p in classified) && !underWithheldParent(p),
      );
      expect(extra.sort(), 'classify these in utils/sourceConfigRedaction.ts').toEqual(
        [...DELIBERATELY_UNCLASSIFIED[type]].sort(),
      );
    });
  });

  describe.each(CALLERS)('as %s', (caller) => {
    it('GET / returns no value this caller may not see', async () => {
      const agent = await agentFor(caller);
      const res = await agent.get('/');
      expect(res.status).toBe(200);
      const rows = ours(res.body);
      expect(rows).toHaveLength(TYPES.length);
      expectNoForbidden(rows, caller, 'GET /');
    });

    it.each(TYPES)('GET /:id returns no value this caller may not see: %s', async (type) => {
      const agent = await agentFor(caller);
      const res = await agent.get(`/${idFor(type)}`);
      // anonymous and limited hold no `sources:read`: refused outright.
      expect(res.status).toBe(caller === 'anonymous' || caller === 'limited' ? 403 : 200);
      expectNoForbidden(res.body, caller, `GET /${type}`);
    });

    it.each(TYPES)('PUT /:id answers with no value this caller may not see: %s', async (type) => {
      const agent = await agentFor(caller);
      const res = await agent.put(`/${idFor(type)}`).send({ name: `Renamed ${type}` });
      expect(res.status).toBe(caller === 'editor' || caller === 'admin' ? 200 : 403);
      expectNoForbidden(res.body, caller, `PUT /${type}`);
    });

    it('POST /reorder answers with no value this caller may not see', async () => {
      const agent = await agentFor(caller);
      const all = await harness.db.sources.getAllSources();
      const res = await agent.post('/reorder').send({ order: all.map((s) => s.id) });
      expect(res.status).toBe(caller === 'editor' || caller === 'admin' ? 200 : 403);
      expectNoForbidden(res.body, caller, 'POST /reorder');
    });

    it('POST / answers with no value this caller may not see', async () => {
      const agent = await agentFor(caller);
      const res = await agent.post('/').send({
        name: 'Redaction created',
        type: 'meshcore_mqtt',
        enabled: false,
        // Same broker, another region: a second source on the same feed is a 409.
        config: { ...FIXTURES.meshcore_mqtt, region: 'JFK' },
      });
      expect(res.status).toBe(caller === 'editor' || caller === 'admin' ? 201 : 403);
      expectNoForbidden(res.body, caller, 'POST /');
      if (res.body?.id) await harness.db.sources.deleteSource(res.body.id).catch(() => {});
    });

    it('GET /:id/status returns no host-bearing detail this caller may not see', async () => {
      const id = idFor('mqtt_bridge');
      registry.getManager.mockReturnValue({
        sourceId: id,
        sourceType: 'mqtt_bridge',
        getStatus: () => ({
          sourceId: id,
          sourceName: 'Redaction mqtt_bridge',
          sourceType: 'mqtt_bridge',
          connected: false,
          lastError: `connect ECONNREFUSED ${EP}-status-host:1883`,
          publishers: { gw1: { connected: false, publishes: 3, lastError: `getaddrinfo ENOTFOUND ${EP}-pub-host` } },
          observer: {
            configured: true,
            connected: true,
            lastError: `${EP}-observer-error`,
            brokers: [
              {
                key: `${EP}-broker-key`,
                url: `mqtts://${EP}-observer-host:8883`,
                label: `${EP}-observer-label`,
                tokenAudience: `${EP}-observer-audience`,
                connected: true,
                lastError: `${EP}-broker-error`,
              },
            ],
          },
        }),
        getLocalNodeInfo: () => null,
      });
      const agent = await agentFor(caller);
      // `nodes:read` keeps the observer block in the payload, so the test
      // covers the redaction and not the older "drop it entirely" branch.
      const granted = caller.startsWith('anonymous') ? harness.anonymous : harness.limited;
      if (caller !== 'admin') await harness.grant(granted.id, 'nodes', 'read', id);

      const res = await agent.get(`/${id}/status`);
      expect(res.status).toBe(200);
      expectNoForbidden(res.body, caller, 'GET /:id/status');
      // Shape survives for the source card either way.
      expect(res.body.connected).toBe(false);
      expect(res.body.observer.brokers).toHaveLength(1);
      expect(res.body.observer.brokers[0].connected).toBe(true);
      expect(res.body.publishers.gw1.publishes).toBe(3);
      if (seesEndpoints(caller)) {
        expect(res.body.lastError).toContain(`${EP}-status-host`);
        expect(res.body.observer.brokers[0].url).toContain(`${EP}-observer-host`);
      } else {
        expect(res.body.lastError).toBeNull();
        expect(res.body.observer.brokers[0].url).toBe('');
      }
    });
  });

  describe('what each caller does receive', () => {
    const byType = (rows: Array<{ id: string; config: Record<string, any>; endpointHidden?: boolean }>) =>
      Object.fromEntries(TYPES.map((t) => [t, rows.find((r) => r.id === idFor(t))!])) as Record<
        Source['type'],
        { config: Record<string, any>; endpointHidden?: boolean }
      >;

    it.each(['anonymous', 'anonymousWithRead', 'limited'] as Caller[])(
      '%s gets the flags the UI draws from, and nothing else',
      async (caller) => {
        const agent = await agentFor(caller);
        const rows = byType((await agent.get('/')).body);

        expect(rows.meshtastic_tcp.config).toEqual({
          autoConnect: false,
          virtualNode: { enabled: true },
          mqttLink: { enabled: true, mqttBrokerSourceId: 'cfgred-mqtt_broker' },
        });
        expect(rows.meshcore.config).toEqual({
          autoConnect: false,
          transport: 'tcp',
          deviceType: 'companion',
          virtualNode: { enabled: true },
          observer: { enabled: true, brokerCount: 1 },
        });
        expect(rows.meshcore_mqtt.config).toEqual({ autoConnect: false, region: 'MCO' });
        expect(rows.mqtt_bridge.config).toEqual({ autoConnect: false, brokerSourceId: 'cfgred-mqtt_broker' });
        expect(rows.mqtt_broker.config).toEqual({ autoConnect: false });
        expect(rows.reticulum.config).toEqual({ autoConnect: false });
        for (const type of TYPES) expect(rows[type].endpointHidden).toBe(true);
      },
    );

    it('a signed-in sources:read holder also gets the endpoints, URLs redacted', async () => {
      const agent = await agentFor('viewer');
      const rows = byType((await agent.get('/')).body);

      expect(rows.meshtastic_tcp.config).toEqual({
        autoConnect: false,
        host: `${EP}-mt-host`,
        port: ENDPOINT_PORTS[0],
        virtualNode: { enabled: true, port: ENDPOINT_PORTS[1] },
        mqttLink: { enabled: true, mqttBrokerSourceId: 'cfgred-mqtt_broker' },
      });
      expect(rows.meshcore.config).toEqual({
        autoConnect: false,
        transport: 'tcp',
        deviceType: 'companion',
        port: `${EP}-mc-legacy-serial`,
        serialPort: `${EP}-mc-serial`,
        tcpHost: `${EP}-mc-host`,
        tcpPort: ENDPOINT_PORTS[2],
        virtualNode: { enabled: true, port: ENDPOINT_PORTS[3] },
        observer: {
          enabled: true,
          brokerCount: 1,
          brokerUrl: `mqtts://***@${EP}-obs-legacy.example:8883/path`,
          iataCode: `${EP}-iata`,
          brokers: [{ url: `wss://***@${EP}-obs-broker.example:8883/path`, label: `${EP}-broker-label` }],
        },
      });
      expect(rows.meshcore_mqtt.config).toEqual({
        autoConnect: false,
        region: 'MCO',
        brokerUrl: `mqtts://***@${EP}-ingest.example:8883/path`,
      });
      expect(rows.mqtt_bridge.config).toEqual({
        autoConnect: false,
        brokerSourceId: 'cfgred-mqtt_broker',
        upstream: { url: `mqtt://***@${EP}-bridge.example:8883/path` },
        subscriptions: [`${EP}-topic/#`],
      });
      expect(rows.mqtt_broker.config).toEqual({
        autoConnect: false,
        listener: { port: ENDPOINT_PORTS[4], host: `${EP}-listener-host` },
        rootTopic: `${EP}-root-topic`,
      });
      expect(rows.reticulum.config).toEqual({
        autoConnect: false,
        bridgeUrl: `ws://***@${EP}-rns-bridge.example:8883/path`,
        peers: [{ host: `${EP}-rns-peer`, port: ENDPOINT_PORTS[5] }],
        device: `${EP}-rns-device`,
      });
      for (const type of TYPES) expect(rows[type].endpointHidden).toBeUndefined();
    });

    it('an admin gets the stored config back, minus observer key material', async () => {
      const agent = await agentFor('admin');
      const rows = byType((await agent.get('/')).body);
      for (const type of TYPES) {
        if (type === 'meshcore') continue;
        expect(rows[type].config).toEqual(FIXTURES[type]);
      }
      const observer = { ...(FIXTURES.meshcore.observer as Record<string, any>) };
      delete observer.privateKey;
      observer.brokers = observer.brokers.map(({ password: _password, ...rest }: Record<string, unknown>) => rest);
      expect(rows.meshcore.config).toEqual({ ...FIXTURES.meshcore, observer });
    });

    it('an editor gets every field but the passwords, so the edit form round-trips', async () => {
      const agent = await agentFor('editor');
      const rows = byType((await agent.get('/')).body);
      expect(rows.meshtastic_tcp.config).toEqual(FIXTURES.meshtastic_tcp);
      expect(rows.reticulum.config).toEqual(FIXTURES.reticulum);
      const { password: _pw, ...ingest } = FIXTURES.meshcore_mqtt;
      expect(rows.meshcore_mqtt.config).toEqual(ingest);
      expect(rows.mqtt_bridge.config.upstream).toEqual({
        url: (FIXTURES.mqtt_bridge.upstream as Record<string, unknown>).url,
        username: `${PRIV}-bridge-user`,
      });
      expect(rows.mqtt_broker.config.auth).toEqual({ username: `${PRIV}-broker-user` });
    });
  });

  describe('an edit that leaves the password blank keeps the stored one', () => {
    it.each(['editor', 'admin'] as Caller[])('%s: load, change one field, save', async (caller) => {
      const agent = await agentFor(caller);
      const id = idFor('meshcore_mqtt');
      const loaded = (await agent.get(`/${id}`)).body.config as Record<string, unknown>;
      // The form never seeds the password back and omits it when left blank.
      const { password: _omitted, ...withoutPassword } = loaded;
      const res = await agent.put(`/${id}`).send({ config: { ...withoutPassword, region: 'TPA' } });
      expect(res.status).toBe(200);

      const stored = (await harness.db.sources.getSource(id))!.config as Record<string, unknown>;
      expect(stored.password).toBe(`${PW}-ingest`);
      expect(stored.region).toBe('TPA');
      // Nothing the caller was shown got lost on the way back.
      expect(stored.brokerUrl).toBe(FIXTURES.meshcore_mqtt.brokerUrl);
      expect(stored.username).toBe(FIXTURES.meshcore_mqtt.username);
    });
  });
});

describe('projectSourceConfig', () => {
  it('returns nothing for a source type it does not know', () => {
    expect(projectSourceConfig('some_new_type', { host: 'h', autoConnect: false }, 'viewer')).toEqual({});
  });

  it('drops a field that is not classified, at any depth', () => {
    const cfg = { host: 'h', surprise: 's', virtualNode: { enabled: true, surprise: 's' } };
    expect(projectSourceConfig('meshtastic_tcp', cfg, 'viewer')).toEqual({
      host: 'h',
      virtualNode: { enabled: true },
    });
  });

  it('does not pass an object through a field classified as a plain value', () => {
    const cfg = { host: { nested: 'secret' }, region: ['a'] };
    expect(projectSourceConfig('meshtastic_tcp', cfg, 'viewer')).toEqual({});
    expect(projectSourceConfig('meshcore_mqtt', cfg, 'viewer')).toEqual({});
  });

  it('tolerates a missing, null, or non-object config', () => {
    for (const cfg of [undefined, null, 'x', 3, []]) {
      expect(projectSourceConfig('meshcore', cfg, 'public')).toEqual({});
    }
  });

  it('counts a legacy single-broker observer as one broker', () => {
    const cfg = { observer: { enabled: true, brokerUrl: 'mqtts://host:8883' } };
    expect(projectSourceConfig('meshcore', cfg, 'public')).toEqual({
      observer: { enabled: true, brokerCount: 1 },
    });
  });
});

describe('redactEndpointUrl', () => {
  it('strips credentials, the query string and the fragment', () => {
    expect(redactEndpointUrl('wss://u:p@host:443/mqtt?token=abc#frag')).toBe('wss://***@host:443/mqtt');
  });

  it('leaves a plain URL alone', () => {
    expect(redactEndpointUrl('mqtt://broker.example:1883')).toBe('mqtt://broker.example:1883');
  });
});
