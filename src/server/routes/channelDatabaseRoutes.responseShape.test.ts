/**
 * Channel-database response shape (transformChannelForResponse)
 *
 * Drives the real channel-database routes through createRouteTestApp() and
 * checks the shape that transformChannelForResponse() gives each row: PSK
 * masking per caller, the '(none)' sentinel, protocol normalisation, and the
 * defaults for missing columns. Replaces tests/unit/channelDatabaseTransform.test.ts,
 * which tested a copy of the preview expression (#6379).
 *
 * Masking rule (MM-SEC MISC-11 / #6087): admins and channel_database:write
 * holders get the raw PSK; everyone else gets no `psk` and a constant
 * '(hidden)' / '(none)' preview with no key bytes in it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Non-DB service mocks: these would do real I/O.
vi.mock('../services/channelDecryptionService.js', () => ({
  channelDecryptionService: { invalidateCache: vi.fn() },
}));

vi.mock('../services/retroactiveDecryptionService.js', () => ({
  retroactiveDecryptionService: {
    processForChannel: vi.fn().mockResolvedValue(undefined),
    getProgress: vi.fn().mockReturnValue({ processed: 0, total: 0 }),
    isRunning: vi.fn().mockReturnValue(false),
  },
}));

import channelDatabaseRoutes from './channelDatabaseRoutes.js';
import databaseService from '../../services/database.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const secretPsk = Buffer.alloc(32, 0xcd).toString('base64');

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'Secret Channel',
    psk: secretPsk,
    pskLength: 32,
    description: 'desc',
    isEnabled: true,
    enforceNameValidation: true,
    useAead: true,
    sortOrder: 5,
    decryptedPacketCount: 12,
    lastDecryptedAt: 2000,
    createdBy: 1,
    createdAt: 1000,
    updatedAt: 1500,
    protocol: 'meshtastic',
    ...overrides,
  };
}

let harness: RouteTestHarness;

function serveRows(rows: Array<Record<string, unknown>>) {
  vi.spyOn(databaseService.channelDatabase, 'getAllAsync').mockResolvedValue(rows as any);
  vi.spyOn(databaseService.channelDatabase, 'getByIdAsync').mockResolvedValue(rows[0] as any);
}

/** Grant the limited user per-entry canRead on every given id (read-only caller). */
async function asReadOnly(ids: number[]) {
  await harness.grant(harness.limited.id, 'channel_database', 'read');
  vi.spyOn(databaseService.channelDatabase, 'getPermissionsForUserAsync').mockResolvedValue(
    ids.map(id => ({ userId: harness.limited.id, channelDatabaseId: id, canViewOnMap: false, canRead: true })) as any,
  );
  vi.spyOn(databaseService.channelDatabase, 'getPermissionAsync').mockImplementation(
    async (_userId: number, id: number) =>
      (ids.includes(id)
        ? { userId: harness.limited.id, channelDatabaseId: id, canViewOnMap: false, canRead: true }
        : null) as any,
  );
  return harness.loginAs(harness.limited);
}

beforeEach(async () => {
  harness = await createRouteTestApp({
    mount: (app) => app.use('/api/channel-database', channelDatabaseRoutes),
  });
  serveRows([row()]);
  vi.spyOn(databaseService.channelDatabase, 'getPermissionsForUserAsync').mockResolvedValue([]);
  vi.spyOn(databaseService.channelDatabase, 'getPermissionAsync').mockResolvedValue(null);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await harness.cleanup();
});

