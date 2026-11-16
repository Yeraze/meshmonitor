import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { optionalAuth } from '../auth/authMiddleware.js';
import { publicInstanceRedaction, markPublicInstanceExempt } from './publicInstanceRedaction.js';
import {
  __setPublicInstanceConfigForTest,
  __resetPublicInstanceConfigForTest,
} from '../services/publicInstanceConfig.js';

const cfgState = vi.hoisted(() => ({ throwOnRead: false }));
vi.mock('../services/publicInstanceConfig.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../services/publicInstanceConfig.js')>();
  return {
    ...orig,
    getPublicInstanceConfig: () => {
      if (cfgState.throwOnRead) throw new Error('config read failed');
      return orig.getPublicInstanceConfig();
    },
  };
});

const SENTINEL = 'SENTINEL_LONG_NAME_XYZ';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

function buildRouter(): express.Router {
  const r = express.Router();
  const payload = () => ({ nodes: [{ nodeNum: 1, longName: SENTINEL }] });
  r.get('/json', optionalAuth(), (_req, res) => res.json(payload()));
  r.get('/noauth-json', (_req, res) => res.json(payload()));
  r.get('/v1/x', (_req, res) => res.json(payload()));
  r.get('/throws', optionalAuth(), (_req, res) =>
    res.json({
      longName: SENTINEL,
      bad: {
        toJSON() {
          throw new Error('boom');
        },
      },
    })
  );
  r.get('/poll', optionalAuth(), (_req, res) => res.type('application/json').send(JSON.stringify(payload())));
  r.get('/png', optionalAuth(), (_req, res) => res.type('image/png').send(PNG));
  r.get('/text', optionalAuth(), (_req, res) => res.type('text/plain').send(SENTINEL));
  r.get('/csv', optionalAuth(), (_req, res) =>
    res.type('text/csv').set('Content-Disposition', 'attachment; filename=x.csv').send(`longName\n${SENTINEL}\n`)
  );
  r.get('/nocontenttype', optionalAuth(), (_req, res) => {
    res.removeHeader('Content-Type');
    res.end(SENTINEL);
  });
  r.get('/ndjson', optionalAuth(), (_req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.write(`${JSON.stringify({ longName: SENTINEL })}\n`);
    res.write(`${JSON.stringify({ longName: SENTINEL })}\n`);
    res.end();
  });
  r.get('/octet', optionalAuth(), (_req, res) => res.type('application/octet-stream').send(Buffer.from(SENTINEL)));
  r.get('/octet-exempt', optionalAuth(), (_req, res) => {
    markPublicInstanceExempt(res);
    res.type('application/octet-stream').send(Buffer.from(SENTINEL));
  });
  r.get('/geo-exempt', optionalAuth(), (_req, res) => {
    markPublicInstanceExempt(res);
    res.setHeader('Content-Type', 'application/geo+json');
    res.send(JSON.stringify({ type: 'FeatureCollection', features: [], longName: SENTINEL }));
  });
  r.get('/geo', optionalAuth(), (_req, res) => {
    res.setHeader('Content-Type', 'application/geo+json');
    res.send(JSON.stringify({ type: 'FeatureCollection', features: [], longName: SENTINEL }));
  });
  r.get('/missing', optionalAuth(), (_req, res) => res.sendStatus(404));
  return r;
}

