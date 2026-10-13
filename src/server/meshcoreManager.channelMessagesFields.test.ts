/**
 * Regression test for #4474 — MeshCore hop-count/route-path/scope info
 * disappearing on older messages.
 *
 * `MeshCoreManager.getChannelMessages` serves the per-channel history endpoint
 * (`/api/sources/:id/meshcore/messages/channel/:idx`), used for both the
 * initial channel load and infinite-scroll "load older" (#4460). Unlike the
 * in-memory recent-tail (`getRecentMessages`, populated live and already
 * carrying these fields), this method re-hydrates from the DB row
 * (`DbMeshCoreMessage`) and must forward `hopCount` / `routePath` /
 * `scopeCode` / `scopeName` onto the API-shaped `MeshCoreMessage` it returns —
 * otherwise messages loaded from history render without the route info that
 * was visible when they first arrived live.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeshCoreManager } from './meshcoreManager.js';
import databaseService from '../services/database.js';

describe('MeshCoreManager.getChannelMessages field passthrough (#4474)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards hopCount/routePath/scopeCode/scopeName from the DB row', async () => {
    const m = new MeshCoreManager('test-source');
    vi.spyOn(databaseService.meshcore, 'getChannelMessages').mockResolvedValue([
      {
        id: 'a',
        fromPublicKey: 'channel-0',
        toPublicKey: 'channel-0',
        text: 'hi',
        timestamp: 1000,
        createdAt: 1000,
        hopCount: 2,
        routePath: 'a3,7f',
        scopeCode: 5,
        scopeName: 'TestRegion',
      },
    ]);
    vi.spyOn(databaseService.meshcore, 'getHeardRepeatersForMessages').mockResolvedValue({});

    const [message] = await m.getChannelMessages(0, 100, 0);

    expect(message.hopCount).toBe(2);
    expect(message.routePath).toBe('a3,7f');
    expect(message.scopeCode).toBe(5);
    expect(message.scopeName).toBe('TestRegion');
  });

  it('defaults route fields to null when the DB row has none (direct/unknown)', async () => {
    const m = new MeshCoreManager('test-source');
    vi.spyOn(databaseService.meshcore, 'getChannelMessages').mockResolvedValue([
      {
        id: 'b',
        fromPublicKey: 'channel-0',
        toPublicKey: 'channel-0',
        text: 'direct',
        timestamp: 2000,
        createdAt: 2000,
      },
    ]);
    vi.spyOn(databaseService.meshcore, 'getHeardRepeatersForMessages').mockResolvedValue({});

    const [message] = await m.getChannelMessages(0, 100, 0);

    expect(message.hopCount).toBeNull();
    expect(message.routePath).toBeNull();
    expect(message.scopeCode).toBeNull();
    expect(message.scopeName).toBeNull();
  });
  it('forwards the six reaction fields (#5759) and keeps mc1Hash internal', async () => {
    const m = new MeshCoreManager('test-source');
    vi.spyOn(databaseService.meshcore, 'getChannelMessages').mockResolvedValue([
      {
        id: 'r',
        fromPublicKey: 'channel-0',
        toPublicKey: 'channel-0',
        text: '\u{1F44D}',
        timestamp: 3000,
        createdAt: 3000,
        mc1Hash: 'abcd1234',
        reactionEmoji: '\u{1F44D}',
        reactionFormat: 'mc1-channel',
        reactionTargetHash: 'b45pc4ek',
        reactionTargetSender: 'Bob',
        reactionTargetId: 'target-1',
        reactionRawText: '@[Bob]\u{1F44D}\nb45pc4ek',
      },
    ]);
    vi.spyOn(databaseService.meshcore, 'getHeardRepeatersForMessages').mockResolvedValue({});

    const [message] = await m.getChannelMessages(0, 100, 0);

    expect(message.reactionEmoji).toBe('\u{1F44D}');
    expect(message.reactionFormat).toBe('mc1-channel');
    expect(message.reactionTargetHash).toBe('b45pc4ek');
    expect(message.reactionTargetSender).toBe('Bob');
    expect(message.reactionTargetId).toBe('target-1');
    expect(message.reactionRawText).toBe('@[Bob]\u{1F44D}\nb45pc4ek');
    expect('mc1Hash' in message).toBe(false);
  });

  it('defaults the reaction fields to null for an ordinary row', async () => {
    const m = new MeshCoreManager('test-source');
    vi.spyOn(databaseService.meshcore, 'getChannelMessages').mockResolvedValue([
      { id: 'c', fromPublicKey: 'channel-0', toPublicKey: 'channel-0', text: 'x', timestamp: 1, createdAt: 1 },
    ]);
    vi.spyOn(databaseService.meshcore, 'getHeardRepeatersForMessages').mockResolvedValue({});
    const [message] = await m.getChannelMessages(0, 100, 0);
    expect(message.reactionEmoji).toBeNull();
    expect(message.reactionTargetId).toBeNull();
    expect(message.reactionRawText).toBeNull();
  });

  it('withResendInfo asks only about our own channel sends (#5759)', async () => {
    const m = new MeshCoreManager('test-source');
    vi.spyOn(databaseService.meshcore, 'getChannelMessages').mockResolvedValue([
      // received channel row now carries a senderTimestamp: not resendable
      { id: 'rx', fromPublicKey: 'channel-0', toPublicKey: 'channel-0', text: 'a', timestamp: 1, createdAt: 1, senderTimestamp: 1704067200 },
      // our own channel send: resendable
      { id: 'sent-1', fromPublicKey: 'aa'.repeat(32), toPublicKey: 'channel-0', text: 'b', timestamp: 2, createdAt: 2, senderTimestamp: 1704067201 },
    ]);
    vi.spyOn(databaseService.meshcore, 'getHeardRepeatersForMessages').mockResolvedValue({});
    const events = vi.spyOn(databaseService.messageEvents, 'getEventsForMessages').mockResolvedValue([]);

    await m.getChannelMessages(0, 100, 0);

    expect(events).toHaveBeenCalledTimes(1);
    expect(events.mock.calls[0][1]).toEqual(['sent-1']);
  });
});
