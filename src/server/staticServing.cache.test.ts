import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const env = vi.hoisted(() => ({ baseUrl: '' }));

vi.mock('./config/environment.js', () => ({
  getEnvironmentConfig: () => ({ baseUrl: env.baseUrl }),
}));
vi.mock('../services/database.js', () => ({
  default: { settings: { getSetting: vi.fn().mockResolvedValue(null) } },
}));

import {
  configureStaticServing,
  cacheControlForBuildFile,
  IMMUTABLE_ASSET_CACHE_CONTROL,
  REVALIDATE_CACHE_CONTROL,
} from './staticServing.js';

let buildPath: string;

beforeAll(() => {
  buildPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-static-'));
  const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(buildPath, rel)), { recursive: true });
    fs.writeFileSync(path.join(buildPath, rel), body);
  };
  write('index.html', '<!doctype html><html><head></head><body><script src="/assets/main-abc123.js"></script></body></html>');
  write('assets/main-abc123.js', 'console.log(1);');
  write('locales/en.json', '{"hello":"Hello"}');
  write('sw.js', 'self.addEventListener("install",()=>{});');
  write('registerSW.js', "navigator.serviceWorker.register('/sw.js', { scope: '/' })");
  write('manifest.webmanifest', '{"name":"MeshMonitor","scope":"/","start_url":"/"}');
  write('favicon.ico', 'ico');
});

afterAll(() => {
  fs.rmSync(buildPath, { recursive: true, force: true });
});

function buildApp(baseUrl: string) {
  env.baseUrl = baseUrl;
  const app = express();
  configureStaticServing(app, { buildPath });
  return app;
}

describe('cacheControlForBuildFile', () => {
  it('ignores "assets" or "locales" in the path above the build dir', () => {
    const odd = path.join(os.tmpdir(), 'assets', 'locales', 'dist');
    expect(cacheControlForBuildFile(odd, path.join(odd, 'favicon.ico'))).toBeNull();
    expect(cacheControlForBuildFile(odd, path.join(odd, 'assets', 'a-1.js'))).toBe(IMMUTABLE_ASSET_CACHE_CONTROL);
  });
});

describe.each([
  ['with BASE_URL', '/meshmonitor'],
  ['at the root', ''],
])('static cache headers %s', (_label, base) => {
  const app = () => buildApp(base);

  it('caches hashed assets for a year as immutable', async () => {
    const res = await request(app()).get(`${base}/assets/main-abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe(IMMUTABLE_ASSET_CACHE_CONTROL);
  });

  it('makes the HTML shell revalidate', async () => {
    const res = await request(app()).get(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.headers['cache-control']).toBe(REVALIDATE_CACHE_CONTROL);
  });

  it('makes SPA deep links revalidate', async () => {
    const res = await request(app()).get(`${base}/nodes`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe(REVALIDATE_CACHE_CONTROL);
  });

  it.each(['sw.js', 'registerSW.js', 'manifest.webmanifest', 'locales/en.json'])(
    'makes %s revalidate',
    async (file) => {
      const res = await request(app()).get(`${base}/${file}`);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe(REVALIDATE_CACHE_CONTROL);
    },
  );

  it('leaves other static files on the express default', async () => {
    const res = await request(app()).get(`${base}/favicon.ico`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=0');
  });
});
