/**
 * `traceroute` read and write are separate grants (#5898).
 *
 *   - `traceroute:read` opens the read routes and nothing that transmits;
 *   - `traceroute:write` opens POST /traceroute, POST /neighborinfo/request
 *     and MeshCore trace-path;
 *   - MeshCore trace-path no longer accepts `nodes:write`.
 *
 * Real auth middleware and permission rows (route harness). Managers are
 * fakes; nothing reaches a radio.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import meshRequestRoutes from './meshRequestRoutes.js';
import meshcoreRoutes from './meshcoreRoutes.js';
import meshcoreTraceRoutes from './meshcoreTraceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';

const VALID_PK = 'f6' + 'a'.repeat(62);

function baseManager(sourceId: string, sourceType: string) {
  return {
    sourceId,
    sourceType,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({ sourceId, sourceName: sourceId, sourceType, connected: true }),
    startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
    stopDistanceDeleteScheduler: vi.fn(),
  };
}

describe('traceroute read/write split (#5898)', () => {
  let harness: RouteTestHarness;
  const sendTraceroute = vi.fn();
  const sendNeighborInfoRequest = vi.fn();
  const traceContactPathDetailed = vi.fn();
  const LOCAL_NODE = 0x2a2a2a2a;

  beforeEach(async () => {
    vi.clearAllMocks();
    sendTraceroute.mockResolvedValue(undefined);
    sendNeighborInfoRequest.mockResolvedValue({ packetId: 1, requestId: 1 });
    traceContactPathDetailed.mockResolvedValue({ ok: true, hops: [], lastSnr: 1, path: [] });
    harness = await createRouteTestApp({
      mount: (app: express.Express) => {
        app.use('/api', meshRequestRoutes);
        app.use('/api/sources/:id/meshcore', meshcoreTraceRoutes);
        app.use('/api/sources/:id/meshcore', meshcoreRoutes);
      },
    });
    // Source A: Meshtastic radio. Source B: MeshCore companion.
    await sourceManagerRegistry.addManager({
      ...baseManager(harness.sourceA, 'meshtastic_tcp'),
      sendTraceroute,
      sendNeighborInfoRequest,
      getLocalNodeInfo: vi.fn().mockReturnValue({ nodeNum: LOCAL_NODE, nodeId: `!${LOCAL_NODE.toString(16)}` }),
    } as unknown as ISourceManager);
    await sourceManagerRegistry.addManager({
      ...baseManager(harness.sourceB, 'meshcore'),
      isReceiveOnly: () => false,
      canTransmit: () => true,
      isConnected: () => true,
      getConnectionStatus: () => ({ connected: true, deviceType: 1, config: null }),
      traceContactPathDetailed,
    } as unknown as ISourceManager);
  });

  afterEach(async () => {
    await sourceManagerRegistry.removeManager(harness.sourceA);
    await sourceManagerRegistry.removeManager(harness.sourceB);
    await harness.cleanup();
  });

  const postTraceroute = (agent: Awaited<ReturnType<RouteTestHarness['loginAs']>>) =>
    agent.post('/api/traceroute').send({ destination: 0x12345678, channel: 0, sourceId: harness.sourceA });
  const postNeighborInfo = (agent: Awaited<ReturnType<RouteTestHarness['loginAs']>>) =>
    agent.post('/api/neighborinfo/request').send({ destination: LOCAL_NODE, sourceId: harness.sourceA });
  const postTracePath = (agent: Awaited<ReturnType<RouteTestHarness['loginAs']>>) =>
    agent.post(`/api/sources/${harness.sourceB}/meshcore/contacts/${VALID_PK}/trace-path`).send({});

  it('read alone opens the read route and refuses every send', async () => {
    await harness.grant(harness.limited.id, 'traceroute', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'traceroute', 'read', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);

    expect((await agent.get(`/api/sources/${harness.sourceB}/meshcore/hop-snr`)).status).toBe(200);
    expect((await postTraceroute(agent)).status).toBe(403);
    expect((await postNeighborInfo(agent)).status).toBe(403);
    expect((await postTracePath(agent)).status).toBe(403);
    expect(sendTraceroute).not.toHaveBeenCalled();
    expect(sendNeighborInfoRequest).not.toHaveBeenCalled();
    expect(traceContactPathDetailed).not.toHaveBeenCalled();
  });

  it('write opens every send', async () => {
    await harness.grant(harness.limited.id, 'traceroute', 'write', harness.sourceA);
    await harness.grant(harness.limited.id, 'traceroute', 'write', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);

    expect((await postTraceroute(agent)).status).toBe(200);
    expect((await postNeighborInfo(agent)).status).toBe(200);
    expect((await postTracePath(agent)).status).toBe(200);
    expect(sendTraceroute).toHaveBeenCalledTimes(1);
    expect(sendNeighborInfoRequest).toHaveBeenCalledTimes(1);
    expect(traceContactPathDetailed).toHaveBeenCalledTimes(1);
  });

  it('MeshCore trace-path no longer accepts nodes:write', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    expect((await postTracePath(agent)).status).toBe(403);
    expect(traceContactPathDetailed).not.toHaveBeenCalled();
  });

  it('MeshCore trace-path needs the grant on its own source', async () => {
    await harness.grant(harness.limited.id, 'traceroute', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    expect((await postTracePath(agent)).status).toBe(403);
  });
});
