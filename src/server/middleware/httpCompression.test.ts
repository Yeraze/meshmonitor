import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { httpCompression, COMPRESSION_THRESHOLD_BYTES } from './httpCompression.js';

const bigPayload = Array.from({ length: 2000 }, (_, i) => ({ nodeNum: i, longName: `Node ${i}`, snr: 5.25 }));

function buildApp() {
  const app = express();
  app.use(httpCompression());
  app.get('/big', (_req, res) => res.json(bigPayload));
  app.get('/small', (_req, res) => res.json({ ok: true }));
  // Mirrors the packet/message exports: an attachment written row by row.
  app.get('/export', (_req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Content-Disposition', 'attachment; filename="packets.jsonl"');
    for (const row of bigPayload) res.write(JSON.stringify(row) + '\n');
    res.end();
  });
  app.get('/events', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${'x'.repeat(4096)}\n\n`);
    res.end();
  });
  app.get('/image', (_req, res) => {
    res.type('png').send(Buffer.alloc(8192, 1));
  });
  return app;
}

describe('httpCompression', () => {
  it('gzips a large JSON response when the client accepts gzip', async () => {
    const res = await request(buildApp()).get('/big').set('Accept-Encoding', 'gzip');
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['vary']).toMatch(/Accept-Encoding/i);
    // supertest inflates the body; the data must survive the round trip.
    expect(res.body).toEqual(bigPayload);
  });

  it('uses brotli when the client prefers it', async () => {
    const res = await request(buildApp()).get('/big').set('Accept-Encoding', 'br, gzip');
    expect(res.headers['content-encoding']).toBe('br');
  });

  it('does not compress when the client does not ask for it', async () => {
    const res = await request(buildApp()).get('/big').set('Accept-Encoding', 'identity');
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body).toEqual(bigPayload);
  });

  it(`leaves responses under ${COMPRESSION_THRESHOLD_BYTES} bytes alone`, async () => {
    const res = await request(buildApp()).get('/small').set('Accept-Encoding', 'gzip');
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('skips attachment downloads and still streams every row', async () => {
    const res = await request(buildApp()).get('/export').set('Accept-Encoding', 'gzip').buffer(true).parse((r, cb) => {
      let text = '';
      r.on('data', (c: Buffer) => { text += c.toString(); });
      r.on('end', () => cb(null, text));
    });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect((res.body as string).trim().split('\n')).toHaveLength(bigPayload.length);
  });

  it('skips Server-Sent Events', async () => {
    const res = await request(buildApp()).get('/events').set('Accept-Encoding', 'gzip');
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('skips types that are already compressed', async () => {
    const res = await request(buildApp()).get('/image').set('Accept-Encoding', 'gzip');
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('honours an x-no-compression request header', async () => {
    const res = await request(buildApp()).get('/big').set('Accept-Encoding', 'gzip').set('x-no-compression', '1');
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});
