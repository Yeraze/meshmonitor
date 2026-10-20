import { describe, it, expect, vi } from 'vitest';
import { OpenSkyTokenManager, REFRESH_MARGIN_MS, type TokenHttpFn } from './openSkyTokenManager.js';
import { AdsbFeedError } from './adsbFeedClient.js';
import { OPENSKY_TOKEN_URL } from '../../utils/openSky.js';

const CREDS = { clientId: 'my-client', clientSecret: 's3cret' };

function tokenHttp(responses: Array<{ status: number; body?: unknown }>): ReturnType<typeof vi.fn> & TokenHttpFn {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    return { status: r.status, json: async () => r.body };
  }) as ReturnType<typeof vi.fn> & TokenHttpFn;
}

describe('OpenSkyTokenManager (#5877)', () => {
  it('posts client credentials as a form to the token endpoint', async () => {
    const http = tokenHttp([{ status: 200, body: { access_token: 'tok-1', expires_in: 1800 } }]);
    const mgr = new OpenSkyTokenManager({ http });
    expect(await mgr.getToken(CREDS)).toBe('tok-1');
    const [url, init] = http.mock.calls[0];
    expect(url).toBe(OPENSKY_TOKEN_URL);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(init.body);
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('client_id')).toBe('my-client');
    expect(form.get('client_secret')).toBe('s3cret');
  });

  it('reuses the token until the refresh margin, then fetches a new one', async () => {
    const clock = { now: 1_000_000 };
    const http = tokenHttp([
      { status: 200, body: { access_token: 'tok-1', expires_in: 1800 } },
      { status: 200, body: { access_token: 'tok-2', expires_in: 1800 } },
    ]);
    const mgr = new OpenSkyTokenManager({ http, now: () => clock.now });
    await mgr.getToken(CREDS);
    clock.now += 1800_000 - REFRESH_MARGIN_MS - 1;
    expect(await mgr.getToken(CREDS)).toBe('tok-1');
    expect(http).toHaveBeenCalledTimes(1);
    clock.now += 1;
    expect(await mgr.getToken(CREDS)).toBe('tok-2');
    expect(http).toHaveBeenCalledTimes(2);
  });

  it('shares one request between concurrent callers', async () => {
    const http = tokenHttp([{ status: 200, body: { access_token: 'tok-1', expires_in: 1800 } }]);
    const mgr = new OpenSkyTokenManager({ http });
    const [a, b] = await Promise.all([mgr.getToken(CREDS), mgr.getToken(CREDS)]);
    expect([a, b]).toEqual(['tok-1', 'tok-1']);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('invalidate() forces a fresh token', async () => {
    const http = tokenHttp([
      { status: 200, body: { access_token: 'tok-1', expires_in: 1800 } },
      { status: 200, body: { access_token: 'tok-2', expires_in: 1800 } },
    ]);
    const mgr = new OpenSkyTokenManager({ http });
    await mgr.getToken(CREDS);
    mgr.invalidate();
    expect(await mgr.getToken(CREDS)).toBe('tok-2');
  });

  it('asks again when the credentials change', async () => {
    const http = tokenHttp([
      { status: 200, body: { access_token: 'tok-1', expires_in: 1800 } },
      { status: 200, body: { access_token: 'tok-2', expires_in: 1800 } },
    ]);
    const mgr = new OpenSkyTokenManager({ http });
    await mgr.getToken(CREDS);
    expect(await mgr.getToken({ ...CREDS, clientSecret: 'other' })).toBe('tok-2');
  });

  it('refused credentials raise a backoff error and cache nothing', async () => {
    const http = tokenHttp([{ status: 401, body: { error: 'invalid_client' } }]);
    const mgr = new OpenSkyTokenManager({ http });
    const err = await mgr.getToken(CREDS).catch((e) => e);
    expect(err).toBeInstanceOf(AdsbFeedError);
    expect(err).toMatchObject({ kind: 'auth', status: 401, backoff: true });
    expect(err.message).not.toContain('s3cret');
    await mgr.getToken(CREDS).catch(() => {});
    expect(http).toHaveBeenCalledTimes(2);
  });

  it('rejects a response without an access_token', async () => {
    const mgr = new OpenSkyTokenManager({ http: tokenHttp([{ status: 200, body: { expires_in: 1800 } }]) });
    await expect(mgr.getToken(CREDS)).rejects.toMatchObject({ kind: 'parse' });
  });
});
