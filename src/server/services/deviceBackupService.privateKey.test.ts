/**
 * A Meshtastic device backup must not contain the node's private key (#6285).
 * Restore never writes `config.security`, so the key was stored for nothing.
 */
import { describe, it, expect } from 'vitest';
import { deviceBackupService } from './deviceBackupService.js';

const cleanConfig = (config: unknown): Record<string, any> =>
  (deviceBackupService as unknown as { cleanConfig(c: unknown): Record<string, any> }).cleanConfig(config);

describe('deviceBackupService — private key', () => {
  it('drops security.privateKey but keeps the public and admin keys', () => {
    const cleaned = cleanConfig({
      security: {
        privateKey: new Uint8Array(32).fill(7),
        publicKey: new Uint8Array(32).fill(9),
        adminKey: [new Uint8Array(32).fill(3)],
        serialEnabled: true,
      },
    });
    expect(cleaned.security.privateKey).toBeUndefined();
    expect(cleaned.security.publicKey).toBeInstanceOf(Uint8Array);
    expect(cleaned.security.adminKey).toHaveLength(1);
    expect(cleaned.security.serialEnabled).toBe(true);
  });

  it('drops the snake_case spelling too', () => {
    expect(cleanConfig({ security: { private_key: new Uint8Array(32).fill(7) } })).toEqual({});
  });
});
