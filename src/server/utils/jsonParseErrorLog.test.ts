import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { describeJsonParseError } from './jsonParseErrorLog.js';

describe('describeJsonParseError', () => {
  it('never includes the request body, even when the parser quotes it', async () => {
    const secret = 'sk-live-BODY-SENTINEL-1234';
    let captured: Error | null = null;
    const app = express();
    app.use(express.json());
    app.put('/x', (_req, res) => res.json({}));
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      captured = err;
      res.status(400).end();
    });
    await request(app).put('/x').set('Content-Type', 'application/json').send(`{"value":"${secret}`);
    expect(captured).not.toBeNull();
    const line = describeJsonParseError(captured as unknown as Error);
    expect(line).toMatch(/^JSON parsing error: entity\.parse\.failed/);
    for (let i = 0; i + 6 <= secret.length; i++) expect(line).not.toContain(secret.slice(i, i + 6));
  });

  it('keeps the position when the message has one', () => {
    const err = Object.assign(new SyntaxError('Unexpected token x in JSON at position 12 "secret"'), { type: 'entity.parse.failed' });
    expect(describeJsonParseError(err)).toBe('JSON parsing error: entity.parse.failed at position 12');
  });
});
