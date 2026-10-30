/**
 * MISC-03 (#6059) — GET /channels/:id/export requires channel_N:WRITE.
 *
 * The export body embeds the channel's full base64 AES PSK — key material that
 * decrypts all traffic on the channel and lets the holder inject authenticated
 * packets. The channel listing masks PSKs for read-only callers, so the export
 * endpoint must not hand them the raw key via `channel_N:read`. These tests
 * drive the REAL channelRoutes router through the real auth middleware + real
 * `hasPermission` (via createRouteTestApp), seeding per-test permission rows.
 *
 * A write holder (or admin) still passes the gate; there is no channel row
 * seeded, so the handler then 404s — proving the permission check passed and
 * the feature is intact for authorized callers. Read-only is refused with 403.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import channelRoutes from './channelRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

let harness: RouteTestHarness;

beforeEach(async () => {
  harness = await createRouteTestApp({
    mount: (app) => app.use('/channels', channelRoutes),
  });
});

afterEach(async () => {
  await harness.cleanup();
});

describe('GET /channels/:id/export — PSK export requires channel_N:write (MISC-03)', () => {
  it('403s a caller holding only channel_2:READ on the source', async () => {
    await harness.grant(harness.limited.id, 'channel_2', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/channels/2/export?sourceId=${harness.sourceA}`);
    expect(res.status).toBe(403);
    expect(res.body.required).toEqual({ resource: 'channel_2', action: 'write' });
  });

  it('lets a caller holding channel_2:WRITE through the gate (404 — no channel seeded, not 403)', async () => {
    await harness.grant(harness.limited.id, 'channel_2', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/channels/2/export?sourceId=${harness.sourceA}`);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(404);
  });

  it('403s a write grant that is on a DIFFERENT source', async () => {
    await harness.grant(harness.limited.id, 'channel_2', 'write', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/channels/2/export?sourceId=${harness.sourceA}`);
    expect(res.status).toBe(403);
  });

  it('lets an admin through the gate without a grant (404 — no channel seeded)', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/channels/2/export?sourceId=${harness.sourceA}`);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(404);
  });

  it('refuses an anonymous caller', async () => {
    const agent = await harness.loginAs(null);
    const res = await agent.get(`/channels/2/export?sourceId=${harness.sourceA}`);
    expect([401, 403]).toContain(res.status);
  });

  it('400s without a sourceId (requireSourceId)', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/channels/2/export');
    expect(res.status).toBe(400);
  });
});
