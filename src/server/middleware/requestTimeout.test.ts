/**
 * A request that outlives its socket timeout must get a response, never a
 * dropped socket: browsers resend a POST whose connection closes without a
 * reply, re-running the handler (a MeshCore trace re-transmitted every 30 s).
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { respondOnSocketTimeout, extendRequestTimeout } from './requestTimeout.js';

let server: http.Server | null = null;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});

async function start(app: express.Express, socketTimeoutMs: number): Promise<number> {
  server = http.createServer(app);
  server.setTimeout(socketTimeoutMs);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return (server.address() as AddressInfo).port;
}

function post(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('respondOnSocketTimeout', () => {
  it('answers 504 instead of dropping the socket, and runs the handler once', async () => {
    let runs = 0;
    let lateReplyThrew = false;
    const app = express();
    app.use(respondOnSocketTimeout());
    app.post('/slow', async (_req, res) => {
      runs++;
      await sleep(300);
      try {
        res.json({ ok: true }); // late reply: must be dropped quietly
      } catch {
        lateReplyThrew = true;
      }
    });
    const port = await start(app, 100);

    const r = await post(port, '/slow');
    expect(r.status).toBe(504);
    expect(JSON.parse(r.body)).toMatchObject({ success: false, code: 'REQUEST_TIMEOUT' });

    await sleep(350);
    expect(runs).toBe(1);
    expect(lateReplyThrew).toBe(false);
  });

  it('leaves fast requests alone', async () => {
    const app = express();
    app.use(respondOnSocketTimeout());
    app.post('/fast', (_req, res) => { res.json({ ok: true }); });
    const port = await start(app, 100);

    const r = await post(port, '/fast');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true });
  });

  it('without it, the socket is dropped with no response (the bug)', async () => {
    const app = express();
    app.post('/slow', async (_req, res) => { await sleep(300); res.json({ ok: true }); });
    const port = await start(app, 100);

    await expect(post(port, '/slow')).rejects.toThrow(/socket hang up|ECONNRESET/);
  });
});

describe('extendRequestTimeout', () => {
  it('lets a slow route finish with its real result', async () => {
    const app = express();
    app.use(respondOnSocketTimeout());
    app.post('/radio', extendRequestTimeout(1000), async (_req, res) => {
      await sleep(300);
      res.json({ hops: 3 });
    });
    const port = await start(app, 100);

    const r = await post(port, '/radio');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ hops: 3 });
  });
});
