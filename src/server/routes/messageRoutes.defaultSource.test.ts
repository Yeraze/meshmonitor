/**
 * POST /api/messages/send with no sourceId goes out on the default
 * Meshtastic source when one is set (#5245), and on the first-started
 * primary when it is not. A named sourceId is unchanged.
 *
 * Real-middleware harness and the real registry singleton; the managers are
 * stubs so nothing transmits.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import messageRoutes from './messageRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { applyDefaultMeshtasticSource } from '../utils/defaultMeshtasticSource.js';

function tcp(id: string) {
  const sendTextMessage = vi.fn().mockResolvedValue(undefined);
  const manager = {
    sourceId: id,
    sourceType: 'meshtastic_tcp',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn(() => ({ sourceId: id, sourceName: id, sourceType: 'meshtastic_tcp' as const, connected: true })),
    getLocalNodeInfo: vi.fn().mockReturnValue(null),
    startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
    stopDistanceDeleteScheduler: vi.fn(),
    sendTextMessage,
  };
  return { manager: manager as unknown as ISourceManager, sendTextMessage };
}

describe('POST /api/messages/send without sourceId — default source (#5245)', () => {
  let harness: RouteTestHarness;
  let a: ReturnType<typeof tcp>;
  let b: ReturnType<typeof tcp>;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/messages', messageRoutes),
    });
    a = tcp(harness.sourceA);
    b = tcp(harness.sourceB);
    await sourceManagerRegistry.addManager(a.manager);
    sourceManagerRegistry.setPrimaryMeshtasticSource(harness.sourceA);
    await sourceManagerRegistry.addManager(b.manager);
  });

  afterEach(async () => {
    applyDefaultMeshtasticSource(sourceManagerRegistry, null);
    await sourceManagerRegistry.removeManager(harness.sourceA);
    await sourceManagerRegistry.removeManager(harness.sourceB);
    await harness.cleanup();
  });

  it('uses the first-started primary when no default is set', async () => {
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.post('/api/messages/send').send({ text: 'hi', channel: 1 });
    expect(res.status).toBe(200);
    expect(a.sendTextMessage).toHaveBeenCalledOnce();
    expect(b.sendTextMessage).not.toHaveBeenCalled();
  });

  it('uses the chosen default when one is set', async () => {
    applyDefaultMeshtasticSource(sourceManagerRegistry, harness.sourceB);
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.post('/api/messages/send').send({ text: 'hi', channel: 1 });
    expect(res.status).toBe(200);
    expect(b.sendTextMessage).toHaveBeenCalledOnce();
    expect(a.sendTextMessage).not.toHaveBeenCalled();
  });

  it('a named sourceId still wins over the default', async () => {
    applyDefaultMeshtasticSource(sourceManagerRegistry, harness.sourceB);
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.post('/api/messages/send').send({ text: 'hi', channel: 1, sourceId: harness.sourceA });
    expect(res.status).toBe(200);
    expect(a.sendTextMessage).toHaveBeenCalledOnce();
    expect(b.sendTextMessage).not.toHaveBeenCalled();
  });

  it('checks the permission on the chosen default, not the automatic primary', async () => {
    applyDefaultMeshtasticSource(sourceManagerRegistry, harness.sourceB);
    await harness.grant(harness.limited.id, 'channel_1', 'write', harness.sourceA);
    const user = await harness.loginAs(harness.limited);
    const res = await user.post('/api/messages/send').send({ text: 'hi', channel: 1 });
    expect(res.status).toBe(403);
    expect(a.sendTextMessage).not.toHaveBeenCalled();
    expect(b.sendTextMessage).not.toHaveBeenCalled();
  });
});
