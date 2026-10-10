/**
 * GET /api/sources/:id/nodes/:nodeNum/pki-exchange (#5691) — per-source
 * isolation and the nodes:read gate, on the real-middleware harness. Also pins
 * that a settings save of the Reliable PKI mode leaves the persisted hourly
 * priming timer alone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import pkiExchangeStateRoutes, { toPkiExchangeStateResponse } from './pkiExchangeStateRoutes.js';
import settingsRoutes from './settingsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { PKI_EXCHANGE_TIMEOUT_MS, PRIMING_MIN_INTERVAL_MS } from '../services/reliablePki.js';

const NODE = 0xdeadbeef;

describe('GET /sources/:id/nodes/:nodeNum/pki-exchange', () => {
  let harness: RouteTestHarness;
  const url = (sourceId: string, nodeNum: number | string = NODE) => `/sources/${sourceId}/nodes/${nodeNum}/pki-exchange`;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => {
        const parent = express.Router();
        parent.use('/:id/nodes/:nodeNum/pki-exchange', pkiExchangeStateRoutes);
        app.use('/sources', parent);
        app.use('/settings', settingsRoutes);
      },
    });
    await harness.db.pkiExchangeState.markFailed(harness.sourceA, NODE, 'pki_unknown_pubkey', Date.now() - 1000);
    await harness.db.pkiExchangeState.recordPriming(harness.sourceA, NODE, Date.now() - 1000);
    await harness.db.pkiExchangeState.markSuccessful(harness.sourceB, NODE, Date.now() - 1000);
  });

  afterEach(async () => {
    await harness.db.pkiExchangeState.deleteBySourceId(harness.sourceA).catch(() => {});
    await harness.db.pkiExchangeState.deleteBySourceId(harness.sourceB).catch(() => {});
    await harness.db.settings.deleteSetting('reliablePkiMode').catch(() => {});
    await harness.db.settings.deleteSetting(`source:${harness.sourceA}:reliablePkiSourceMode`).catch(() => {});
    await harness.db.settings.deleteSetting(`source:${harness.sourceA}:reliablePkiMode`).catch(() => {});
    await harness.cleanup();
  });

  it('denies a user without nodes:read on the source', async () => {
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(url(harness.sourceA))).status).toBe(403);
  });

  it('a grant on source B does not open source A', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(url(harness.sourceA))).status).toBe(403);
    const b = await agent.get(url(harness.sourceB));
    expect(b.status).toBe(200);
    expect(b.body.data.state).toBe('successful');
  });

  it('returns this source\'s row only', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(url(harness.sourceA));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ state: 'failed', lastFailureReason: 'pki_unknown_pubkey', mode: 'off' });
    expect(res.body.data.nextPrimingAllowedAt).toBeGreaterThan(Date.now());
  });

  it('null when nothing is recorded, 400 on a bad node number', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(url(harness.sourceA, 42))).body).toEqual({ success: true, data: null });
    expect((await agent.get(url(harness.sourceA, 'abc'))).status).toBe(400);
  });

  it('saving the Reliable PKI mode leaves the persisted priming timer alone', async () => {
    const before = await harness.db.pkiExchangeState.getState(harness.sourceA, NODE);
    const admin = await harness.loginAs(harness.admin);
    const r1 = await admin.post('/settings').send({ reliablePkiMode: 'asNeeded' });
    expect(r1.status).toBe(200);
    const r2 = await admin.post(`/settings?sourceId=${harness.sourceA}`).send({ reliablePkiSourceMode: 'off' });
    expect(r2.status).toBe(200);
    const after = await harness.db.pkiExchangeState.getState(harness.sourceA, NODE);
    expect(after?.lastPrimedAt).toBe(before?.lastPrimedAt);
    expect(after?.state).toBe('failed');
  });

  it('rejects an unknown mode', async () => {
    const admin = await harness.loginAs(harness.admin);
    const bad = await admin.post('/settings').send({ reliablePkiMode: 'always' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_RELIABLE_PKI_MODE');
    const badSrc = await admin.post(`/settings?sourceId=${harness.sourceA}`).send({ reliablePkiSourceMode: 'sometimes' });
    expect(badSrc.status).toBe(400);
  });

  it('accepts "avoid" (#5711) for the global default and the per-source override', async () => {
    const admin = await harness.loginAs(harness.admin);
    expect((await admin.post('/settings').send({ reliablePkiMode: 'avoid' })).status).toBe(200);
    expect(await harness.db.settings.getSetting('reliablePkiMode')).toBe('avoid');
    expect((await admin.post(`/settings?sourceId=${harness.sourceA}`).send({ reliablePkiSourceMode: 'avoid' })).status).toBe(200);
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'reliablePkiSourceMode')).toBe('avoid');
  });

  it('a per-source save of the global key is dropped (global-only)', async () => {
    const admin = await harness.loginAs(harness.admin);
    await admin.post(`/settings?sourceId=${harness.sourceA}`).send({ reliablePkiMode: 'asNeeded' });
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'reliablePkiMode')).toBeNull();
  });
});

describe('toPkiExchangeStateResponse', () => {
  const base = {
    sourceId: 's', nodeNum: 1, stateChangedAt: 0, lastSuccessAt: null, failingSince: null,
    lastFailureReason: null, lastPrimedAt: null, updatedAt: 0,
  };
  it('a pending row older than the deadline reads unknown (e.g. after a restart)', () => {
    expect(toPkiExchangeStateResponse({ ...base, state: 'pending' }, 'off', PKI_EXCHANGE_TIMEOUT_MS + 1).state).toBe('unknown');
    expect(toPkiExchangeStateResponse({ ...base, state: 'pending' }, 'off', 10).state).toBe('pending');
  });
  it('nextPrimingAllowedAt is null once the hour has passed', () => {
    const r = toPkiExchangeStateResponse({ ...base, state: 'failed', lastPrimedAt: 0 }, 'asNeeded', PRIMING_MIN_INTERVAL_MS + 1);
    expect(r.nextPrimingAllowedAt).toBeNull();
  });
});
