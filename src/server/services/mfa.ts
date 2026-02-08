/**
 * MFA (Multi-Factor Authentication) Service
 *
 * Handles TOTP secret generation, QR code generation,
 * token verification, and backup code management.
 */

import { generateSecret, generateURI, verifySync } from 'otplib';
import QRCode from 'qrcode';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 8;
const BCRYPT_ROUNDS = 10;
const SERVICE_NAME = 'MeshMonitor';

export class MfaService {
  /**
   * Generate a new TOTP secret and otpauth URL for a user.
   */
  generateSecret(username: string): { secret: string; otpauthUrl: string } {
    const secret = generateSecret();
    const otpauthUrl = generateURI({
      secret,
      issuer: SERVICE_NAME,
      label: `${SERVICE_NAME}:${username}`
    });
    return { secret, otpauthUrl };
  }

  /**
   * Generate a QR code data URL from an otpauth URL.
   */
  async generateQrCode(otpauthUrl: string): Promise<string> {
    return QRCode.toDataURL(otpauthUrl);
  }

  /**
   * Verify a TOTP token against a secret.
   * Uses epochTolerance of 30 seconds (+-1 step) to account for clock drift.
   */
  verifyToken(secret: string, token: string): boolean {
    try {
      const result = verifySync({ token, secret, epochTolerance: 30 });
      return result.valid;
    } catch {
      return false;
    }
  }

  /**
   * Generate random backup codes.
   */
  generateBackupCodes(count: number = BACKUP_CODE_COUNT): string[] {
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
      // Generate random alphanumeric code
      const code = crypto.randomBytes(BACKUP_CODE_LENGTH)
        .toString('hex')
        .substring(0, BACKUP_CODE_LENGTH)
        .toUpperCase();
      codes.push(code);
    }
    return codes;
  }

  /**
   * Hash backup codes with bcrypt for secure storage.
   */
  async hashBackupCodes(codes: string[]): Promise<string[]> {
    const hashed = await Promise.all(
      codes.map(code => bcrypt.hash(code.toUpperCase(), BCRYPT_ROUNDS))
    );
    return hashed;
  }

  /**
   * Verify a backup code against the list of hashed codes.
   * Returns the remaining hashed codes (with the matched one removed) if valid,
   * or null if no match.
   */
  async verifyBackupCode(code: string, hashedCodes: string[]): Promise<string[] | null> {
    const normalizedCode = code.toUpperCase();
    for (let i = 0; i < hashedCodes.length; i++) {
      const match = await bcrypt.compare(normalizedCode, hashedCodes[i]);
      if (match) {
        // Remove the used code and return remaining
        const remaining = [...hashedCodes];
        remaining.splice(i, 1);
        return remaining;
      }
    }
    return null;
  }
}

// Singleton instance
export const mfaService = new MfaService();
