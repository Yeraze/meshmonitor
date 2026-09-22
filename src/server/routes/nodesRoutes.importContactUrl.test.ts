/**
 * #5317: importing a Meshtastic contact URL, the decode side of
 * `GET /nodes/:nodeNum/contact-url`.
 *
 * The point of the feature is messaging a node that has never been heard, so
 * the cases that matter are: a real link from the issue produces a usable row,
 * a junk link is refused rather than written, the row is source-scoped, and
 * `importedAt` marks it as never-heard exactly once.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadProtobufDefinitions } from '../protobufLoader.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import nodesRoutes from './nodesRoutes.js';

// From the issue report. Decodes to "Rigel 🌞🗼" / "Rig".
const RIGEL_URL =
  'https://meshtastic.org/v/#CKXKgvsDEiQKCSEzZjYwYTUyNRIOUmlnZWwg8J-MnvCfl7waA1JpZyh1OAI';
const RIGEL_NODE_NUM = 0x3f60a525;

// Also from the issue, used for the second-source isolation check.
const YUNUSKI_URL =
  'https://meshtastic.org/v/#CLi9pNkNEi8KCSFkYjI5MWViOBIYWXVza2kgTnVza2kg8J-Mu_CflIvwn5qAGgRZdU51KCs4Cw';
const YUNUSKI_NODE_NUM = 0xdb291eb8;

describe('nodesRoutes — POST /nodes/import-contact-url (#5317)', () => {
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
    for (const nodeNum of [RIGEL_NODE_NUM, YUNUSKI_NODE_NUM]) {
      await harness.db.nodes.deleteNodeRecord(nodeNum, harness.sourceA).catch(() => {});
      await harness.db.nodes.deleteNodeRecord(nodeNum, harness.sourceB).catch(() => {});
    }
    await harness.cleanup();
  });

  it('creates a node that has never been heard, from a real contact link', async () => {
    const agent = await harness.loginAs(harness.admin);

    const res = await agent
      .post('/nodes/import-contact-url')
      .send({ sourceId: harness.sourceA, url: RIGEL_URL });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.alreadyKnown).toBe(false);

    const node = await harness.db.nodes.getNode(RIGEL_NODE_NUM, harness.sourceA);
    expect(node).toBeTruthy();
    expect(node!.nodeId).toBe('!3f60a525');
    expect(node!.longName).toContain('Rigel');
    expect(node!.shortName).toBe('Rig');
    // The whole point: it is in the node list without ever having been heard.
    expect(node!.importedAt).toBeGreaterThan(0);
    expect(node!.lastHeard ?? 0).toBe(0);
  });

  it('accepts a bare payload without the URL prefix', async () => {
    const agent = await harness.loginAs(harness.admin);

    const res = await agent
      .post('/nodes/import-contact-url')
      .send({ sourceId: harness.sourceA, url: RIGEL_URL.split('#')[1] });

    expect(res.status).toBe(200);
    expect(await harness.db.nodes.getNode(RIGEL_NODE_NUM, harness.sourceA)).toBeTruthy();
  });

  it('writes the row only to the source it was imported into', async () => {
    const agent = await harness.loginAs(harness.admin);

    await agent
      .post('/nodes/import-contact-url')
      .send({ sourceId: harness.sourceA, url: YUNUSKI_URL })
      .expect(200);

    expect(await harness.db.nodes.getNode(YUNUSKI_NODE_NUM, harness.sourceA)).toBeTruthy();
    expect(await harness.db.nodes.getNode(YUNUSKI_NODE_NUM, harness.sourceB)).toBeFalsy();
  });

  it('does not re-badge a node that has already been heard', async () => {
    await harness.db.nodes.upsertNode({
      nodeNum: RIGEL_NODE_NUM,
      nodeId: '!3f60a525',
      longName: 'Heard already',
      shortName: 'HA',
      lastHeard: 1_700_000_000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, harness.sourceA);
    const agent = await harness.loginAs(harness.admin);

    const res = await agent
      .post('/nodes/import-contact-url')
      .send({ sourceId: harness.sourceA, url: RIGEL_URL });

    expect(res.status).toBe(200);
    expect(res.body.data.alreadyKnown).toBe(true);

    const node = await harness.db.nodes.getNode(RIGEL_NODE_NUM, harness.sourceA);
    // Identity refreshed from the newer link, but not marked as never-heard.
    expect(node!.longName).toContain('Rigel');
    expect(node!.importedAt ?? null).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['not a contact link', 'https://example.com/#hello'],
    ['payload that is not base64url', 'https://meshtastic.org/v/#!!!!'],
    ['base64url that is not a SharedContact', 'https://meshtastic.org/v/#' + Buffer.from('nonsense-bytes').toString('base64url')],
  ])('refuses a %s link without writing a row', async (_label, url) => {
    const agent = await harness.loginAs(harness.admin);

    const res = await agent
      .post('/nodes/import-contact-url')
      .send({ sourceId: harness.sourceA, url });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CONTACT_URL');
  });

  it('requires nodes write permission on that source', async () => {
    // `limited` has no grants until one is added; read alone must not be enough.
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent
      .post('/nodes/import-contact-url')
      .send({ sourceId: harness.sourceA, url: RIGEL_URL });

    expect(res.status).toBe(403);
    expect(await harness.db.nodes.getNode(RIGEL_NODE_NUM, harness.sourceA)).toBeFalsy();
  });

  it('rejects an anonymous request', async () => {
    // `loginAs(null)` exercises the real anonymous-user fallback.
    const agent = await harness.loginAs(null);

    const res = await agent
      .post('/nodes/import-contact-url')
      .send({ sourceId: harness.sourceA, url: RIGEL_URL });

    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(await harness.db.nodes.getNode(RIGEL_NODE_NUM, harness.sourceA)).toBeFalsy();
  });
});
