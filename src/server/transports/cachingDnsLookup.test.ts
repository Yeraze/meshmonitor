import { describe, it, expect, vi } from 'vitest';
import { createCachingLookup } from './cachingDnsLookup.js';

describe('createCachingLookup', () => {
  it('resolves once and serves the cached result within the TTL', () => {
    const resolver = vi.fn((_h: string, _o: unknown, cb: any) => cb(null, '1.2.3.4', 4));
    let clock = 1000;
    const lookup = createCachingLookup({ ttlMs: 5000, resolver: resolver as any, now: () => clock });

    const cb1 = vi.fn();
    lookup('broker.example', {}, cb1);
    clock = 3000; // still within TTL
    const cb2 = vi.fn();
    lookup('broker.example', {}, cb2);

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(cb1).toHaveBeenCalledWith(null, '1.2.3.4', 4);
    expect(cb2).toHaveBeenCalledWith(null, '1.2.3.4', 4);
  });

  it('re-resolves after the TTL expires', () => {
    const resolver = vi.fn((_h: string, _o: unknown, cb: any) => cb(null, '1.2.3.4', 4));
    let clock = 1000;
    const lookup = createCachingLookup({ ttlMs: 5000, resolver: resolver as any, now: () => clock });

    lookup('h', {}, vi.fn());
    clock = 7000; // past TTL
    lookup('h', {}, vi.fn());

    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it('supports the (hostname, callback) two-argument form', () => {
    const resolver = vi.fn((_h: string, _o: unknown, cb: any) => cb(null, '5.6.7.8', 4));
    const lookup = createCachingLookup({ resolver: resolver as any });

    const cb = vi.fn();
    lookup('h', cb);

    expect(cb).toHaveBeenCalledWith(null, '5.6.7.8', 4);
  });

  it('caches all:true array results separately from single results', () => {
    const addrs = [{ address: '1.1.1.1', family: 4 }];
    const resolver = vi.fn((_h: string, _o: unknown, cb: any) => cb(null, addrs));
    const lookup = createCachingLookup({ resolver: resolver as any });

    const cb1 = vi.fn();
    lookup('h', { all: true }, cb1);
    const cb2 = vi.fn();
    lookup('h', { all: true }, cb2);

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(cb1).toHaveBeenCalledWith(null, addrs);
  });

  it('does not cache failures (so a transient DNS error is not pinned)', () => {
    const err = Object.assign(new Error('fail'), { code: 'ENOTFOUND' });
    const resolver = vi.fn((_h: string, _o: unknown, cb: any) => cb(err));
    const lookup = createCachingLookup({ resolver: resolver as any });

    const cb = vi.fn();
    lookup('h', {}, cb);
    lookup('h', {}, vi.fn());

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[0][0]).toBe(err);
  });

  it('keys the cache by family so an IPv4 hit does not satisfy an IPv6 request', () => {
    const resolver = vi.fn((_h: string, o: any, cb: any) =>
      cb(null, o.family === 6 ? '::1' : '1.2.3.4', o.family || 4),
    );
    const lookup = createCachingLookup({ resolver: resolver as any });

    lookup('h', { family: 4 }, vi.fn());
    lookup('h', { family: 6 }, vi.fn());

    expect(resolver).toHaveBeenCalledTimes(2);
  });
});
