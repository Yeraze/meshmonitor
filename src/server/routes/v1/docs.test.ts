/**
 * Swagger UI / OpenAPI server URL (#6462): the spec's `servers` entry must
 * follow the mount path the docs were served from, never a hardcoded
 * localhost, so "Try it out" hits the host the page was loaded from.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import docsRouter, { apiServerUrl } from './docs.js';

function appAt(prefix: string) {
  const app = express();
  app.use(`${prefix}/api/v1/docs`, docsRouter);
  return app;
}

describe('apiServerUrl', () => {
  it('strips the /docs suffix from the mount path', () => {
    expect(apiServerUrl('/api/v1/docs')).toBe('/api/v1');
    expect(apiServerUrl('/meshmonitor/api/v1/docs')).toBe('/meshmonitor/api/v1');
  });
});

describe('v1 docs routes', () => {
  it('openapi.json uses a host-relative server URL', async () => {
    const res = await request(appAt('')).get('/api/v1/docs/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.servers).toEqual([{ url: '/api/v1', description: 'This MeshMonitor instance' }]);
    expect(JSON.stringify(res.body.servers)).not.toContain('localhost');
  });

  it('openapi.json includes BASE_URL in the server URL', async () => {
    const res = await request(appAt('/meshmonitor')).get('/meshmonitor/api/v1/docs/openapi.json');
    expect(res.body.servers[0].url).toBe('/meshmonitor/api/v1');
  });

  it('swagger-ui-init.js embeds the runtime server URL, not localhost', async () => {
    const res = await request(appAt('/meshmonitor')).get('/meshmonitor/api/v1/docs/swagger-ui-init.js');
    expect(res.status).toBe(200);
    expect(res.text).toContain('"url": "/meshmonitor/api/v1"');
    expect(res.text).not.toContain('localhost:8080');
  });

  it('serves the Swagger UI page', async () => {
    const res = await request(appAt('')).get('/api/v1/docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui-init.js');
  });
});
