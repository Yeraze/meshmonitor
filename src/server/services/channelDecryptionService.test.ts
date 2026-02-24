/**
 * Channel Decryption Service Tests
 *
 * Tests server-side AES-CTR decryption of Meshtastic packets
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { createCipheriv } from 'crypto';
import { channelDecryptionService } from './channelDecryptionService.js';
import databaseService from '../../services/database.js';
import * as protobufLoader from '../protobufLoader.js';

// Mock the protobuf loader
vi.mock('../protobufLoader.js', () => ({
  getProtobufRoot: vi.fn()
}));

// Mock database service
vi.mock('../../services/database.js', () => ({
  default: {
    getEnabledChannelDatabaseEntriesAsync: vi.fn(),
    incrementChannelDatabaseDecryptedCountAsync: vi.fn()
  }
}));

describe('ChannelDecryptionService', () => {
  // Test key: 32 bytes for AES-256
  const testPsk = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
  const testPskBase64 = testPsk.toString('base64');

  // Test key: 16 bytes for AES-128
  const testPsk128 = Buffer.from('0123456789abcdef', 'utf8');
  const testPsk128Base64 = testPsk128.toString('base64');

  // Mock protobuf Data type
  const mockDataType = {
    decode: vi.fn()
  };

  const mockRoot = {
    lookupType: vi.fn().mockReturnValue(mockDataType)
  };

  beforeEach(() => {
    vi.clearAllMocks();
    channelDecryptionService.invalidateCache();
    channelDecryptionService.setEnabled(true);

    // Setup default mocks
    (protobufLoader.getProtobufRoot as Mock).mockReturnValue(mockRoot);
    mockDataType.decode.mockReturnValue({ portnum: 1, payload: Buffer.from('test') });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Service Configuration', () => {
    it('should be enabled by default after setEnabled(true)', () => {
      expect(channelDecryptionService.isEnabled()).toBe(true);
    });

    it('should allow disabling the service', () => {
      channelDecryptionService.setEnabled(false);
      expect(channelDecryptionService.isEnabled()).toBe(false);
    });

    it('should return 0 cache size when no channels loaded', () => {
      expect(channelDecryptionService.getCacheSize()).toBe(0);
    });

    it('should update max decryption attempts', () => {
      channelDecryptionService.setMaxDecryptionAttempts(50);
      // Can't directly verify but shouldn't throw
    });
  });

  describe('Cache Management', () => {
    it('should load channels into cache', async () => {
      (databaseService.getEnabledChannelDatabaseEntriesAsync as Mock).mockResolvedValue([
        { id: 1, name: 'Test Channel', psk: testPskBase64, pskLength: 32 }
      ]);

      await channelDecryptionService.refreshChannelCache();

      expect(channelDecryptionService.getCacheSize()).toBe(1);
    });

    it('should skip channels with invalid PSK length', async () => {
      (databaseService.getEnabledChannelDatabaseEntriesAsync as Mock).mockResolvedValue([
        { id: 1, name: 'Invalid Channel', psk: testPskBase64, pskLength: 24 } // Wrong declared length
      ]);

      await channelDecryptionService.refreshChannelCache();

      expect(channelDecryptionService.getCacheSize()).toBe(0);
    });

    it('should skip channels without ID', async () => {
      (databaseService.getEnabledChannelDatabaseEntriesAsync as Mock).mockResolvedValue([
        { name: 'No ID Channel', psk: testPskBase64, pskLength: 32 }
      ]);

      await channelDecryptionService.refreshChannelCache();

      expect(channelDecryptionService.getCacheSize()).toBe(0);
    });

    it('should invalidate cache', async () => {
      (databaseService.getEnabledChannelDatabaseEntriesAsync as Mock).mockResolvedValue([
        { id: 1, name: 'Test Channel', psk: testPskBase64, pskLength: 32 }
      ]);

      await channelDecryptionService.refreshChannelCache();
      expect(channelDecryptionService.getCacheSize()).toBe(1);

      channelDecryptionService.invalidateCache();
      // Cache will be refreshed on next access due to TTL check
    });

    it('should get enabled channel IDs', async () => {
      (databaseService.getEnabledChannelDatabaseEntriesAsync as Mock).mockResolvedValue([
        { id: 1, name: 'Channel 1', psk: testPskBase64, pskLength: 32 },
        { id: 2, name: 'Channel 2', psk: testPsk128Base64, pskLength: 16 }
      ]);

      const ids = await channelDecryptionService.getEnabledChannelIds();

      expect(ids).toContain(1);
      expect(ids).toContain(2);
    });

    it('should get channel info by ID', async () => {
      (databaseService.getEnabledChannelDatabaseEntriesAsync as Mock).mockResolvedValue([
        { id: 1, name: 'Test Channel', psk: testPskBase64, pskLength: 32 }
      ]);

      const info = await channelDecryptionService.getChannelInfo(1);

      expect(info).toBeDefined();
      expect(info?.name).toBe('Test Channel');
      expect(info?.pskLength).toBe(32);
    });

    it('should return null for non-existent channel', async () => {
      (databaseService.getEnabledChannelDatabaseEntriesAsync as Mock).mockResolvedValue([]);

      const info = await channelDecryptionService.getChannelInfo(999);

      expect(info).toBeNull();
    });
  });

  describe('Decryption', () => {
    const packetId = 12345;
    const fromNode = 0x12345678;

    // Helper to encrypt test data using AES-CTR (same as Meshtastic)
    function encryptTestData(plaintext: Buffer, psk: Buffer, packetId: number, fromNode: number): Buffer {
      const nonce = Buffer.alloc(16);
      nonce.writeUInt32LE(packetId >>> 0, 0);
      nonce.writeUInt32LE(0, 4);
      nonce.writeUInt32LE(fromNode >>> 0, 8);
      nonce.writeUInt32LE(0, 12);

      const algorithm = psk.length === 16 ? 'aes-128-ctr' : 'aes-256-ctr';
      const cipher = createCipheriv(algorithm, psk, nonce);
      return Buffer.concat([cipher.update(plaintext), cipher.final()]);
    }

    it('should return error when service is disabled', async () => {
      channelDecryptionService.setEnabled(false);

      const result = await channelDecryptionService.tryDecrypt(
        new Uint8Array([1, 2, 3]),
        packetId,
        fromNode
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('disabled');
    });

    it('should return error for empty payload', async () => {
      const result = await channelDecryptionService.tryDecrypt(
        new Uint8Array(0),
        packetId,
        fromNode
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Empty');
    });

    it('should return error when no channels configured', async () => {
      (databaseService.getEnabledChannelDatabaseEntriesAsync as Mock).mockResolvedValue([]);

      const result = await channelDecryptionService.tryDecrypt(
        new Uint8Array([1, 2, 3]),
        packetId,
        fromNode
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No channels');
    });

    it('should successfully decrypt with correct AES-256 key', async () => {
      (databaseService.getEnabledChannelDatabaseEntriesAsync as Mock).mockResolvedValue([
        { id: 1, name: 'Test Channel', psk: testPskBase64, pskLength: 32 }
      ]);
      (databaseService.incrementChannelDatabaseDecryptedCountAsync as Mock).mockResolvedValue(undefined);

      // Create a valid protobuf-like test payload
      const testPayload = Buffer.from([0x08, 0x01, 0x12, 0x04, 0x74, 0x65, 0x73, 0x74]);
      const encrypted = encryptTestData(testPayload, testPsk, packetId, fromNode);

      mockDataType.decode.mockReturnValue({ portnum: 1, payload: Buffer.from('test') });

      const result = await channelDecryptionService.tryDecrypt(
        new Uint8Array(encrypted),
        packetId,
        fromNode
      );

      expect(result.success).toBe(true);
      expect(result.channelDatabaseId).toBe(1);
      expect(result.channelName).toBe('Test Channel');
      expect(result.portnum).toBe(1);
    });

    it('should successfully decrypt with correct AES-128 key', async () => {
      (databaseService.getEnabledChannelDatabaseEntriesAsync as Mock).mockResolvedValue([
        { id: 2, name: 'AES-128 Channel', psk: testPsk128Base64, pskLength: 16 }
      ]);
      (databaseService.incrementChannelDatabaseDecryptedCountAsync as Mock).mockResolvedValue(undefined);

      const testPayload = Buffer.from([0x08, 0x01, 0x12, 0x04, 0x74, 0x65, 0x73, 0x74]);
      const encrypted = encryptTestData(testPayload, testPsk128, packetId, fromNode);

      mockDataType.decode.mockReturnValue({ portnum: 1, payload: Buffer.from('test') });

      const result = await channelDecryptionService.tryDecrypt(
        new Uint8Array(encrypted),
        packetId,
        fromNode
      );

      expect(result.success).toBe(true);
      expect(result.channelDatabaseId).toBe(2);
    });

    it('should fail decryption with wrong key', async () => {
      const wrongKey = Buffer.from('wrongkey12345678wrongkey12345678', 'utf8');
      (databaseService.getEnabledChannelDatabaseEntriesAsync as Mock).mockResolvedValue([
        { id: 1, name: 'Wrong Key Channel', psk: wrongKey.toString('base64'), pskLength: 32 }
      ]);

      // Encrypt with testPsk but try to decrypt with wrongKey
      const testPayload = Buffer.from([0x08, 0x01, 0x12, 0x04, 0x74, 0x65, 0x73, 0x74]);
      const encrypted = encryptTestData(testPayload, testPsk, packetId, fromNode);

      // Mock decode to throw for invalid protobuf
      mockDataType.decode.mockImplementation(() => {
        throw new Error('Invalid protobuf');
      });

      const result = await channelDecryptionService.tryDecrypt(
        new Uint8Array(encrypted),
        packetId,
        fromNode
      );

      expect(result.success).toBe(false);
    });

    it('should try multiple channels until one succeeds', async () => {
      const wrongKey = Buffer.from('wrongkey12345678wrongkey12345678', 'utf8');

      (databaseService.getEnabledChannelDatabaseEntriesAsync as Mock).mockResolvedValue([
        { id: 1, name: 'Wrong Key', psk: wrongKey.toString('base64'), pskLength: 32 },
        { id: 2, name: 'Correct Key', psk: testPskBase64, pskLength: 32 }
      ]);
      (databaseService.incrementChannelDatabaseDecryptedCountAsync as Mock).mockResolvedValue(undefined);

      const testPayload = Buffer.from([0x08, 0x01, 0x12, 0x04, 0x74, 0x65, 0x73, 0x74]);
      const encrypted = encryptTestData(testPayload, testPsk, packetId, fromNode);

      let decodeCallCount = 0;
      mockDataType.decode.mockImplementation(() => {
        decodeCallCount++;
        if (decodeCallCount === 1) {
          throw new Error('Invalid protobuf');
        }
        return { portnum: 1, payload: Buffer.from('test') };
      });

      const result = await channelDecryptionService.tryDecrypt(
        new Uint8Array(encrypted),
        packetId,
        fromNode
      );

      expect(result.success).toBe(true);
      expect(result.channelDatabaseId).toBe(2);
      expect(result.channelName).toBe('Correct Key');
    });

    it('should respect max decryption attempts limit', async () => {
      // Create 25 channels
      const channels = Array.from({ length: 25 }, (_, i) => ({
        id: i + 1,
        name: `Channel ${i + 1}`,
        psk: Buffer.alloc(32, i).toString('base64'),
        pskLength: 32
      }));

      (databaseService.getEnabledChannelDatabaseEntriesAsync as Mock).mockResolvedValue(channels);
      channelDecryptionService.setMaxDecryptionAttempts(10);

      // All decryptions will fail (wrong keys)
      mockDataType.decode.mockImplementation(() => {
        throw new Error('Invalid protobuf');
      });

      const encrypted = Buffer.alloc(16, 0);
      const result = await channelDecryptionService.tryDecrypt(
        new Uint8Array(encrypted),
        packetId,
        fromNode
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('10 channel(s)'); // Should mention attempt limit
    });
  });

  describe('Decryption with Specific Channel', () => {
    const packetId = 12345;
    const fromNode = 0x12345678;

    function encryptTestData(plaintext: Buffer, psk: Buffer, packetId: number, fromNode: number): Buffer {
      const nonce = Buffer.alloc(16);
      nonce.writeUInt32LE(packetId >>> 0, 0);
      nonce.writeUInt32LE(0, 4);
      nonce.writeUInt32LE(fromNode >>> 0, 8);
      nonce.writeUInt32LE(0, 12);

      const algorithm = psk.length === 16 ? 'aes-128-ctr' : 'aes-256-ctr';
      const cipher = createCipheriv(algorithm, psk, nonce);
      return Buffer.concat([cipher.update(plaintext), cipher.final()]);
    }

    it('should decrypt with specific channel ID', async () => {
      (databaseService.getEnabledChannelDatabaseEntriesAsync as Mock).mockResolvedValue([
        { id: 5, name: 'Specific Channel', psk: testPskBase64, pskLength: 32 }
      ]);

      const testPayload = Buffer.from([0x08, 0x01, 0x12, 0x04, 0x74, 0x65, 0x73, 0x74]);
      const encrypted = encryptTestData(testPayload, testPsk, packetId, fromNode);

      mockDataType.decode.mockReturnValue({ portnum: 1, payload: Buffer.from('test') });

      const result = await channelDecryptionService.tryDecryptWithChannel(
        new Uint8Array(encrypted),
        packetId,
        fromNode,
        5
      );

      expect(result.success).toBe(true);
      expect(result.channelDatabaseId).toBe(5);
    });

    it('should fail for non-existent channel ID', async () => {
      (databaseService.getEnabledChannelDatabaseEntriesAsync as Mock).mockResolvedValue([
        { id: 1, name: 'Channel 1', psk: testPskBase64, pskLength: 32 }
      ]);

      const result = await channelDecryptionService.tryDecryptWithChannel(
        new Uint8Array([1, 2, 3]),
        packetId,
        fromNode,
        999
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('Protobuf Validation', () => {
    it('should reject portnum outside valid range', async () => {
      (databaseService.getEnabledChannelDatabaseEntriesAsync as Mock).mockResolvedValue([
        { id: 1, name: 'Test Channel', psk: testPskBase64, pskLength: 32 }
      ]);

      // Return invalid portnum
      mockDataType.decode.mockReturnValue({ portnum: 500, payload: Buffer.from('test') });

      const result = await channelDecryptionService.tryDecrypt(
        new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
        12345,
        0x12345678
      );

      expect(result.success).toBe(false);
    });

    it('should handle protobuf root not loaded', async () => {
      (protobufLoader.getProtobufRoot as Mock).mockReturnValue(null);
      (databaseService.getEnabledChannelDatabaseEntriesAsync as Mock).mockResolvedValue([
        { id: 1, name: 'Test Channel', psk: testPskBase64, pskLength: 32 }
      ]);

      const result = await channelDecryptionService.tryDecrypt(
        new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
        12345,
        0x12345678
      );

      expect(result.success).toBe(false);
    });
  });

  describe('Channel Hash Validation', () => {
    const packetId = 12345;
    const fromNode = 0x12345678;

    function encryptTestData(plaintext: Buffer, psk: Buffer, packetId: number, fromNode: number): Buffer {
      const nonce = Buffer.alloc(16);
      nonce.writeUInt32LE(packetId >>> 0, 0);
      nonce.writeUInt32LE(0, 4);
      nonce.writeUInt32LE(fromNode >>> 0, 8);
      nonce.writeUInt32LE(0, 12);

      const algorithm = psk.length === 16 ? 'aes-128-ctr' : 'aes-256-ctr';
      const cipher = createCipheriv(algorithm, psk, nonce);
      return Buffer.concat([cipher.update(plaintext), cipher.final()]);
    }

    it('should skip channel when hash does not match and enforceNameValidation is true', async () => {
      // Channel with enforceNameValidation enabled
      (databaseService.getEnabledChannelDatabaseEntriesAsync as Mock).mockResolvedValue([
        { id: 1, name: 'Test Channel', psk: testPskBase64, pskLength: 32, enforceNameValidation: true }
      ]);

      const testPayload = Buffer.from([0x08, 0x01, 0x12, 0x04, 0x74, 0x65, 0x73, 0x74]);
      const encrypted = encryptTestData(testPayload, testPsk, packetId, fromNode);

      // Provide a non-matching channel hash (any value that won't match)
      const result = await channelDecryptionService.tryDecrypt(
        new Uint8Array(encrypted),
        packetId,
        fromNode,
        255 // Non-matching hash
      );

      // Should fail because hash doesn't match (channel is skipped)
      expect(result.success).toBe(false);
      expect(result.error).toContain('0 channel'); // No channels attempted
    });

    it('should try channel when hash matches and enforceNameValidation is true', async () => {
      (databaseService.getEnabledChannelDatabaseEntriesAsync as Mock).mockResolvedValue([
        { id: 1, name: 'Test Channel', psk: testPskBase64, pskLength: 32, enforceNameValidation: true }
      ]);
      (databaseService.incrementChannelDatabaseDecryptedCountAsync as Mock).mockResolvedValue(undefined);

      const testPayload = Buffer.from([0x08, 0x01, 0x12, 0x04, 0x74, 0x65, 0x73, 0x74]);
      const encrypted = encryptTestData(testPayload, testPsk, packetId, fromNode);

      mockDataType.decode.mockReturnValue({ portnum: 1, payload: Buffer.from('test') });

      // Compute the expected hash for 'Test Channel' with testPsk
      // xorHash('Test Channel') ^ xorHash(testPsk)
      const nameBytes = Buffer.from('Test Channel', 'utf8');
      let nameHash = 0;
      for (let i = 0; i < nameBytes.length; i++) {
        nameHash ^= nameBytes[i];
      }
      let pskHash = 0;
      for (let i = 0; i < testPsk.length; i++) {
        pskHash ^= testPsk[i];
      }
      const expectedHash = (nameHash ^ pskHash) & 0xff;

      const result = await channelDecryptionService.tryDecrypt(
        new Uint8Array(encrypted),
        packetId,
        fromNode,
        expectedHash // Matching hash
      );

      expect(result.success).toBe(true);
      expect(result.channelDatabaseId).toBe(1);
    });

    it('should ignore hash validation when enforceNameValidation is false', async () => {
      (databaseService.getEnabledChannelDatabaseEntriesAsync as Mock).mockResolvedValue([
        { id: 1, name: 'Test Channel', psk: testPskBase64, pskLength: 32, enforceNameValidation: false }
      ]);
      (databaseService.incrementChannelDatabaseDecryptedCountAsync as Mock).mockResolvedValue(undefined);

      const testPayload = Buffer.from([0x08, 0x01, 0x12, 0x04, 0x74, 0x65, 0x73, 0x74]);
      const encrypted = encryptTestData(testPayload, testPsk, packetId, fromNode);

      mockDataType.decode.mockReturnValue({ portnum: 1, payload: Buffer.from('test') });

      // Provide any hash - should be ignored
      const result = await channelDecryptionService.tryDecrypt(
        new Uint8Array(encrypted),
        packetId,
        fromNode,
        255 // Any hash value
      );

      expect(result.success).toBe(true);
      expect(result.channelDatabaseId).toBe(1);
    });

    it('should ignore hash validation when channelHash is undefined (backward compatibility)', async () => {
      (databaseService.getEnabledChannelDatabaseEntriesAsync as Mock).mockResolvedValue([
        { id: 1, name: 'Test Channel', psk: testPskBase64, pskLength: 32, enforceNameValidation: true }
      ]);
      (databaseService.incrementChannelDatabaseDecryptedCountAsync as Mock).mockResolvedValue(undefined);

      const testPayload = Buffer.from([0x08, 0x01, 0x12, 0x04, 0x74, 0x65, 0x73, 0x74]);
      const encrypted = encryptTestData(testPayload, testPsk, packetId, fromNode);

      mockDataType.decode.mockReturnValue({ portnum: 1, payload: Buffer.from('test') });

      // Don't provide channel hash (undefined)
      const result = await channelDecryptionService.tryDecrypt(
        new Uint8Array(encrypted),
        packetId,
        fromNode
        // channelHash is undefined
      );

      expect(result.success).toBe(true);
      expect(result.channelDatabaseId).toBe(1);
    });

    it('should select correct channel from multiple when using hash validation', async () => {
      const wrongPsk = Buffer.from('wrongkey12345678wrongkey12345678', 'utf8');

      (databaseService.getEnabledChannelDatabaseEntriesAsync as Mock).mockResolvedValue([
        { id: 1, name: 'Wrong Channel', psk: wrongPsk.toString('base64'), pskLength: 32, enforceNameValidation: true },
        { id: 2, name: 'Correct Channel', psk: testPskBase64, pskLength: 32, enforceNameValidation: true }
      ]);
      (databaseService.incrementChannelDatabaseDecryptedCountAsync as Mock).mockResolvedValue(undefined);

      const testPayload = Buffer.from([0x08, 0x01, 0x12, 0x04, 0x74, 0x65, 0x73, 0x74]);
      const encrypted = encryptTestData(testPayload, testPsk, packetId, fromNode);

      mockDataType.decode.mockReturnValue({ portnum: 1, payload: Buffer.from('test') });

      // Compute hash for 'Correct Channel' with testPsk
      const nameBytes = Buffer.from('Correct Channel', 'utf8');
      let nameHash = 0;
      for (let i = 0; i < nameBytes.length; i++) {
        nameHash ^= nameBytes[i];
      }
      let pskHash = 0;
      for (let i = 0; i < testPsk.length; i++) {
        pskHash ^= testPsk[i];
      }
      const expectedHash = (nameHash ^ pskHash) & 0xff;

      const result = await channelDecryptionService.tryDecrypt(
        new Uint8Array(encrypted),
        packetId,
        fromNode,
        expectedHash
      );

      // Should find the second channel (id=2) because hash matches
      expect(result.success).toBe(true);
      expect(result.channelDatabaseId).toBe(2);
      expect(result.channelName).toBe('Correct Channel');
    });
  });

  describe('Hash Functions', () => {
    // Import the exported hash functions
    it('should compute xorHash correctly', async () => {
      const { xorHash } = await import('./channelDecryptionService.js');

      // Empty buffer
      expect(xorHash(Buffer.from([]))).toBe(0);

      // Single byte
      expect(xorHash(Buffer.from([0x42]))).toBe(0x42);

      // Multiple bytes
      expect(xorHash(Buffer.from([0x01, 0x02, 0x03]))).toBe(0x01 ^ 0x02 ^ 0x03);

      // Result should be 8-bit (& 0xff)
      expect(xorHash(Buffer.from([0xff, 0xff]))).toBe(0);
    });

    it('should compute channel hash correctly', async () => {
      const { computeChannelHash, xorHash } = await import('./channelDecryptionService.js');

      const name = 'TestChannel';
      const psk = Buffer.from('0123456789abcdef', 'utf8');

      const expectedNameHash = xorHash(Buffer.from(name, 'utf8'));
      const expectedPskHash = xorHash(psk);
      const expectedChannelHash = expectedNameHash ^ expectedPskHash;

      expect(computeChannelHash(name, psk)).toBe(expectedChannelHash);
    });

    it('should compute consistent hash for same inputs', async () => {
      const { computeChannelHash } = await import('./channelDecryptionService.js');

      const name = 'MyChannel';
      const psk = Buffer.from('secretkeysecret!', 'utf8');

      const hash1 = computeChannelHash(name, psk);
      const hash2 = computeChannelHash(name, psk);

      expect(hash1).toBe(hash2);
    });

    it('should compute different hashes for different names', async () => {
      const { computeChannelHash } = await import('./channelDecryptionService.js');

      const psk = Buffer.from('secretkeysecret!', 'utf8');

      const hash1 = computeChannelHash('Channel1', psk);
      const hash2 = computeChannelHash('Channel2', psk);

      expect(hash1).not.toBe(hash2);
    });
  });
});
