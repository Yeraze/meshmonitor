/**
 * Live directory refresh (#6337). All network is mocked: `safeFetch` is
 * replaced module-wide, and each provider gets its own fetch spy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/ssrfGuard.js', async (orig) => {
  const actual = await orig<typeof import('../../utils/ssrfGuard.js')>();
  return { ...actual, safeFetch: vi.fn() };
});

import { safeFetch, SsrfBlockedError } from '../../utils/ssrfGuard.js';
import {
  DirectoryProvider,
  directoryProvider,
  DIRECTORY_TTL_MS,
  DIRECTORY_FAILURE_BACKOFF_MS,
  DIRECTORY_MAX_BYTES,
  MQTT_ROOTS_URL,
} from './directoryProvider.js';
import { getDirectory, type MqttRootDirectory } from './directory.js';

const BUNDLED: MqttRootDirectory = {
  entries: [{ root: 'msh/US/CA/old', name: 'old', center: [38, -121], radiusKm: 50 }],
  neighbors: { 'US-CA': ['US-NV'] },
  subdivisionSegments: { US: { california: 'CA' } },
};

const LIVE = {
  entries: [{ root: 'msh/US/CA/new', name: 'new', center: [38, -121], radiusKm: 50 }],
  neighbors: { 'US-CA': ['US-NV', 'US-OR'] },
  subdivisionSegments: { US: { california: 'CA' } },
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function setup(opts: { enabled?: boolean; fetch?: ReturnType<typeof vi.fn> } = {}) {
  let t = 1_000_000;
  const clock = { advance: (ms: number) => (t += ms) };
  let enabled = opts.enabled ?? true;
  const fetch = opts.fetch ?? vi.fn(async () => jsonResponse(LIVE));
  const provider = new DirectoryProvider({
    now: () => t,
    fetch: fetch as unknown as (url: string, init: RequestInit) => Promise<Response>,
    isEnabled: async () => enabled,
    bundled: () => BUNDLED,
  });
  return { provider, fetch, clock, setEnabled: (v: boolean) => (enabled = v) };
}

describe('DirectoryProvider (#6337)', () => {
  beforeEach(() => {
    vi.mocked(safeFetch).mockReset();
  });

  it('does not fetch at import or construction', () => {
    expect(directoryProvider.status()).toEqual({ source: 'bundled' });
    const { fetch } = setup();
    expect(fetch).not.toHaveBeenCalled();
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('serves the bundled copy until a refresh succeeds', async () => {
    const { provider } = setup();
    expect(provider.current()).toBe(BUNDLED);
    await provider.refreshIfStale();
    expect(provider.current().entries.map((e) => e.root)).toEqual(['msh/US/CA/new']);
    expect(provider.status().source).toBe('live');
  });

  it('passes redirect: error, a timeout signal and the fixed URL', async () => {
    const { provider, fetch } = setup();
    await provider.refreshIfStale();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(MQTT_ROOTS_URL);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('the default fetch goes through safeFetch', async () => {
    vi.mocked(safeFetch).mockResolvedValue(jsonResponse(LIVE));
    const provider = new DirectoryProvider({ isEnabled: async () => true, bundled: () => BUNDLED });
    await provider.refreshIfStale();
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(safeFetch).mock.calls[0][1]?.redirect).toBe('error');
  });

  it('does not fetch again within the TTL, and fetches once when stale', async () => {
    const { provider, fetch, clock } = setup();
    await provider.refreshIfStale();
    clock.advance(DIRECTORY_TTL_MS - 1);
    await provider.refreshIfStale();
    expect(fetch).toHaveBeenCalledTimes(1);
    clock.advance(2);
    await provider.refreshIfStale();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shares one request between concurrent callers', async () => {
    const { provider, fetch } = setup();
    await Promise.all([provider.refreshIfStale(), provider.refreshIfStale(), provider.refreshIfStale()]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('with the setting off: no fetch, and the bundled copy comes back', async () => {
    const off = setup({ enabled: false });
    await off.provider.refreshIfStale();
    expect(off.fetch).not.toHaveBeenCalled();

    const { provider, fetch, setEnabled } = setup();
    await provider.refreshIfStale();
    expect(provider.status().source).toBe('live');
    setEnabled(false);
    await provider.refreshIfStale();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(provider.current()).toBe(BUNDLED);
    expect(provider.status()).toEqual({ source: 'bundled' });
  });

  it('is off unless told otherwise, and a per-call check overrides', async () => {
    const fetch = vi.fn(async () => jsonResponse(LIVE));
    const provider = new DirectoryProvider({ fetch, bundled: () => BUNDLED });
    await provider.refreshIfStale();
    expect(fetch).not.toHaveBeenCalled();
    await provider.refreshIfStale(async () => true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(provider.status().source).toBe('live');
  });

  it('a failing setting read counts as off', async () => {
    const fetch = vi.fn();
    const provider = new DirectoryProvider({
      fetch,
      isEnabled: async () => {
        throw new Error('db down');
      },
      bundled: () => BUNDLED,
    });
    await expect(provider.refreshIfStale()).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['HTTP 500', async () => new Response('oops', { status: 500 })],
    ['non-JSON', async () => new Response('<html>', { status: 200 })],
    ['invalid document', async () => jsonResponse({ entries: [] })],
    [
      'Content-Length over the cap',
      async () => new Response('{}', { status: 200, headers: { 'content-length': String(DIRECTORY_MAX_BYTES + 1) } }),
    ],
    [
      'streamed body over the cap',
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              const chunk = new Uint8Array(64 * 1024).fill(32);
              for (let i = 0; i < 5; i++) c.enqueue(chunk);
              c.close();
            },
          }),
          { status: 200 },
        ),
    ],
    [
      'SsrfBlockedError',
      async () => {
        throw new SsrfBlockedError('blocked', 'private');
      },
    ],
    [
      'timeout',
      async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      },
    ],
  ])('keeps the bundled copy on %s and backs off for an hour', async (_label, impl) => {
    const fetch = vi.fn(impl);
    const { provider, clock } = setup({ fetch });
    await expect(provider.refreshIfStale()).resolves.toBeUndefined();
    expect(provider.current()).toBe(BUNDLED);
    clock.advance(DIRECTORY_FAILURE_BACKOFF_MS - 1);
    await provider.refreshIfStale();
    expect(fetch).toHaveBeenCalledTimes(1);
    clock.advance(2);
    await provider.refreshIfStale();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good live copy when a later fetch fails', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(LIVE))
      .mockResolvedValueOnce(new Response('oops', { status: 500 }));
    const { provider, clock } = setup({ fetch });
    await provider.refreshIfStale();
    clock.advance(DIRECTORY_TTL_MS + 1);
    await provider.refreshIfStale();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(provider.current().entries[0].root).toBe('msh/US/CA/new');
  });

  it('replaces entries wholesale: an entry dropped upstream disappears', async () => {
    const { provider } = setup();
    await provider.refreshIfStale();
    expect(provider.current().entries.some((e) => e.root === 'msh/US/CA/old')).toBe(false);
  });

  it('falls back to the bundled section when a live section is empty or missing', async () => {
    const fetch = vi.fn(async () => jsonResponse({ entries: LIVE.entries, neighbors: {} }));
    const { provider } = setup({ fetch });
    await provider.refreshIfStale();
    expect(provider.current().neighbors).toBe(BUNDLED.neighbors);
    expect(provider.current().subdivisionSegments).toBe(BUNDLED.subdivisionSegments);
  });

  it('sends If-None-Match once it holds an ETag, and a 304 bumps fetchedAt', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(LIVE, { headers: { etag: '"abc"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const { provider, clock } = setup({ fetch });
    await provider.refreshIfStale();
    const first = provider.status().fetchedAt!;
    clock.advance(DIRECTORY_TTL_MS + 1);
    await provider.refreshIfStale();
    const init = fetch.mock.calls[1][1] as RequestInit;
    expect((init.headers as Record<string, string>)['If-None-Match']).toBe('"abc"');
    expect(provider.status().fetchedAt).toBe(first + DIRECTORY_TTL_MS + 1);
    expect(provider.current().entries[0].root).toBe('msh/US/CA/new');
  });

  it('accepts the bundled document itself', async () => {
    const real = getDirectory();
    const fetch = vi.fn(async () => jsonResponse(real));
    const { provider } = setup({ fetch });
    await provider.refreshIfStale();
    expect(provider.current().entries).toHaveLength(real.entries.length);
  });
});
