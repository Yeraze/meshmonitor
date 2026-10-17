/**
 * Service worker push renewal (#5863): the SW must send the OLD endpoint to
 * /api/push/renew with a CSRF token, and must treat an HTTP error as a failure.
 */
import { describe, it, expect, vi } from 'vitest';
import { renewPushSubscription, type PushRenewalDeps } from './pushRenewal';

const SCOPE = 'https://mesh.example.com/meshmonitor/';
const OLD = 'https://push.example.com/old';
const NEW = 'https://push.example.com/new';

const key = (bytes: number[]) => new Uint8Array(bytes).buffer;

const fakeSubscription = (endpoint: string) => ({
  endpoint,
  getKey: (name: string) => (name === 'p256dh' ? key([1, 2, 3]) : key([4, 5])),
}) as unknown as PushSubscription;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function makeDeps(renewStatus = 200) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('api/csrf-token')) return jsonResponse({ csrfToken: 'tok-123' });
    if (url.endsWith('api/push/renew')) {
      return renewStatus === 200
        ? jsonResponse({ success: true, renewed: 2, skipped: 0 })
        : jsonResponse({ error: 'nope' }, renewStatus);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  const subscribe = vi.fn().mockResolvedValue(fakeSubscription(NEW));
  const deps: PushRenewalDeps = {
    scope: SCOPE,
    pushManager: { subscribe },
    fetch: fetchMock as unknown as typeof fetch,
  };
  return { deps, fetchMock, subscribe };
}

describe('renewPushSubscription (#5863)', () => {
  it('posts the old endpoint and new keys to /api/push/renew with a CSRF token', async () => {
    const { deps, fetchMock, subscribe } = makeDeps();

    const result = await renewPushSubscription(
      { oldSubscription: { endpoint: OLD, options: { userVisibleOnly: true } } },
      deps,
    );

    expect(result).toEqual({ status: 'renewed', renewed: 2, skipped: 0 });
    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true });

    const [tokenUrl] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe(`${SCOPE}api/csrf-token`);

    const [renewUrl, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(renewUrl).toBe(`${SCOPE}api/push/renew`);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBe('tok-123');
    expect(JSON.parse(init.body as string)).toEqual({
      oldEndpoint: OLD,
      subscription: { endpoint: NEW, keys: { p256dh: btoa('\x01\x02\x03'), auth: btoa('\x04\x05') } },
    });
  });

  it('uses the browser-supplied newSubscription instead of subscribing again', async () => {
    const { deps, subscribe, fetchMock } = makeDeps();

    await renewPushSubscription(
      { oldSubscription: { endpoint: OLD }, newSubscription: fakeSubscription(NEW) },
      deps,
    );

    expect(subscribe).not.toHaveBeenCalled();
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string).subscription.endpoint).toBe(NEW);
  });

  it('throws when the server rejects the renewal (fetch resolves on HTTP errors)', async () => {
    const { deps } = makeDeps(403);

    await expect(
      renewPushSubscription({ oldSubscription: { endpoint: OLD } }, deps),
    ).rejects.toThrow('HTTP 403');
  });

  it('makes no server call without an old endpoint to look up', async () => {
    const { deps, fetchMock } = makeDeps();

    const result = await renewPushSubscription({ oldSubscription: null }, deps);

    expect(result).toEqual({ status: 'no-old-endpoint' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