describe('channel-database response shape — PSK masking', () => {
  it('admin gets the raw PSK in both psk and pskPreview', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/api/channel-database');
    expect(res.status).toBe(200);
    expect(res.body.data[0].psk).toBe(secretPsk);
    expect(res.body.data[0].pskPreview).toBe(secretPsk);
  });

  it('non-admin channel_database:write holder gets the raw PSK', async () => {
    await harness.grant(harness.limited.id, 'channel_database', 'write');
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/api/channel-database');
    expect(res.status).toBe(200);
    expect(res.body.data[0].psk).toBe(secretPsk);
    expect(res.body.data[0].pskPreview).toBe(secretPsk);
  });

  it('read-only caller gets no psk key and a "(hidden)" preview, on list and by id', async () => {
    const agent = await asReadOnly([1]);

    const list = await agent.get('/api/channel-database');
    expect(list.status).toBe(200);
    expect(list.body.data[0]).not.toHaveProperty('psk');
    expect(list.body.data[0].pskPreview).toBe('(hidden)');
    // No key bytes anywhere: not even a prefix of the base64 string.
    expect(JSON.stringify(list.body)).not.toContain(secretPsk.slice(0, 6));

    const one = await agent.get('/api/channel-database/1');
    expect(one.status).toBe(200);
    expect(one.body.data).not.toHaveProperty('psk');
    expect(one.body.data.pskPreview).toBe('(hidden)');
    expect(JSON.stringify(one.body)).not.toContain(secretPsk.slice(0, 6));
  });

  it('read-only caller still learns the PSK length (presence is not secret)', async () => {
    const agent = await asReadOnly([1]);
    const res = await agent.get('/api/channel-database');
    expect(res.body.data[0].pskLength).toBe(32);
  });

  it('anonymous caller with a per-entry grant gets the masked shape', async () => {
    vi.spyOn(databaseService.channelDatabase, 'getPermissionsForUserAsync').mockResolvedValue([
      { userId: harness.anonymous.id, channelDatabaseId: 1, canViewOnMap: false, canRead: true } as any,
    ]);
    const anon = await harness.loginAs(null);
    const res = await anon.get('/api/channel-database');
    expect(res.status).toBe(200);
    expect(res.body.data[0]).not.toHaveProperty('psk');
    expect(res.body.data[0].pskPreview).toBe('(hidden)');
  });

  it.each([
    ['empty string', ''],
    ['null', null],
    ['missing', undefined],
  ])('read-only caller sees "(none)" when the PSK is %s', async (_label, psk) => {
    serveRows([row({ psk })]);
    const agent = await asReadOnly([1]);
    const res = await agent.get('/api/channel-database');
    expect(res.status).toBe(200);
    expect(res.body.data[0].pskPreview).toBe('(none)');
    expect(res.body.data[0]).not.toHaveProperty('psk');
  });

  it('distinct PSKs give identical masked previews (no cross-channel oracle)', async () => {
    const otherPsk = Buffer.alloc(32, 0x11).toString('base64');
    serveRows([row({ id: 1 }), row({ id: 2, psk: otherPsk })]);
    const agent = await asReadOnly([1, 2]);
    const res = await agent.get('/api/channel-database');
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].pskPreview).toBe(res.body.data[1].pskPreview);
  });
});

describe('channel-database response shape — fields and defaults', () => {
  it('passes the row fields through', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/api/channel-database/1');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: 1,
      name: 'Secret Channel',
      protocol: 'meshtastic',
      pskLength: 32,
      description: 'desc',
      isEnabled: true,
      enforceNameValidation: true,
      useAead: true,
      sortOrder: 5,
      decryptedPacketCount: 12,
      lastDecryptedAt: 2000,
      createdBy: 1,
      createdAt: 1000,
      updatedAt: 1500,
    });
  });

  it('defaults enforceNameValidation, useAead and sortOrder when the row lacks them', async () => {
    serveRows([row({ enforceNameValidation: null, useAead: undefined, sortOrder: null })]);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/api/channel-database/1');
    expect(res.body.data.enforceNameValidation).toBe(false);
    expect(res.body.data.useAead).toBe(false);
    expect(res.body.data.sortOrder).toBe(0);
  });

  it('normalises protocol: meshcore stays meshcore, anything else reads as meshtastic', async () => {
    serveRows([
      row({ id: 1, protocol: 'meshcore' }),
      row({ id: 2, protocol: null }),
      row({ id: 3, protocol: 'bogus' }),
    ]);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/api/channel-database?protocol=all');
    expect(res.status).toBe(200);
    expect(res.body.data.map((c: any) => c.protocol)).toEqual(['meshcore', 'meshtastic', 'meshtastic']);
  });
});
