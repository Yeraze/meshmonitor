import { describe, it, expect } from 'vitest';
import {
  scopeTransportKey,
  computeTransportCode,
  resolveMessageScope,
} from './meshcoreScopeResolve.js';

// Ground-truth vectors computed from the authoritative firmware algorithm
// (TransportKey::calcTransportCode, mirrored by meshcore-ha's match_flood_scope):
//   key  = SHA-256("#" + name)[:16]
//   code = LE16(HMAC-SHA256(key, [payloadType, ...payload])[:2]), clamp 0->1 / 0xFFFF->0xFFFE
describe('meshcoreScopeResolve: scopeTransportKey', () => {
  it('is SHA-256("#"+name) truncated to 16 bytes', () => {
    expect(scopeTransportKey('muenchen').toString('hex')).toBe('3f50b3350a8ed17a303f07e9641dff4a');
    expect(scopeTransportKey('sample-city').toString('hex')).toBe('69a6dcd3eb05b4520bfa3e3522f2d953');
    expect(scopeTransportKey('bot').length).toBe(16);
  });
});

describe('meshcoreScopeResolve: computeTransportCode', () => {
  it('matches the firmware HMAC for known vectors (payloadType=5, payload=deadbeef)', () => {
    expect(computeTransportCode('muenchen', 0x05, 'deadbeef')).toBe(50998);
    expect(computeTransportCode('sample-city', 0x05, 'deadbeef')).toBe(40293);
    expect(computeTransportCode('bot', 0x05, 'deadbeef')).toBe(35587);
  });

  it('is payload-dependent (content-keyed HMAC, not a static name hash)', () => {
    expect(computeTransportCode('muenchen', 0x05, 'cafe0102')).toBe(30479);
    expect(computeTransportCode('muenchen', 0x05, 'cafe0102'))
      .not.toBe(computeTransportCode('muenchen', 0x05, 'deadbeef'));
  });

  it('never returns the two reserved values (0x0000 / 0xFFFF)', () => {
    for (let i = 0; i < 64; i++) {
      const code = computeTransportCode(`scope-${i}`, 0x05, 'aa' + i.toString(16).padStart(2, '0'));
      expect(code).not.toBe(0x0000);
      expect(code).not.toBe(0xffff);
      expect(code).toBeGreaterThanOrEqual(1);
      expect(code).toBeLessThanOrEqual(0xfffe);
    }
  });
});

describe('meshcoreScopeResolve: resolveMessageScope', () => {
  // TRANSPORT_FLOOD packet (route_type=0): header 0x14 (payloadType=5),
  // transportCode1=30479 (LE 0f77), code2=0, path byte 0x02 (1-byte hash, 2 hops
  // a3,7f), payload cafe0102 → was sent under scope "muenchen".
  const SCOPED = '140f77000002a37fcafe0102';
  // Same but route_type=1 (FLOOD) → no transport code → unscoped.
  const UNSCOPED = '1502a37fcafe0102';

  it('resolves a scoped packet to the matching known scope name', () => {
    expect(resolveMessageScope(SCOPED, ['muenchen', 'bot'])).toEqual({
      scopeCode: 30479,
      scopeName: 'muenchen',
    });
  });

  it('returns the raw code with a null name when the scope is unknown', () => {
    expect(resolveMessageScope(SCOPED, ['bot', 'sample-city'])).toEqual({
      scopeCode: 30479,
      scopeName: null,
    });
  });

  it('reports scopeCode 0 (known-unscoped) for a non-transport route', () => {
    expect(resolveMessageScope(UNSCOPED, ['muenchen'])).toEqual({
      scopeCode: 0,
      scopeName: null,
    });
  });

  it('trims and ignores blank candidate names', () => {
    expect(resolveMessageScope(SCOPED, ['', '  ', ' muenchen '])).toEqual({
      scopeCode: 30479,
      scopeName: 'muenchen',
    });
  });

  it('returns null/null for empty, missing, or undecodable raw hex', () => {
    expect(resolveMessageScope('', ['muenchen'])).toEqual({ scopeCode: null, scopeName: null });
    expect(resolveMessageScope(null, ['muenchen'])).toEqual({ scopeCode: null, scopeName: null });
    expect(resolveMessageScope(undefined, ['muenchen'])).toEqual({ scopeCode: null, scopeName: null });
  });

  it('returns null scopeCode when a transport packet is truncated before its codes', () => {
    // header 0x14 (TRANSPORT_FLOOD) but only 2 of the 4 transport-code bytes.
    expect(resolveMessageScope('140f77', ['muenchen'])).toEqual({
      scopeCode: null,
      scopeName: null,
    });
  });
});
