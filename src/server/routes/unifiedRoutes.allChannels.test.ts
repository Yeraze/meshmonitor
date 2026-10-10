/**
 * GET /api/unified/messages?channel=__all__ — the "All Channels" view (#5361).
 *
 * Real auth middleware and real SQL (createRouteTestApp), so the channel list
 * in the query is what keeps DMs and unreadable channels out.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import unifiedRoutes from './unifiedRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { ALL_CHANNELS_PARAM } from '../../utils/unifiedChannelFilter.js';

const MC_SOURCE = 'rt-mc-5361';
const SENDER = 0x1000;
const BROADCAST = 0xffffffff;
const T0 = 1_760_000_000_000;

describe('GET /api/unified/messages?channel=__all__ (#5361)', () => {
  let harness: RouteTestHarness;
  let packet = 0;

  const addMessage = async (
    sourceId: string,
    over: { channel: number; text: string; createdAt: number; toNodeNum?: number },
  ) => {
    packet += 1;
    await harness.db.messages.insertMessage(
      {
        id: `${sourceId}_${SENDER}_${packet}`,
        fromNodeNum: SENDER,
        toNodeNum: over.toNodeNum ?? BROADCAST,
        fromNodeId: '!00001000',
        toNodeId: over.toNodeNum ? '!00002000' : '!ffffffff',
        text: over.text,
        channel: over.channel,
        portnum: 1,
        timestamp: over.createdAt,
        rxTime: over.createdAt,
        createdAt: over.createdAt,
      },
      sourceId,
    );
  };

  beforeEach(async () => {
    harness = await createRouteTestApp({
      // unifiedRoutes.ts already applies its own `router.use(optionalAuth())`.
      useOptionalAuth: false,
      mount: (app) => app.use('/api/unified', unifiedRoutes),
    });
    await harness.db.sources.deleteSource(MC_SOURCE).catch(() => {});
    await harness.db.messages.deleteAllMessages(harness.sourceA);
    await harness.db.messages.deleteAllMessages(harness.sourceB);
  });

  afterEach(async () => {
    await harness.db.messages.deleteAllMessages(harness.sourceA).catch(() => {});
    await harness.db.messages.deleteAllMessages(harness.sourceB).catch(() => {});
    await harness.db.meshcore.deleteAllMessagesForSource(MC_SOURCE).catch(() => {});
    await harness.db.sources.deleteSource(MC_SOURCE).catch(() => {});
    await harness.cleanup();
  });

  it('returns every channel, names each row, and leaves DMs out', async () => {
    await harness.db.channels.upsertChannel({ id: 1, name: 'Admin', role: 2 }, harness.sourceA);
    await addMessage(harness.sourceA, { channel: 0, text: 'on primary', createdAt: T0 + 1 });
    await addMessage(harness.sourceA, { channel: 1, text: 'on admin', createdAt: T0 + 2 });
    await addMessage(harness.sourceA, { channel: -1, text: 'a private dm', createdAt: T0 + 3, toNodeNum: 0x2000 });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/api/unified/messages?channel=${ALL_CHANNELS_PARAM}`);

    expect(res.status).toBe(200);
    expect(res.body.map((m: any) => m.text)).toEqual(['on admin', 'on primary']);
    expect(res.body.find((m: any) => m.channel === 1).channelName).toBe('Admin');
    expect(res.body.find((m: any) => m.channel === 0).channelName).toBeTruthy();
    expect(res.body[0].receptions[0].sourceId).toBe(harness.sourceA);
  });

  it('the legacy no-channel form still includes DMs', async () => {
    await addMessage(harness.sourceA, { channel: 0, text: 'on primary', createdAt: T0 + 1 });
    await addMessage(harness.sourceA, { channel: -1, text: 'a private dm', createdAt: T0 + 2, toNodeNum: 0x2000 });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/api/unified/messages');

    expect(res.body.map((m: any) => m.text).sort()).toEqual(['a private dm', 'on primary']);
  });

  it('pages back through history past the newest window', async () => {
    // 60 rows, 10 per page: the legacy path would read only the newest 20.
    for (let i = 0; i < 60; i++) {
      await addMessage(harness.sourceA, { channel: i % 2, text: `m${i}`, createdAt: T0 + i });
    }
    const agent = await harness.loginAs(harness.admin);

    const seen: string[] = [];
    let before: number | undefined;
    for (let page = 0; page < 10; page++) {
      const cursor = before === undefined ? '' : `&before=${before}`;
      const res = await agent.get(`/api/unified/messages?channel=${ALL_CHANNELS_PARAM}&limit=10${cursor}`);
      expect(res.status).toBe(200);
      if (res.body.length === 0) break;
      seen.push(...res.body.map((m: any) => m.text));
      before = res.body[res.body.length - 1].createdAt;
    }

    expect(seen).toHaveLength(60);
    expect(seen[0]).toBe('m59');
    expect(seen[59]).toBe('m0');
  });

  it('shows a per-channel reader only the channels they may read', async () => {
    await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);
    await addMessage(harness.sourceA, { channel: 0, text: 'A ch0', createdAt: T0 + 1 });
    await addMessage(harness.sourceA, { channel: 1, text: 'A ch1', createdAt: T0 + 2 });
    await addMessage(harness.sourceB, { channel: 0, text: 'B ch0', createdAt: T0 + 3 });

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/api/unified/messages?channel=${ALL_CHANNELS_PARAM}`);

    expect(res.status).toBe(200);
    expect(res.body.map((m: any) => m.text)).toEqual(['A ch0']);
  });

  it('a messages:read grant opens channels but still no DMs', async () => {
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceB);
    await addMessage(harness.sourceB, { channel: 3, text: 'B ch3', createdAt: T0 + 1 });
    await addMessage(harness.sourceB, { channel: -1, text: 'B dm', createdAt: T0 + 2, toNodeNum: 0x2000 });
    await addMessage(harness.sourceA, { channel: 0, text: 'A ch0', createdAt: T0 + 3 });

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/api/unified/messages?channel=${ALL_CHANNELS_PARAM}`);

    expect(res.body.map((m: any) => m.text)).toEqual(['B ch3']);
  });

  describe('MeshCore', () => {
    const addMeshCore = async (over: { id: string; from: string; to: string | null; text: string; createdAt: number; type?: string }) => {
      await harness.db.meshcore.insertMessage(
        {
          id: over.id,
          fromPublicKey: over.from,
          toPublicKey: over.to,
          text: over.text,
          timestamp: over.createdAt,
          messageType: over.type ?? 'channel',
          createdAt: over.createdAt,
        },
        MC_SOURCE,
      );
    };

    beforeEach(async () => {
      await harness.db.sources.createSource({
        id: MC_SOURCE,
        name: 'MC',
        type: 'meshcore',
        config: {},
        enabled: true,
      });
    });

    it('returns channel traffic and leaves DMs out', async () => {
      await addMeshCore({ id: 'c1', from: 'channel-2', to: null, text: 'Ann: hello', createdAt: T0 + 1 });
      await addMeshCore({ id: 'c0', from: 'aa'.repeat(32), to: null, text: 'legacy public', createdAt: T0 + 2 });
      await addMeshCore({ id: 'd1', from: 'aa'.repeat(32), to: 'bb'.repeat(32), text: 'private', createdAt: T0 + 3, type: 'direct' });

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/api/unified/messages?channel=${ALL_CHANNELS_PARAM}`);

      expect(res.status).toBe(200);
      expect(res.body.map((m: any) => m.text)).toEqual(['legacy public', 'Ann: hello']);
      expect(res.body.map((m: any) => m.channel)).toEqual([0, 2]);
    });

    it('pages back by createdAt', async () => {
      for (let i = 0; i < 30; i++) {
        await addMeshCore({ id: `p${i}`, from: 'channel-0', to: null, text: `Ann: m${i}`, createdAt: T0 + i * 60_000 });
      }
      const agent = await harness.loginAs(harness.admin);

      const first = await agent.get(`/api/unified/messages?channel=${ALL_CHANNELS_PARAM}&limit=10`);
      const cursor = first.body[first.body.length - 1].createdAt;
      const third = await agent.get(
        `/api/unified/messages?channel=${ALL_CHANNELS_PARAM}&limit=10&before=${cursor - 10 * 60_000}`,
      );

      expect(first.body[0].text).toBe('Ann: m29');
      expect(third.body.map((m: any) => m.text)).toEqual(
        Array.from({ length: 10 }, (_, i) => `Ann: m${9 - i}`),
      );
    });

    it('a per-channel reader sees only their channel', async () => {
      await harness.grant(harness.limited.id, 'channel_2', 'read', MC_SOURCE);
      await addMeshCore({ id: 'c2', from: 'channel-2', to: null, text: 'Ann: two', createdAt: T0 + 1 });
      await addMeshCore({ id: 'c5', from: 'channel-5', to: null, text: 'Ann: five', createdAt: T0 + 2 });

      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/api/unified/messages?channel=${ALL_CHANNELS_PARAM}`);

      expect(res.body.map((m: any) => m.text)).toEqual(['Ann: two']);
    });
  });
});
