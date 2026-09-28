import { describe, it, expect } from 'vitest';
import { buildOtaGateway, parseOtaGateway, isIpv6Literal } from './otaGateway';

describe('buildOtaGateway (#5424)', () => {
  it('appends a custom port', () => {
    expect(buildOtaGateway('10.0.0.5', 5000)).toBe('10.0.0.5:5000');
    expect(buildOtaGateway('node.lan', 14403)).toBe('node.lan:14403');
  });

  it('omits the default port and missing ports', () => {
    expect(buildOtaGateway('10.0.0.5', 4403)).toBe('10.0.0.5');
    expect(buildOtaGateway('10.0.0.5', undefined)).toBe('10.0.0.5');
    expect(buildOtaGateway('10.0.0.5', null)).toBe('10.0.0.5');
  });

  it('ignores out-of-range or non-integer ports', () => {
    expect(buildOtaGateway('10.0.0.5', 0)).toBe('10.0.0.5');
    expect(buildOtaGateway('10.0.0.5', 70000)).toBe('10.0.0.5');
    expect(buildOtaGateway('10.0.0.5', 50.5)).toBe('10.0.0.5');
  });

  it('returns empty for a missing host', () => {
    expect(buildOtaGateway('', 5000)).toBe('');
    expect(buildOtaGateway(undefined, 5000)).toBe('');
    expect(buildOtaGateway('  ', 5000)).toBe('');
  });

  it('never appends a port to an IPv6 literal', () => {
    expect(buildOtaGateway('fe80::1', 5000)).toBe('fe80::1');
  });
});

describe('parseOtaGateway (#5424)', () => {
  it('reads host and default port', () => {
    expect(parseOtaGateway('10.0.0.5')).toEqual({ host: '10.0.0.5', port: 4403 });
    expect(parseOtaGateway(' node.lan ')).toEqual({ host: 'node.lan', port: 4403 });
  });

  it('reads host:port', () => {
    expect(parseOtaGateway('10.0.0.5:5000')).toEqual({ host: '10.0.0.5', port: 5000 });
    expect(parseOtaGateway('node.lan:4403')).toEqual({ host: 'node.lan', port: 4403 });
  });

  it('keeps a bare IPv6 literal whole instead of reading its last group as a port', () => {
    expect(parseOtaGateway('fe80::1')).toEqual({ host: 'fe80::1', port: 4403 });
    expect(parseOtaGateway('2001:db8::5000')).toEqual({ host: '2001:db8::5000', port: 4403 });
  });

  it('reads bracketed IPv6 with and without a port', () => {
    expect(parseOtaGateway('[fe80::1]:5000')).toEqual({ host: 'fe80::1', port: 5000 });
    expect(parseOtaGateway('[fe80::1]')).toEqual({ host: 'fe80::1', port: 4403 });
  });

  it('falls back to the default port for an invalid port', () => {
    // The host is still split off so a socket never sees `host:junk`.
    expect(parseOtaGateway('10.0.0.5:99999')).toEqual({ host: '10.0.0.5', port: 4403 });
    expect(parseOtaGateway('10.0.0.5:abc')).toEqual({ host: '10.0.0.5', port: 4403 });
    expect(parseOtaGateway('10.0.0.5:')).toEqual({ host: '10.0.0.5', port: 4403 });
  });

  it('round-trips buildOtaGateway output', () => {
    expect(parseOtaGateway(buildOtaGateway('10.0.0.5', 5000))).toEqual({ host: '10.0.0.5', port: 5000 });
    expect(parseOtaGateway(buildOtaGateway('10.0.0.5', 4403))).toEqual({ host: '10.0.0.5', port: 4403 });
  });
});

describe('isIpv6Literal', () => {
  it('detects IPv6 literals only', () => {
    expect(isIpv6Literal('fe80::1')).toBe(true);
    expect(isIpv6Literal('10.0.0.5')).toBe(false);
    expect(isIpv6Literal('node.lan')).toBe(false);
  });
});
