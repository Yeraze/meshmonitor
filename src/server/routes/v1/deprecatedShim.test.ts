/**
 * Deprecation shim tests — every legacy root-shape request should gain a
 * `Warning: 299` header pointing at the new scoped URL. (Issue #2773 follow-up.)
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { deprecationShim } from './deprecatedShim.js';

describe('deprecationShim', () => {
  it('adds a Warning: 299 header on requests that pass through', async () => {
    const app = express();
    app.use('/nodes', deprecationShim('nodes'), (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app).get('/nodes');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.headers.warning).toMatch(/^299 - /);
    expect(res.headers.warning).toMatch(/\/api\/v1\/sources\/:sourceId\//);
  });

  it('does not alter the body or status', async () => {
    const app = express();
    app.use('/nodes', deprecationShim('nodes'), (_req, res) => {
      res.status(201).json({ created: true });
    });

    const res = await request(app).get('/nodes');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ created: true });
    expect(res.headers.warning).toBeDefined();
  });

  it('does not consume the request — subsequent middleware still fires', async () => {
    const app = express();
    let nextFired = false;
    app.use('/nodes', deprecationShim('nodes'), (_req, _res, next) => {
      nextFired = true;
      next();
    }, (_req, res) => {
      res.json({});
    });

    await request(app).get('/nodes');
    expect(nextFired).toBe(true);
  });
});
