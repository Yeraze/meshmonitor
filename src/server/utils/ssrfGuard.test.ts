import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup } from 'node:dns/promises';
import { assertSafeUrl, SsrfBlockedError } from './ssrfGuard.js';

const mockedLookup = lookup as unknown as ReturnType<typeof vi.fn>;

describe('assertSafeUrl', () => {
  beforeEach(() => {
    mockedLookup.mockReset();
  });

  describe('protocol filtering', () => {
    it('allows http and https by default', async () => {
      mockedLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      await expect(assertSafeUrl('http://example.com/')).resolves.toBeInstanceOf(URL);
      await expect(assertSafeUrl('https://example.com/')).resolves.toBeInstanceOf(URL);
    });

    it('rejects non-http(s) protocols', async () => {
      await expect(assertSafeUrl('file:///etc/passwd')).rejects.toMatchObject({
        reason: 'bad_protocol',
      });
      await expect(assertSafeUrl('gopher://example.com')).rejects.toMatchObject({
        reason: 'bad_protocol',
      });
    });

    it('honors custom protocols option', async () => {
      await expect(
        assertSafeUrl('http://example.com/', { protocols: ['https:'] })
      ).rejects.toMatchObject({ reason: 'bad_protocol' });
    });
  });

  describe('invalid URLs', () => {
    it('rejects malformed URLs', async () => {
      await expect(assertSafeUrl('not a url')).rejects.toMatchObject({
        reason: 'invalid_url',
      });
    });

    it('rejects blocked hosts by literal name', async () => {
      await expect(
        assertSafeUrl('http://metadata.google.internal/')
      ).rejects.toMatchObject({ reason: 'blocked_host' });
    });
  });

  describe('IPv4 classification', () => {
    it('blocks loopback 127/8', async () => {
      mockedLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
      await expect(assertSafeUrl('http://localhost/')).rejects.toMatchObject({
        reason: 'loopback',
      });
    });

    it('blocks AWS/GCP link-local metadata IP even when resolved via DNS', async () => {
      mockedLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
      await expect(
        assertSafeUrl('http://attacker-controlled.example/')
      ).rejects.toMatchObject({ reason: 'metadata' });
    });

    it('blocks link-local 169.254/16', async () => {
      mockedLookup.mockResolvedValue([{ address: '169.254.42.1', family: 4 }]);
      await expect(assertSafeUrl('http://host.example/')).rejects.toMatchObject({
        reason: 'link_local',
      });
    });

    it('blocks multicast 224/4', async () => {
      mockedLookup.mockResolvedValue([{ address: '224.0.0.1', family: 4 }]);
      await expect(assertSafeUrl('http://host.example/')).rejects.toMatchObject({
        reason: 'multicast',
      });
    });

    it('blocks broadcast 255.255.255.255', async () => {
      mockedLookup.mockResolvedValue([{ address: '255.255.255.255', family: 4 }]);
      await expect(assertSafeUrl('http://host.example/')).rejects.toMatchObject({
        reason: 'broadcast',
      });
    });

    it('blocks reserved ranges (0/8, CGNAT, 240/4)', async () => {
      for (const addr of ['0.1.2.3', '100.64.0.1', '240.0.0.1']) {
        mockedLookup.mockResolvedValueOnce([{ address: addr, family: 4 }]);
        await expect(assertSafeUrl('http://host.example/')).rejects.toMatchObject({
          reason: 'reserved',
        });
      }
    });

    it('allows RFC1918 in non-strict mode', async () => {
      mockedLookup.mockResolvedValue([{ address: '192.168.1.5', family: 4 }]);
      await expect(assertSafeUrl('http://host.example/')).resolves.toBeInstanceOf(URL);
    });

    it('blocks RFC1918 in strict mode', async () => {
      for (const addr of ['10.0.0.1', '172.16.0.1', '192.168.1.1']) {
        mockedLookup.mockResolvedValueOnce([{ address: addr, family: 4 }]);
        await expect(
          assertSafeUrl('http://host.example/', { strict: true })
        ).rejects.toMatchObject({ reason: 'private' });
      }
    });

    it('allows public IPv4', async () => {
      mockedLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
      await expect(
        assertSafeUrl('http://host.example/', { strict: true })
      ).resolves.toBeInstanceOf(URL);
    });
  });

  describe('IPv6 classification', () => {
    it('blocks ::1 loopback', async () => {
      mockedLookup.mockResolvedValue([{ address: '::1', family: 6 }]);
      await expect(assertSafeUrl('http://host.example/')).rejects.toMatchObject({
        reason: 'loopback',
      });
    });

    it('blocks fe80::/10 link-local', async () => {
      mockedLookup.mockResolvedValue([{ address: 'fe80::1', family: 6 }]);
      await expect(assertSafeUrl('http://host.example/')).rejects.toMatchObject({
        reason: 'link_local',
      });
    });

    it('blocks multicast ff::/8', async () => {
      mockedLookup.mockResolvedValue([{ address: 'ff02::1', family: 6 }]);
      await expect(assertSafeUrl('http://host.example/')).rejects.toMatchObject({
        reason: 'multicast',
      });
    });

    it('blocks ULA fc00::/7 in strict mode', async () => {
      mockedLookup.mockResolvedValue([{ address: 'fd12:3456::1', family: 6 }]);
      await expect(
        assertSafeUrl('http://host.example/', { strict: true })
      ).rejects.toMatchObject({ reason: 'private' });
    });

    it('blocks IPv4-mapped loopback (::ffff:127.0.0.1)', async () => {
      mockedLookup.mockResolvedValue([{ address: '::ffff:127.0.0.1', family: 6 }]);
      await expect(assertSafeUrl('http://host.example/')).rejects.toMatchObject({
        reason: 'loopback',
      });
    });

    it('blocks documentation prefix 2001:db8::/32 as reserved', async () => {
      mockedLookup.mockResolvedValue([{ address: '2001:db8::1', family: 6 }]);
      await expect(assertSafeUrl('http://host.example/')).rejects.toMatchObject({
        reason: 'reserved',
      });
    });

    it('allows public IPv6', async () => {
      mockedLookup.mockResolvedValue([{ address: '2606:4700:4700::1111', family: 6 }]);
      await expect(
        assertSafeUrl('http://host.example/', { strict: true })
      ).resolves.toBeInstanceOf(URL);
    });
  });

  describe('IP literals', () => {
    it('classifies literal IPs without DNS lookup', async () => {
      await expect(assertSafeUrl('http://127.0.0.1/')).rejects.toMatchObject({
        reason: 'loopback',
      });
      expect(mockedLookup).not.toHaveBeenCalled();
    });

    it('classifies IPv6 literal loopback', async () => {
      await expect(assertSafeUrl('http://[::1]/')).rejects.toMatchObject({
        reason: 'loopback',
      });
      expect(mockedLookup).not.toHaveBeenCalled();
    });
  });

  describe('DNS failure', () => {
    it('rejects when DNS lookup fails', async () => {
      mockedLookup.mockRejectedValue(new Error('ENOTFOUND'));
      await expect(assertSafeUrl('http://host.example/')).rejects.toMatchObject({
        reason: 'dns_failed',
      });
    });
  });

  describe('SsrfBlockedError shape', () => {
    it('carries a reason code', async () => {
      mockedLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
      try {
        await assertSafeUrl('http://localhost/');
      } catch (err) {
        expect(err).toBeInstanceOf(SsrfBlockedError);
        expect((err as SsrfBlockedError).reason).toBe('loopback');
        expect((err as SsrfBlockedError).name).toBe('SsrfBlockedError');
      }
    });
  });
});
