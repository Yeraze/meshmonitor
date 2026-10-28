/**
 * #6013: live/history rows and unread aggregates must use the same receipt
 * clock, including own sends and sources with Ignore / Block entries.
 * Real managers, SQLite rows, sessions and permissions; no radio connects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import databaseService from '../../services/database.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { meshcoreMessageFilter } from '../services/meshcoreMessageFilter.js';
import { meshcoreReceiptTimeMs } from '../../utils/meshcoreMessageTime.js';
import {
  configureReadStateTransport, loadChannelLastRead, markChannelRead,
} from '../../components/MeshCore/meshcoreUnreadStore.js';
import type { MeshCoreManager as Manager, MeshCoreMessage } from '../meshcoreManager.js';

const managers = new Map<string, Manager>();
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn((id: string) => managers.get(id)),
    getAllManagers: vi.fn(() => [...managers.values()]),
    getPrimaryMeshtasticSourceId: () => null,
  },
}));

const { MeshCoreManager } = await import('../meshcoreManager.js');
const { default: messagingRoutes } = await import('./meshcoreRoutes.js');

const SELF = 'aa'.repeat(32);
const SPAMMER = 'cc'.repeat(32);
const RECEIPT = 1_793_190_000_000;

// Private seams drive the existing ingest/send paths without connecting a radio.
interface ManagerInternals {
  localNode: { publicKey: string; name: string };
  handleBridgeEvent(event: { event_type: string; data: Record<string, unknown> }): void;
  performScopedSend(text: string, toPublicKey?: string, channelIdx?: number): Promise<unknown>;
  sendBridgeCommand(command: string, params: unknown): Promise<{ success: boolean; data: object }>;
  addMessage(message: MeshCoreMessage): Promise<boolean>;
}

describe('MeshCore unread receipt-time consistency (#6013)', () => {
  let harness: RouteTestHarness;
  let manager: Manager;
  let internals: ManagerInternals;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: app => app.use('/:id/meshcore', messagingRoutes),
    });
    managers.clear();
    for (const id of [harness.sourceA, harness.sourceB]) {
      await databaseService.sources.deleteSource(id);
      await databaseService.sources.createSource({ id, name: id, type: 'meshcore', config: {}, enabled: true });
      managers.set(id, new MeshCoreManager(id));
      await meshcoreMessageFilter.loadSource(id);
    }
    manager = managers.get(harness.sourceA)!;
    internals = manager as unknown as ManagerInternals;
    internals.localNode = { publicKey: SELF, name: 'Self' };
    vi.spyOn(internals, 'sendBridgeCommand').mockResolvedValue({ success: true, data: {} });
    // The store's injected transport also works without a DOM/localStorage.
    configureReadStateTransport({
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    configureReadStateTransport(null);
    meshcoreMessageFilter.resetForTests();
    for (const id of managers.keys()) await databaseService.meshcore.deleteAllMessagesForSource(id);
    managers.clear();
    await harness.cleanup();
  });

  it.each(['received', 'own send'] as const)('%s stays read when the live row wins over history', async kind => {
    // A fixed fake clock would conceal the original second-Date.now() bug.
    let now = RECEIPT;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now++);
    const insert = vi.spyOn(databaseService.meshcore, 'insertMessage'); // real SQLite write
    if (kind === 'received') {
      internals.handleBridgeEvent({
        event_type: 'channel_message',
        data: { channel_idx: 0, text: 'Alice: hello', sender_timestamp: RECEIPT / 1000 },
      });
    } else {
      await internals.performScopedSend('hello', undefined, 0);
    }
    expect(insert).toHaveBeenCalledTimes(1);
    await insert.mock.results[0].value;
    clock.mockRestore();

    const agent = await harness.loginAs(harness.admin);
    const history = await agent.get(`/${harness.sourceA}/meshcore/messages/channel/0`).expect(200);
    const live = await agent.get(`/${harness.sourceA}/meshcore/messages`).expect(200);
    expect(history.body.data).toHaveLength(1);
    expect(live.body.data).toHaveLength(1);
    const historyRow: MeshCoreMessage = history.body.data[0];
    const liveRow: MeshCoreMessage = live.body.data[0];
    expect(liveRow.fromPublicKey).toBe(kind === 'received' ? 'channel-0' : SELF);

    // MeshCoreChannelsView merges by id, with the live pool copy winning.
    const merged = new Map([[historyRow.id, historyRow], [liveRow.id, liveRow]]);
    expect(merged.size).toBe(1);
    markChannelRead(harness.sourceA, 0, meshcoreReceiptTimeMs(merged.get(liveRow.id)!));
    const counts = await agent.get(`/${harness.sourceA}/meshcore/messages/channel-counts?channels=0`).expect(200);
    const lastRead = loadChannelLastRead(harness.sourceA)[0];
    expect(counts.body.counts).toEqual({ 0: 1 });
    expect(counts.body.latestTimestamps[0]).toBe(lastRead);
    expect(historyRow.receivedAt).toBe(liveRow.receivedAt);

    // Reloading a browser does not rebuild the server's live pool.
    const reloaded = await agent.get(`/${harness.sourceA}/meshcore/messages`).expect(200);
    expect(reloaded.body.data[0].receivedAt).toBe(lastRead);
    const other = await agent.get(`/${harness.sourceB}/meshcore/messages/channel-counts?channels=0`).expect(200);
    expect(other.body.latestTimestamps).toEqual({});
    expect(loadChannelLastRead(harness.sourceB)).toEqual({});
  });

  it('assigns one receipt clock to both copies when an input has no receivedAt', async () => {
    let now = RECEIPT;
    vi.spyOn(Date, 'now').mockImplementation(() => now++);
    const message: MeshCoreMessage = {
      id: 'legacy', fromPublicKey: 'channel-0', text: 'hello', timestamp: RECEIPT - 60_000,
    };
    expect(await internals.addMessage(message)).toBe(true);
    const [history] = await manager.getChannelMessages(0);
    const [live] = manager.getRecentMessages(10);
    expect(live.receivedAt).toBe(RECEIPT);
    expect(history.receivedAt).toBe(live.receivedAt);
    expect(history.timestamp).toBe(message.timestamp);
  });

  it('uses receipt time with ignore entries, excluding ignored rows and reactions', async () => {
    await meshcoreMessageFilter.setIgnoredNode({
      sourceId: harness.sourceA, publicKey: SPAMMER, name: 'Spammer', mode: 'ignore', createdBy: harness.admin.id,
    });
    const rows = [
      { id: 'early', fromName: 'Alice', timestamp: RECEIPT + 120_000, createdAt: RECEIPT },
      { id: 'latest', fromName: 'Bob', timestamp: RECEIPT - 120_000, createdAt: RECEIPT + 1_000 },
      { id: 'ignored', fromName: 'Spammer', timestamp: RECEIPT + 240_000, createdAt: RECEIPT + 2_000 },
      { id: 'reaction', fromName: 'Alice', timestamp: RECEIPT + 360_000, createdAt: RECEIPT + 3_000, reactionEmoji: '\u{1F44D}' },
    ];
    for (const row of rows) {
      await databaseService.meshcore.insertMessage({ fromPublicKey: 'channel-0', text: 'hello', ...row }, harness.sourceA);
    }
    const agent = await harness.loginAs(harness.admin);
    const counts = await agent.get(`/${harness.sourceA}/meshcore/messages/channel-counts?channels=0`).expect(200);
    expect(counts.body.latestTimestamps).toEqual({ 0: RECEIPT + 1_000 });
    markChannelRead(harness.sourceA, 0, RECEIPT + 1_000);
    expect(counts.body.latestTimestamps[0]).toBe(loadChannelLastRead(harness.sourceA)[0]);

    // The scan must not sidestep the route's real per-source grants.
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceB);
    const limited = await harness.loginAs(harness.limited);
    const denied = await limited.get(`/${harness.sourceA}/meshcore/messages/channel-counts?channels=0`).expect(200);
    expect(denied.body.latestTimestamps).toEqual({});
  });
});