describe('publicInstanceRedaction middleware', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    __setPublicInstanceConfigForTest({ enabled: true });
    harness = await createRouteTestApp({
      useOptionalAuth: false,
      mount: (app) => {
        app.use('/api', publicInstanceRedaction(), buildRouter());
        app.use('/embed', publicInstanceRedaction({ forceAnonymous: true }), buildRouter());
      },
    });
  });

  afterEach(async () => {
    cfgState.throwOnRead = false;
    __resetPublicInstanceConfigForTest();
    await harness.cleanup();
  });

  it('redacts an anonymous JSON response', async () => {
    const res = await request(harness.app).get('/api/json');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(SENTINEL);
  });

  it('sets Vary: Cookie, Authorization when the mode is on', async () => {
    const res = await request(harness.app).get('/api/json');
    expect(res.headers.vary).toMatch(/Cookie/);
    expect(res.headers.vary).toMatch(/Authorization/);
  });

  it('leaves an admin response untouched', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/api/json');
    expect(res.text).toContain(SENTINEL);
  });

  it('is byte-identical with the mode off', async () => {
    __setPublicInstanceConfigForTest({ enabled: false });
    const res = await request(harness.app).get('/api/json');
    expect(res.text).toBe(JSON.stringify({ nodes: [{ nodeNum: 1, longName: SENTINEL }] }));
    expect(res.headers.vary ?? '').not.toMatch(/Authorization/);
  });

  it('leaves a signed-in session untouched on a route with no auth middleware', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/api/noauth-json');
    expect(res.text).toContain(SENTINEL);
  });

  it('forceAnonymous redacts even a logged-in session', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/embed/json');
    expect(res.text).not.toContain(SENTINEL);
  });

  it('skips /v1 paths', async () => {
    const res = await request(harness.app).get('/api/v1/x');
    expect(res.text).toContain(SENTINEL);
  });

  it('answers 503 PUBLIC_REDACTION_FAILED when redaction throws, without leaking', async () => {
    const res = await request(harness.app).get('/api/throws');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PUBLIC_REDACTION_FAILED');
    expect(res.text).not.toContain(SENTINEL);
  });

  it('redacts a JSON string sent via send (the poll shape)', async () => {
    const res = await request(harness.app).get('/api/poll');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(SENTINEL);
  });

  it('passes image/png byte-identical for anonymous', async () => {
    const res = await request(harness.app).get('/api/png').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body as Buffer, PNG)).toBe(0);
  });

  it('blocks text/plain with 403', async () => {
    const res = await request(harness.app).get('/api/text');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PUBLIC_INSTANCE_UNSUPPORTED_RESPONSE');
    expect(res.text).not.toContain(SENTINEL);
  });

  it('blocks a res.write NDJSON stream with 403', async () => {
    const res = await request(harness.app).get('/api/ndjson');
    expect(res.status).toBe(403);
    expect(res.text).not.toContain(SENTINEL);
  });

  it('blocks text/csv and strips Content-Disposition', async () => {
    const res = await request(harness.app).get('/api/csv');
    expect(res.status).toBe(403);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.text).not.toContain(SENTINEL);
  });

  it('blocks a response with no Content-Type', async () => {
    const res = await request(harness.app).get('/api/nocontenttype');
    expect(res.status).toBe(403);
    expect(res.text).not.toContain(SENTINEL);
  });

  it('blocks a non-exempt octet-stream', async () => {
    const res = await request(harness.app).get('/api/octet');
    expect(res.status).toBe(403);
  });

  it('passes an exempt octet-stream unredacted', async () => {
    const res = await request(harness.app).get('/api/octet-exempt').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).toString()).toBe(SENTINEL);
  });

  it('passes exempt geo+json unredacted and redacts non-exempt geo+json', async () => {
    const exempt = await request(harness.app).get('/api/geo-exempt');
    expect(exempt.status).toBe(200);
    expect(exempt.text).toContain(SENTINEL);
    const plain = await request(harness.app).get('/api/geo');
    expect(plain.status).toBe(200);
    expect(plain.text).not.toContain(SENTINEL);
  });

  it('keeps sendStatus(404) as 404', async () => {
    const res = await request(harness.app).get('/api/missing');
    expect(res.status).toBe(404);
  });

  it('fails closed (503) for an anonymous viewer when the config read throws', async () => {
    cfgState.throwOnRead = true;
    const res = await request(harness.app).get('/api/json');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PUBLIC_REDACTION_FAILED');
    expect(res.text).not.toContain(SENTINEL);
    const csv = await request(harness.app).get('/api/ndjson');
    expect(csv.status).toBe(503);
    expect(csv.text).not.toContain(SENTINEL);
  });

  it('still passes a signed-in viewer through when the config read throws', async () => {
    const agent = await harness.loginAs(harness.admin);
    cfgState.throwOnRead = true;
    const res = await agent.get('/api/json');
    expect(res.status).toBe(200);
    expect(res.text).toContain(SENTINEL);
  });
});
