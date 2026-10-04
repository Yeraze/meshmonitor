/**
 * POST /contacts/:publicKey/trace-path forwards the Auto return path choice
 * (#5485) and returns the hops actually traced. Only a literal `true` turns
 * the return leg on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const VALID_PK = 'f6' + 'a'.repeat(62);

const traceContactPath = vi.fn();
const managers = new Map<string, unknown>();

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (sourceId: string) => managers.get(sourceId),
    getAllManagers: () => Array.from(managers.values()),
  },
}));

describe('POST /contacts/:publicKey/trace-path — auto return path (#5485)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    traceContactPath.mockReset();
    traceContactPath.mockResolvedValue({ ok: true, hops: [{ index: 0, snr: 5 }], lastSnr: 3, path: ['5e', 'f6', '5e'] });
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes),
    });
    managers.set(harness.sourceA, {
      sourceId: harness.sourceA,
      sourceType: 'meshcore',
      isReceiveOnly: () => false,
      canTransmit: () => true,
      isConnected: () => true,
      getConnectionStatus: () => ({ connected: true, deviceType: 1, config: null }),
      traceContactPathDetailed: traceContactPath,
    });
  });

  afterEach(async () => {
    managers.clear();
    await harness.cleanup();
  });

  const url = () => `/sources/${harness.sourceA}/meshcore/contacts/${VALID_PK}/trace-path`;

  it('passes autoReturn: true through and returns the traced path', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(url()).send({ autoReturn: true });

    expect(res.status).toBe(200);
    expect(traceContactPath).toHaveBeenCalledWith(VALID_PK, { autoReturn: true });
    expect(res.body).toMatchObject({ success: true, path: ['5e', 'f6', '5e'], lastSnr: 3 });
  });

  it.each([
    ['no body', undefined],
    ['false', { autoReturn: false }],
    ['a truthy non-boolean', { autoReturn: 'yes' }],
  ])('keeps the one-way trace for %s', async (_label, body) => {
    const agent = await harness.loginAs(harness.admin);
    const req = agent.post(url());
    const res = await (body ? req.send(body) : req.send());

    expect(res.status).toBe(200);
    expect(traceContactPath).toHaveBeenCalledWith(VALID_PK, { autoReturn: false });
  });
});
