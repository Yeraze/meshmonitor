/**
 * Admin Commands `setFavoriteNode` sends add_contact first (#6153), like every
 * other favorite path. set_favorite_node only flags an existing NodeDB entry,
 * so on its own it does nothing on a radio that doesn't hold the node yet.
 *
 * The add_contact bytes come from the manager's shared builder
 * (FavoritesService), mocked here as a sentinel; set_favorite_node runs the
 * real encoder.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import protobuf from 'protobufjs';
import adminRoutes from './adminRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { loadProtobufDefinitions } from '../protobufLoader.js';

const LOCAL = 1;
const REMOTE = 999;
const FAVORITE = 0x12345678;
const SET_FAVORITE_NODE = 39;
const PASSKEY = new Uint8Array([1, 2, 3, 4]);
const CONTACT = new Uint8Array([0xc0, 0xff, 0xee]);

/** Top-level field numbers of an encoded AdminMessage, with varint values. */
function wireFields(buf: Uint8Array): Map<number, number | Uint8Array> {
  const reader = protobuf.Reader.create(buf);
  const out = new Map<number, number | Uint8Array>();
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    out.set(tag >>> 3, (tag & 7) === 2 ? reader.bytes() : reader.uint32());
  }
  return out;
}

describe('adminRoutes — setFavoriteNode sends add_contact first (#6153)', () => {
  let harness: RouteTestHarness;
  let sendAdminCommand: ReturnType<typeof vi.fn>;
  let sendAdminCommandAwaitAck: ReturnType<typeof vi.fn>;
  let buildFavoritedContactMessage: ReturnType<typeof vi.fn>;

  function makeManager(): ISourceManager {
    return {
      sourceId: harness.sourceA,
      sourceType: 'meshtastic_tcp',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ sourceId: harness.sourceA, sourceName: 'A', sourceType: 'meshtastic_tcp', connected: true }),
      getLocalNodeInfo: vi.fn().mockReturnValue({ nodeNum: LOCAL, nodeId: '!00000001', longName: 'Local', shortName: 'LOC' }),
      getSessionPasskey: vi.fn().mockReturnValue(PASSKEY),
      getSessionPasskeyStatus: vi.fn().mockReturnValue({ hasPasskey: true }),
      requestRemoteSessionPasskey: vi.fn().mockResolvedValue(PASSKEY),
      sendAdminCommand,
      sendAdminCommandAwaitAck,
      buildFavoritedContactMessage,
      updateCachedDeviceConfig: vi.fn(),
      isTxEnabled: vi.fn().mockReturnValue(true),
    } as unknown as ISourceManager;
  }

  async function waitForSettled(agent: any, operationId: string, attempts = 80) {
    const { isTerminal } = await import('../services/adminOperationService.js');
    for (let i = 0; i < attempts; i++) {
      const res = await agent.get(`/operations/${operationId}`);
      const op = res.body?.data;
      if (op && isTerminal(op.status)) return op;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`operation ${operationId} never settled`);
  }

  /** Every packet sent, in send order, from both send functions. */
  function sentInOrder(): Array<{ bytes: Uint8Array; dest: number }> {
    const calls = [
      ...sendAdminCommand.mock.calls.map((c, i) => ({ c, order: sendAdminCommand.mock.invocationCallOrder[i] })),
      ...sendAdminCommandAwaitAck.mock.calls.map((c, i) => ({ c, order: sendAdminCommandAwaitAck.mock.invocationCallOrder[i] })),
    ].sort((a, b) => a.order - b.order);
    return calls.map(({ c }) => ({ bytes: c[0] as Uint8Array, dest: c[1] as number }));
  }

  async function favorite(nodeNum: number, extra: Record<string, unknown> = { favoriteNodeNum: FAVORITE }) {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/commands').send({ command: 'setFavoriteNode', sourceId: harness.sourceA, nodeNum, ...extra });
    if (res.status === 202) {
      const op = await waitForSettled(agent, res.body.operationId);
      return { res, op };
    }
    return { res, op: null };
  }

  function expectSetFavorite(packet: { bytes: Uint8Array; dest: number } | undefined, dest: number) {
    expect(packet?.dest).toBe(dest);
    expect(wireFields(packet!.bytes).get(SET_FAVORITE_NODE)).toBe(FAVORITE);
  }

  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', adminRoutes) });
    sendAdminCommand = vi.fn().mockResolvedValue(undefined);
    sendAdminCommandAwaitAck = vi.fn().mockResolvedValue({ acked: true, timedOut: false, errorReason: null });
    buildFavoritedContactMessage = vi.fn().mockResolvedValue(CONTACT);
    await sourceManagerRegistry.addManager(makeManager());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await sourceManagerRegistry.removeManager(harness.sourceA);
    await harness.cleanup();
  });

  it('local node: add_contact goes out before set_favorite_node', async () => {
    const { res } = await favorite(LOCAL);
    expect(res.status).toBe(200);

    expect(buildFavoritedContactMessage).toHaveBeenCalledWith(FAVORITE, expect.any(Uint8Array));
    const sent = sentInOrder();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ bytes: CONTACT, dest: LOCAL });
    expectSetFavorite(sent[1], LOCAL);
  });

  it('remote node: both packets use the one session passkey and go to the remote node', async () => {
    const { res, op } = await favorite(REMOTE);
    expect(res.status).toBe(202);
    expect(op.status).toBe('succeeded');

    expect(buildFavoritedContactMessage).toHaveBeenCalledWith(FAVORITE, PASSKEY);
    const sent = sentInOrder();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ bytes: CONTACT, dest: REMOTE });
    expectSetFavorite(sent[1], REMOTE);
  });

  it('no add_contact when the builder declines (e.g. no public key): set_favorite_node alone', async () => {
    buildFavoritedContactMessage.mockResolvedValue(null);
    await favorite(LOCAL);

    const sent = sentInOrder();
    expect(sent).toHaveLength(1);
    expectSetFavorite(sent[0], LOCAL);
  });

  it('a failed add_contact still sends set_favorite_node', async () => {
    sendAdminCommand.mockRejectedValueOnce(new Error('radio busy'));
    const { res } = await favorite(LOCAL);
    expect(res.status).toBe(200);

    const sent = sentInOrder();
    expect(sent).toHaveLength(2);
    expect(sent[0].bytes).toEqual(CONTACT);
    expectSetFavorite(sent[1], LOCAL);
  });

  it('missing favoriteNodeNum is a 400 and sends nothing', async () => {
    const { res } = await favorite(LOCAL, {});
    expect(res.status).toBe(400);
    expect(buildFavoritedContactMessage).not.toHaveBeenCalled();
    expect(sentInOrder()).toHaveLength(0);
  });
});
