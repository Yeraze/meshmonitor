/**
 * GET /api/messages/export (#5517) — permission model, filters and CSV shape.
 *
 * Real harness (real session, optionalAuth and permission SQL) because the
 * whole point of these tests is that the export hides exactly what the
 * message views hide; a re-implemented permission fake could not show that.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import messageExportRoutes, { mergeStreams, type ExportItem, type ExportStream } from './messageExportRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { CHANNEL_DB_OFFSET } from '../constants/meshtastic.js';

const MC_SOURCE = 'rt-export-mc';
const T0 = Date.UTC(2026, 9, 3, 14, 0, 0); // 2026-10-03T14:00:00Z
const PEER = { nodeNum: 0x0a000002, nodeId: '!0a000002' };
const ME = { nodeNum: 0x0a000001, nodeId: '!0a000001' };

/** Minimal RFC 4180 parser for asserting on the response body. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Response body → array of {column: value} objects (header row consumed). */
function records(body: string): Record<string, string>[] {
  const rows = parseCsv(body.replace(/^\uFEFF/, ''));
  const [header, ...data] = rows;
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

describe('GET /api/messages/export', () => {
  let harness: RouteTestHarness;
  let seq = 0;

  const seed = async (
    sourceId: string,
    channel: number,
    text: string,
    extra: Record<string, unknown> = {},
  ) => {
    seq++;
    const isDm = channel === -1;
    await harness.db.messages.insertMessage(
      {
        id: `${sourceId}_${PEER.nodeNum}_${7000 + seq}`,
        fromNodeNum: PEER.nodeNum,
        toNodeNum: isDm ? ME.nodeNum : 0xffffffff,
        fromNodeId: PEER.nodeId,
        toNodeId: isDm ? ME.nodeId : '!ffffffff',
        text,
        channel,
        portnum: 1,
        timestamp: T0 + seq * 1000,
        createdAt: T0 + seq * 1000,
        rxSnr: 5.25,
        rxRssi: -97,
        hopStart: 3,
        hopLimit: 1,
        ...extra,
      } as never,
      sourceId,
    );
  };

  const seedMc = async (text: string, extra: Record<string, unknown> = {}) => {
    seq++;
    await harness.db.meshcore.insertMessage(
      {
        id: `mc-${seq}`,
        fromPublicKey: 'channel-1',
        fromName: 'Base Camp',
        toPublicKey: null,
        text,
        timestamp: T0 + seq * 1000,
        snr: -4.25,
        rssi: -110,
        hopCount: 2,
        messageType: 'text',
        sourceId: MC_SOURCE,
        createdAt: T0 + seq * 1000,
        ...extra,
      } as never,
      MC_SOURCE,
    );
  };

  beforeEach(async () => {
    seq = 0;
    harness = await createRouteTestApp({ mount: (app) => app.use('/', messageExportRoutes) });
    await harness.db.sources.deleteSource(MC_SOURCE).catch(() => {});
    await harness.db.sources.createSource({ id: MC_SOURCE, name: 'Field MeshCore', type: 'meshcore', config: {}, enabled: true });
    await harness.db.channels.upsertChannel({ id: 0, name: 'LongFast', role: 1 } as never, harness.sourceA);
    await harness.db.channels.upsertChannel({ id: 2, name: 'ARES', role: 2 } as never, harness.sourceA);
    await harness.db.channels.upsertChannel({ id: 1, name: 'SET Net', role: 2 } as never, MC_SOURCE);
  });

  afterEach(async () => {
    await harness.db.messages.deleteAllMessages(harness.sourceA);
    await harness.db.messages.deleteAllMessages(harness.sourceB);
    await harness.db.meshcore.deleteAllMessagesForSource(MC_SOURCE);
    await harness.db.sources.deleteSource(MC_SOURCE).catch(() => {});
    await harness.cleanup();
  });

  describe('CSV shape', () => {
    it('sends a BOM, CRLF rows, the fixed header and one row per message', async () => {
      await seed(harness.sourceA, 0, 'hello, "world"\nline two');
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/export');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toMatch(/attachment; filename="meshmonitor-messages-.*\.csv"/);
      expect(res.text.charCodeAt(0)).toBe(0xfeff);
      expect(res.text.split('\r\n')[0].replace(/^\uFEFF/, '')).toBe(
        'timestamp_utc,local_time,network,source,channel,sender_name,sender_id,destination,message,message_id,rssi,snr,hops',
      );
      const [row] = records(res.text);
      expect(row).toMatchObject({
        network: 'Meshtastic',
        source: 'Source A',
        channel: 'LongFast',
        sender_id: PEER.nodeId,
        destination: 'broadcast',
        message: 'hello, "world"\nline two',
        message_id: '7001',
        rssi: '-97',
        snr: '5.25',
        hops: '2',
      });
      expect(row.timestamp_utc).toBe(new Date(T0 + 1000).toISOString());
    });

    it('guards formula-looking messages', async () => {
      await seed(harness.sourceA, 0, '=HYPERLINK("http://x")');
      const agent = await harness.loginAs(harness.admin);
      const [row] = records((await agent.get('/export')).text);
      expect(row.message).toBe(`'=HYPERLINK("http://x")`);
    });

    it('renders local_time in the requested zone', async () => {
      await seed(harness.sourceA, 0, 'tz');
      const agent = await harness.loginAs(harness.admin);
      const [row] = records((await agent.get('/export?tz=America/New_York')).text);
      // 14:00:01Z on 2026-10-03 is 10:00:01 EDT.
      expect(row.local_time).toBe('2026-10-03 10:00:01');
    });

    it('merges sources oldest-first and labels MeshCore rows', async () => {
      await seed(harness.sourceA, 0, 'first');
      await seedMc('second');
      await seed(harness.sourceB, 0, 'third');
      const agent = await harness.loginAs(harness.admin);
      const rows = records((await agent.get('/export')).text);
      expect(rows.map((r) => r.message)).toEqual(['first', 'second', 'third']);
      expect(rows[1]).toMatchObject({
        network: 'MeshCore',
        source: 'Field MeshCore',
        channel: 'SET Net',
        sender_name: 'Base Camp',
        sender_id: '',
        snr: '-4.25',
        hops: '2',
        message_id: '',
      });
    });
  });

  describe('permissions', () => {
    beforeEach(async () => {
      await seed(harness.sourceA, 0, 'a-ch0');
      await seed(harness.sourceA, 2, 'a-ch2');
      await seed(harness.sourceA, -1, 'a-dm');
      await seed(harness.sourceB, 0, 'b-ch0');
    });

    it('returns a header-only file for a caller with no grants', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/export');
      expect(res.status).toBe(200);
      expect(records(res.text)).toEqual([]);
    });

    it('hides channels without a channel grant and DMs without messages:read', async () => {
      await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const rows = records((await agent.get('/export')).text);
      expect(rows.map((r) => r.message)).toEqual(['a-ch0']);
    });

    it('includes DMs with messages:read', async () => {
      await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);
      await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const rows = records((await agent.get('/export')).text);
      expect(rows.map((r) => r.message)).toEqual(['a-ch0', 'a-dm']);
      expect(rows[1]).toMatchObject({ channel: 'DM', destination: ME.nodeId });
    });

    it('excludes a source the caller holds no grant on, even when asked for by id', async () => {
      await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const rows = records((await agent.get(`/export?source=${harness.sourceB}`)).text);
      expect(rows).toEqual([]);
    });

    it('includes a virtual channel only with its canRead grant', async () => {
      const vcId = await harness.db.channelDatabase.createAsync({
        name: `Export VC ${Date.now()}`,
        psk: Buffer.alloc(16, 7).toString('base64'),
        pskLength: 16,
        isEnabled: true,
      });
      await seed(harness.sourceA, CHANNEL_DB_OFFSET + vcId, 'virtual');
      try {
        const agent = await harness.loginAs(harness.limited);
        expect(records((await agent.get('/export')).text)).toEqual([]);

        await harness.db.channelDatabase.setPermissionAsync({
          userId: harness.limited.id, channelDatabaseId: vcId, canRead: true, canViewOnMap: false,
        });
        const rows = records((await agent.get('/export')).text);
        expect(rows.map((r) => r.message)).toEqual(['virtual']);
      } finally {
        await harness.db.channelDatabase.deletePermissionAsync(harness.limited.id, vcId).catch(() => {});
        await harness.db.channelDatabase.deleteAsync(vcId).catch(() => {});
      }
    });

    it('MeshCore: a channel grant exposes that channel but not DMs', async () => {
      await seedMc('mc ch1');
      await seedMc('mc ch3', { fromPublicKey: 'channel-3' });
      await seedMc('mc dm', { fromPublicKey: 'bb'.repeat(32), fromName: null, toPublicKey: 'aa'.repeat(32) });
      await harness.grant(harness.limited.id, 'channel_1', 'read', MC_SOURCE);
      const agent = await harness.loginAs(harness.limited);
      const rows = records((await agent.get(`/export?source=${MC_SOURCE}`)).text);
      expect(rows.map((r) => r.message)).toEqual(['mc ch1']);
    });
  });

  describe('filters', () => {
    it('applies channel names, keywords, type, sender, dates and reactions', async () => {
      await seed(harness.sourceA, 0, 'NET check-in W1AW');
      await seed(harness.sourceA, 2, 'ARES net traffic');
      await seed(harness.sourceA, 2, 'net test, ignore');
      await seed(harness.sourceA, -1, 'dm about the net');
      await seed(harness.sourceA, 2, '👍', { emoji: 1, replyId: 1 });
      const agent = await harness.loginAs(harness.admin);

      const byChannel = records((await agent.get('/export?channel=ares&type=channels&include=net&exclude=IGNORE')).text);
      expect(byChannel.map((r) => r.message)).toEqual(['ARES net traffic']);

      const dms = records((await agent.get('/export?type=dms')).text);
      expect(dms.map((r) => r.message)).toEqual(['dm about the net']);

      const anyTerm = records((await agent.get('/export?include=W1AW&include=traffic')).text);
      expect(anyTerm.map((r) => r.message)).toEqual(['NET check-in W1AW', 'ARES net traffic']);

      const ranged = records((await agent.get(`/export?start=${T0 + 2000}&end=${T0 + 3000}`)).text);
      expect(ranged.map((r) => r.message)).toEqual(['ARES net traffic', 'net test, ignore']);

      expect(records((await agent.get('/export?sender=!ffff0000')).text)).toEqual([]);
      expect(records((await agent.get(`/export?sender=${PEER.nodeId.toUpperCase()}`)).text)).toHaveLength(4);

      const withReactions = records((await agent.get('/export?includeReactions=true')).text);
      expect(withReactions.map((r) => r.message)).toContain('👍');
    });

    it('rejects bad input with the fail() envelope', async () => {
      const agent = await harness.loginAs(harness.admin);
      const tz = await agent.get('/export?tz=Not/AZone');
      expect(tz.status).toBe(400);
      expect(tz.body).toMatchObject({ success: false, code: 'INVALID_INPUT' });
      const range = await agent.get(`/export?start=${T0 + 10}&end=${T0}`);
      expect(range.status).toBe(400);
      expect(range.body.code).toBe('INVALID_TIME_RANGE');
      const secs = await agent.get('/export?start=abc');
      expect(secs.status).toBe(400);
      const type = await agent.get('/export?type=everything');
      expect(type.status).toBe(400);
    });
  });
});

describe('mergeStreams', () => {
  const stream = (order: number, times: number[], pageSize: number): ExportStream => ({
    order,
    fetch: async (after) => {
      const items: ExportItem[] = times.map((t, i) => ({
        time: t,
        id: `${order}-${String(i).padStart(3, '0')}`,
        row: {} as ExportItem['row'],
      }));
      const start = after
        ? items.findIndex((it) => it.time > after.time || (it.time === after.time && it.id > after.id))
        : 0;
      return start < 0 ? [] : items.slice(start, start + pageSize);
    },
  });

  it('interleaves sorted streams across page boundaries', async () => {
    const a = stream(0, [1, 3, 5, 7, 9], 2);
    const b = stream(1, [2, 3, 4, 10], 2);
    const out: string[] = [];
    for await (const it of mergeStreams([a, b], 2)) out.push(`${it.time}:${it.id[0]}`);
    expect(out).toEqual(['1:0', '2:1', '3:0', '3:1', '4:1', '5:0', '7:0', '9:0', '10:1']);
  });

  it('ends cleanly with no streams', async () => {
    const out: ExportItem[] = [];
    for await (const it of mergeStreams([])) out.push(it);
    expect(out).toEqual([]);
  });
});
