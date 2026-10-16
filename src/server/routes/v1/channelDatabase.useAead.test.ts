/**
 * #5248 Phase 2: the Channel Database API stores and returns `useAead`,
 * against the real in-memory SQLite DB (migration 208 applied by the harness).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../../test-helpers/routeTestApp.js';

vi.mock('../../services/retroactiveDecryptionService.js', () => ({
  retroactiveDecryptionService: {
    processForChannel: vi.fn().mockResolvedValue(undefined),
    getProgress: vi.fn().mockReturnValue(null),
    isRunning: vi.fn().mockReturnValue(false),
  },
}));

import channelDatabaseRouter from './channelDatabase.js';
import databaseService from '../../../services/database.js';
import { retroactiveDecryptionService } from '../../services/retroactiveDecryptionService.js';

const PSK = Buffer.alloc(16, 0x5a).toString('base64');

describe('Channel Database API — useAead (#5248)', () => {
  let harness: RouteTestHarness;
  const created: number[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    harness = await createRouteTestApp({ mount: (app) => app.use('/api/v1/channel-database', channelDatabaseRouter) });
  });

  afterEach(async () => {
    for (const id of created.splice(0)) await databaseService.channelDatabase.deleteAsync(id).catch(() => {});
    await harness.cleanup();
  });

  async function create(body: Record<string, unknown>) {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/api/v1/channel-database').send(body);
    expect(res.status).toBe(201);
    created.push(res.body.data.id);
    return { agent, row: res.body.data };
  }

  it('defaults to false and stores true when asked', async () => {
    const plain = await create({ name: 'Plain', psk: PSK });
    expect(plain.row.useAead).toBe(false);
    const aead = await create({ name: 'Secure', psk: PSK, useAead: true });
    expect(aead.row.useAead).toBe(true);
    expect((await databaseService.channelDatabase.getByIdAsync(aead.row.id))?.useAead).toBe(true);
  });

  it('toggles on update and re-runs retroactive decryption when it changes', async () => {
    const { agent, row } = await create({ name: 'Toggle', psk: PSK });
    vi.mocked(retroactiveDecryptionService.processForChannel).mockClear();

    const on = await agent.put(`/api/v1/channel-database/${row.id}`).send({ useAead: true });
    expect(on.status).toBe(200);
    expect(on.body.data.useAead).toBe(true);
    expect(retroactiveDecryptionService.processForChannel).toHaveBeenCalledWith(row.id);

    vi.mocked(retroactiveDecryptionService.processForChannel).mockClear();
    const same = await agent.put(`/api/v1/channel-database/${row.id}`).send({ useAead: true, description: 'x' });
    expect(same.status).toBe(200);
    expect(retroactiveDecryptionService.processForChannel).not.toHaveBeenCalled();
  });

  it('ignores useAead on a MeshCore row', async () => {
    const { agent, row } = await create({ name: '#aeadtest', protocol: 'meshcore' });
    const res = await agent.put(`/api/v1/channel-database/${row.id}`).send({ useAead: true, description: 'y' });
    expect(res.status).toBe(200);
    expect((await databaseService.channelDatabase.getByIdAsync(row.id))?.useAead).toBe(false);
  });
});
