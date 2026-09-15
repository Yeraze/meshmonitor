/**
 * POST/GET /api/settings/traceroute-nodes — per-filter combine modes (#5230).
 *
 * The five node-matching filters used to be a hard-coded union, so a channel
 * selection could only widen the candidate pool. Each now carries a mode, and
 * three things about that have to hold at the API boundary:
 *
 * 1. An install that never sends a mode keeps `'or'` — the behaviour it had.
 * 2. `'and'` round-trips, per source, without leaking to a sibling source.
 * 3. A junk mode is REJECTED rather than coerced. Silently reading an unknown
 *    value as `'or'` would widen the selection — more airtime, not less — which
 *    is the opposite of what a user reaching for `'and'` asked for.
 *
 * Uses the real-middleware harness per CLAUDE.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import settingsRoutes from './settingsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

let harness: RouteTestHarness;

/** A minimally valid body; the route requires `enabled` and `nodeNums`. */
const body = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  nodeNums: [],
  filterChannels: [163],
  ...over,
});

beforeEach(async () => {
  harness = await createRouteTestApp({
    mount: (app) => app.use('/api/settings', settingsRoutes),
  });
});

afterEach(async () => {
  await harness.db.settings.deleteSourceSettings(harness.sourceA).catch(() => {});
  await harness.db.settings.deleteSourceSettings(harness.sourceB).catch(() => {});
  await harness.cleanup();
});

const url = (sourceId: string) => `/api/settings/traceroute-nodes?sourceId=${sourceId}`;

describe('traceroute filter combine modes', () => {
  it('defaults every mode to or when none is sent', async () => {
    // The back-compat guarantee: an existing install POSTs no mode fields at
    // all, and must not silently acquire a scope it never asked for.
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(url(harness.sourceA)).send(body());

    expect(res.status).toBe(200);
    expect(res.body.filterNodesMode).toBe('or');
    expect(res.body.filterChannelsMode).toBe('or');
    expect(res.body.filterRolesMode).toBe('or');
    expect(res.body.filterHwModelsMode).toBe('or');
    expect(res.body.filterRegexMode).toBe('or');
  });

  it('round-trips and through a save and a re-read', async () => {
    const agent = await harness.loginAs(harness.admin);
    await agent.post(url(harness.sourceA)).send(body({ filterChannelsMode: 'and' }));

    const got = await agent.get(url(harness.sourceA));
    expect(got.status).toBe(200);
    expect(got.body.filterChannelsMode).toBe('and');
    // Untouched filters stay on the default.
    expect(got.body.filterRolesMode).toBe('or');
  });

  it('keeps one source’s mode out of another’s', async () => {
    const agent = await harness.loginAs(harness.admin);
    await agent.post(url(harness.sourceA)).send(body({ filterChannelsMode: 'and' }));

    const other = await agent.get(url(harness.sourceB));
    expect(other.body.filterChannelsMode).toBe('or');
  });

  it('rejects a mode that is neither or nor and', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(url(harness.sourceA)).send(body({ filterChannelsMode: 'AND' }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/filterChannelsMode/);
  });

  it('rejects junk on any of the five, not just the channel one', async () => {
    const agent = await harness.loginAs(harness.admin);
    for (const field of [
      'filterNodesMode', 'filterChannelsMode', 'filterRolesMode',
      'filterHwModelsMode', 'filterRegexMode',
    ]) {
      const res = await agent.post(url(harness.sourceA)).send(body({ [field]: 'maybe' }));
      expect(res.status, field).toBe(400);
    }
  });

  it('leaves a stored mode alone when the field is omitted on a later save', async () => {
    // The UI always sends all five, but a scripted caller may not — and a save
    // that silently reset a scope would quietly widen the traced set.
    const agent = await harness.loginAs(harness.admin);
    await agent.post(url(harness.sourceA)).send(body({ filterChannelsMode: 'and' }));
    await agent.post(url(harness.sourceA)).send(body({ filterRoles: [2] }));

    const got = await agent.get(url(harness.sourceA));
    expect(got.body.filterChannelsMode).toBe('and');
  });

  it('refuses a user without settings:write on this source', async () => {
    await harness.grant(harness.limited.id, 'settings', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(url(harness.sourceA)).send(body({ filterChannelsMode: 'and' }));
    expect(res.status).toBe(403);
  });
});
