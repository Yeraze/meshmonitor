import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { messageLimiter } from './rateLimiters.js';
import { getEnvironmentConfig } from '../config/environment.js';

const env = getEnvironmentConfig();

describe('messageLimiter 429 body', () => {
  it('returns RATE_LIMITED with retryAfterSeconds and a Retry-After header', async () => {
    const app = express();
    app.set('trust proxy', false);
    app.post('/x', messageLimiter, (_req, res) => {
      res.json({ ok: true });
    });
    if (env.rateLimitMessages === 0) return; // limiter disabled in this environment
    let last = await request(app).post('/x');
    for (let i = 0; i < env.rateLimitMessages; i++) last = await request(app).post('/x');
    expect(last.status).toBe(429);
    expect(last.body.code).toBe('RATE_LIMITED');
    expect(typeof last.body.retryAfterSeconds).toBe('number');
    expect(last.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
  });
});
