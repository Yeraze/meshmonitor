/**
 * MFA (Multi-Factor Authentication) Service Tests
 *
 * Tests TOTP secret generation, QR code generation,
 * token verification, and backup code management.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock otplib - we need to mock verifySync since it requires real TOTP interaction
vi.mock('otplib', () => ({
  generateSecret: vi.fn(() => 'JBSWY3DPEHPK3PXP'),
  generateURI: vi.fn(({ secret, issuer, label }: { secret: string; issuer: string; label: string }) =>
    `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`
  ),
  verifySync: vi.fn()
}));

import { MfaService } from './mfa.js';
import { verifySync } from 'otplib';

describe('MfaService', () => {
  let service: MfaService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new MfaService();
  });

  describe('generateSecret', () => {
    it('should return a secret and otpauth URL', () => {
      const result = service.generateSecret('testuser');

      expect(result).toHaveProperty('secret');
      expect(result).toHaveProperty('otpauthUrl');
      expect(typeof result.secret).toBe('string');
      expect(typeof result.otpauthUrl).toBe('string');
    });

    it('should generate an otpauth URL with correct format', () => {
      const result = service.generateSecret('testuser');

      expect(result.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
      expect(result.otpauthUrl).toContain('MeshMonitor');
      expect(result.otpauthUrl).toContain('testuser');
      expect(result.otpauthUrl).toContain('secret=');
      expect(result.otpauthUrl).toContain('issuer=');
    });

    it('should include the username in the label', () => {
      const result = service.generateSecret('alice');

      expect(result.otpauthUrl).toContain('alice');
    });

    it('should not produce a double-issuer in the label', () => {
      const result = service.generateSecret('testuser');

      // The URI should NOT contain MeshMonitor:MeshMonitor (double issuer)
      expect(result.otpauthUrl).not.toContain('MeshMonitor%3AMeshMonitor');
      expect(result.otpauthUrl).not.toContain('MeshMonitor:MeshMonitor');
    });

    it('should return a non-empty secret', () => {
      const result = service.generateSecret('testuser');

      expect(result.secret.length).toBeGreaterThan(0);
    });
  });

  describe('generateQrCode', () => {
    it('should generate a data URL starting with data:image/png', async () => {
      const otpauthUrl = 'otpauth://totp/MeshMonitor:testuser?secret=JBSWY3DPEHPK3PXP&issuer=MeshMonitor';
      const dataUrl = await service.generateQrCode(otpauthUrl);

      expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    });

    it('should return a non-empty data URL', async () => {
      const otpauthUrl = 'otpauth://totp/MeshMonitor:testuser?secret=JBSWY3DPEHPK3PXP&issuer=MeshMonitor';
      const dataUrl = await service.generateQrCode(otpauthUrl);

      expect(dataUrl.length).toBeGreaterThan('data:image/png;base64,'.length);
    });
  });

  describe('verifyToken', () => {
    it('should return true when verifySync indicates valid', () => {
      (verifySync as ReturnType<typeof vi.fn>).mockReturnValue({ valid: true });

      const result = service.verifyToken('JBSWY3DPEHPK3PXP', '123456');

      expect(result).toBe(true);
      expect(verifySync).toHaveBeenCalledWith({
        token: '123456',
        secret: 'JBSWY3DPEHPK3PXP',
        epochTolerance: 30
      });
    });

    it('should return false when verifySync indicates invalid', () => {
      (verifySync as ReturnType<typeof vi.fn>).mockReturnValue({ valid: false });

      const result = service.verifyToken('JBSWY3DPEHPK3PXP', '000000');

      expect(result).toBe(false);
    });

    it('should return false when verifySync throws an error', () => {
      (verifySync as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Invalid token');
      });

      const result = service.verifyToken('INVALID_SECRET', 'bad-token');

      expect(result).toBe(false);
    });

    it('should not throw when verifySync throws', () => {
      (verifySync as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Something went wrong');
      });

      expect(() => service.verifyToken('secret', 'token')).not.toThrow();
    });
  });

  describe('generateBackupCodes', () => {
    it('should generate the default count of 10 codes', () => {
      const codes = service.generateBackupCodes();

      expect(codes).toHaveLength(10);
    });

    it('should generate the specified count of codes', () => {
      const codes = service.generateBackupCodes(5);

      expect(codes).toHaveLength(5);
    });

    it('should generate codes that are 8 characters long', () => {
      const codes = service.generateBackupCodes();

      for (const code of codes) {
        expect(code).toHaveLength(8);
      }
    });

    it('should generate uppercase hex codes', () => {
      const codes = service.generateBackupCodes();

      for (const code of codes) {
        expect(code).toMatch(/^[0-9A-F]{8}$/);
      }
    });

    it('should generate unique codes', () => {
      const codes = service.generateBackupCodes();
      const uniqueCodes = new Set(codes);

      expect(uniqueCodes.size).toBe(codes.length);
    });

    it('should generate different codes on each call', () => {
      const codes1 = service.generateBackupCodes();
      const codes2 = service.generateBackupCodes();

      // Extremely unlikely that all codes would be identical
      const allSame = codes1.every((code, i) => code === codes2[i]);
      expect(allSame).toBe(false);
    });
  });

  describe('hashBackupCodes', () => {
    it('should hash all codes', async () => {
      const codes = ['ABCD1234', 'EFGH5678', '12345678'];
      const hashed = await service.hashBackupCodes(codes);

      expect(hashed).toHaveLength(codes.length);
    });

    it('should produce bcrypt format hashes', async () => {
      const codes = ['ABCD1234'];
      const hashed = await service.hashBackupCodes(codes);

      // bcrypt hashes start with $2b$ (or $2a$)
      expect(hashed[0]).toMatch(/^\$2[ab]\$/);
    });

    it('should produce hashes different from the original codes', async () => {
      const codes = ['ABCD1234', 'EFGH5678'];
      const hashed = await service.hashBackupCodes(codes);

      for (let i = 0; i < codes.length; i++) {
        expect(hashed[i]).not.toBe(codes[i]);
      }
    });

    it('should produce different hashes for different codes', async () => {
      const codes = ['AAAAAAAA', 'BBBBBBBB'];
      const hashed = await service.hashBackupCodes(codes);

      expect(hashed[0]).not.toBe(hashed[1]);
    });
  });

  describe('verifyBackupCode', () => {
    it('should match a valid code and return remaining hashed codes', async () => {
      const codes = ['ABCD1234', 'EFGH5678', '11223344'];
      const hashed = await service.hashBackupCodes(codes);

      const result = await service.verifyBackupCode('ABCD1234', hashed);

      expect(result).not.toBeNull();
      expect(result).toHaveLength(2);
    });

    it('should remove only the matched code from the list', async () => {
      const codes = ['AAAA1111', 'BBBB2222', 'CCCC3333'];
      const hashed = await service.hashBackupCodes(codes);

      const result = await service.verifyBackupCode('BBBB2222', hashed);

      expect(result).not.toBeNull();
      expect(result).toHaveLength(2);

      // The remaining hashes should still match the other two codes
      const matchFirst = await service.verifyBackupCode('AAAA1111', result!);
      expect(matchFirst).not.toBeNull();

      const matchThird = await service.verifyBackupCode('CCCC3333', result!);
      expect(matchThird).not.toBeNull();
    });

    it('should return null for an invalid code', async () => {
      const codes = ['ABCD1234', 'EFGH5678'];
      const hashed = await service.hashBackupCodes(codes);

      const result = await service.verifyBackupCode('WRONGCODE', hashed);

      expect(result).toBeNull();
    });

    it('should return null when no hashed codes are provided', async () => {
      const result = await service.verifyBackupCode('ABCD1234', []);

      expect(result).toBeNull();
    });

    it('should be case-insensitive', async () => {
      const codes = ['ABCD1234'];
      const hashed = await service.hashBackupCodes(codes);

      // Try matching with lowercase
      const result = await service.verifyBackupCode('abcd1234', hashed);

      expect(result).not.toBeNull();
      expect(result).toHaveLength(0);
    });

    it('should handle mixed case input', async () => {
      const codes = ['AABB1122'];
      const hashed = await service.hashBackupCodes(codes);

      const result = await service.verifyBackupCode('aAbB1122', hashed);

      expect(result).not.toBeNull();
    });
  });
});
