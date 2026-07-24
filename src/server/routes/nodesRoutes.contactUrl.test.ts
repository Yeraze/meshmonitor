import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbNode } from '../../db/types.js';
import { getProtobufRoot, loadProtobufDefinitions } from '../protobufLoader.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import nodesRoutes from './nodesRoutes.js';

const NODE_NUM = 0x48bff5f5;

function testNode(overrides: Partial<DbNode> = {}): DbNode {
  return {
    nodeNum: NODE_NUM,
    nodeId: '!48bff5f5',
    longName: 'WAM8',
    shortName: 'WAM8',
    hwModel: 9,
    role: 2,
    channel: 0,
    viaMqtt: true,
    publicKey: 'NQWe6Y9GWc1+1Y01CjzAfo+kG61gKFkuidJLAAK4CUM=',
    isUnmessagable: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function decodeLongName(url: string): string {
  const encoded = url.split('#')[1];
  const SharedContact = getProtobufRoot()!.lookupType('meshtastic.SharedContact');
  return (SharedContact.decode(Buffer.from(encoded, 'base64url')) as any).user.longName;
}

describe('nodesRoutes — GET /nodes/:nodeNum/contact-url', () => {
  let harness: RouteTestHarness;

  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: app => app.use('/', nodesRoutes),
    });
  });

  afterEach(async () => {
    await harness.db.nodes.deleteNodeRecord(NODE_NUM, harness.sourceA).catch(() => {});
    await harness.db.nodes.deleteNodeRecord(NODE_NUM, harness.sourceB).catch(() => {});
    await harness.cleanup();
  });

  it('generates a contact for an unmessagable MQTT-carried Meshtastic node', async () => {
    await harness.db.nodes.upsertNode(testNode(), harness.sourceA);
    const agent = await harness.loginAs(harness.admin);

    const res = await agent
      .get(`/nodes/${NODE_NUM}/contact-url`)
      .query({ sourceId: harness.sourceA });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { url: expect.stringMatching(/^https:\/\/meshtastic\.org\/v\/#/) },
    });
    const SharedContact = getProtobufRoot()!.lookupType('meshtastic.SharedContact');
    const decoded = SharedContact.decode(
      Buffer.from(res.body.data.url.split('#')[1], 'base64url'),
    ) as any;
    expect(decoded.user.isUnmessagable).toBe(true);
  });

  it('generates a contact for an ordinary Meshtastic node', async () => {
    await harness.db.nodes.upsertNode(
      testNode({ viaMqtt: false, isUnmessagable: false }),
      harness.sourceA,
    );
    const agent = await harness.loginAs(harness.admin);

    const res = await agent
      .get(`/nodes/${NODE_NUM}/contact-url`)
      .query({ sourceId: harness.sourceA });

    expect(res.status).toBe(200);
    const SharedContact = getProtobufRoot()!.lookupType('meshtastic.SharedContact');
    const decoded = SharedContact.decode(
      Buffer.from(res.body.data.url.split('#')[1], 'base64url'),
    ) as any;
    expect(decoded.user.isUnmessagable).toBe(false);
  });

  it('keeps the same node number isolated between sources', async () => {
    await harness.db.nodes.upsertNode(testNode({ longName: 'Source A' }), harness.sourceA);
    await harness.db.nodes.upsertNode(testNode({ longName: 'Source B' }), harness.sourceB);
    const agent = await harness.loginAs(harness.admin);

    const [sourceA, sourceB] = await Promise.all([
      agent.get(`/nodes/${NODE_NUM}/contact-url`).query({ sourceId: harness.sourceA }),
      agent.get(`/nodes/${NODE_NUM}/contact-url`).query({ sourceId: harness.sourceB }),
    ]);

    expect(decodeLongName(sourceA.body.data.url)).toBe('Source A');
    expect(decodeLongName(sourceB.body.data.url)).toBe('Source B');
  });

  it('requires nodes:read and channel visibility on the requested source', async () => {
    await harness.db.nodes.upsertNode(testNode(), harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    let res = await agent
      .get(`/nodes/${NODE_NUM}/contact-url`)
      .query({ sourceId: harness.sourceA });
    expect(res.status).toBe(403);

    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    res = await agent
      .get(`/nodes/${NODE_NUM}/contact-url`)
      .query({ sourceId: harness.sourceA });
    expect(res.status).toBe(403);

    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
    res = await agent
      .get(`/nodes/${NODE_NUM}/contact-url`)
      .query({ sourceId: harness.sourceA });
    expect(res.status).toBe(200);
  });

  it('returns ordinary errors for missing scope, invalid identity, and missing nodes', async () => {
    const agent = await harness.loginAs(harness.admin);

    const missingScope = await agent.get(`/nodes/${NODE_NUM}/contact-url`);
    expect(missingScope.status).toBe(400);
    expect(missingScope.body.code).toBe('MISSING_SOURCE_ID');

    const invalidNodeNum = await agent
      .get('/nodes/0/contact-url')
      .query({ sourceId: harness.sourceA });
    expect(invalidNodeNum.status).toBe(400);
    expect(invalidNodeNum.body.code).toBe('INVALID_NODE_NUM');

    const missingNode = await agent
      .get(`/nodes/${NODE_NUM}/contact-url`)
      .query({ sourceId: harness.sourceA });
    expect(missingNode.status).toBe(404);
    expect(missingNode.body.code).toBe('NODE_NOT_FOUND');

    await harness.db.nodes.upsertNode(testNode({ nodeId: '!00000001' }), harness.sourceA);
    const invalidIdentity = await agent
      .get(`/nodes/${NODE_NUM}/contact-url`)
      .query({ sourceId: harness.sourceA });
    expect(invalidIdentity.status).toBe(400);
    expect(invalidIdentity.body.code).toBe('INVALID_CONTACT_IDENTITY');
  });
});
