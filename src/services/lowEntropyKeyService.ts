import crypto from 'crypto';
import { logger } from '../utils/logger.js';

/**
 * Known low-entropy public key hashes from Meshtastic firmware
 * These are SHA-256 hashes of public keys that were generated with insufficient randomness
 * Source: https://github.com/meshtastic/firmware/blob/master/src/mesh/NodeDB.h
 */
const LOW_ENTROPY_HASHES: string[] = [
  'f47ecc17e6b4a322eceed9084f3963ea8075e124ce053669633b2cbc028d348b',
  '5a9ea2a68aa666c15f550064a3a6fe71c0bb82c3323d7a7ae36efddda3a66b9',
  'b3df3b2e67b6d5f8df762c455e2ebd16c5f867aa15f8920bdf5a6650ac0dbb2f',
  '3b8f863a381f7739a94eef91185a62e1aa9d36eace60358d9d1ff4b8c9136a5d',
  '367e2de1845f4252290a256454a6bfdb665ff151a51712240757f6919b6458',
  '1677eba45291fb26cf8fd7d9d15dc4687375edc55558ee9056d42f3129f78c1f',
  '318ca95eed3c12bf979c478e989dc23e86239029c8b020f8b1b0aa192acf0a54',
  'a48a990e51dc1220f313f52b3ae24342c65298cdbbcab131a0d4d630f327fb49',
  'd23f138d22048d075958a0f955cf30a02e2fca8020e4dea1add958b3432b2270',
  '4041ec6ad2d603e49a9ebd6c0a9b75a4bcab6fa795ff2df6e9b9ab4c0c1cd03b',
  '2249322b00f922fa1702e96482f04d1bc704fcdc8c5eb6d916d637ce59aa0949',
  '486f1e48978864ace8eb30a3c3e1cf9739a6555b5fbf18b73adfa875e79de01e',
  '09b4e26d2898c9476646bfff581791aac3bf4a9d0b88b1f103dd61d7ba9e6498',
  '393984e0222f7d78451872b413d2012f3ca1b0fe39d0f13c72d6ef54d57722a0',
  '0ada5fecff5cc02e5fc48d03e58059d35d4986e98df6f616353df99b29559e64',
  '0856f0d7ef77d6118c952d3cdfb122bf609be5a9c06e4b01dcd15744b2a5cf',
  '2cb27785d6b7489cfebc802660f46dce1131a21e330a6d2b00fa0c90958f5c6b',
  'fa59c86e94ee75c99ab0fe893640c9994a3bf4aa1224a20ff9d108cb7819aae5',
  '6e427a4a8c616222a189d3a4c219a38353a77a0a89e2545262e7ca8cf66a60',
  '20272fba0c99d729f31135899d0e24a1c3cbdf8af1c6fed0d79f92d68f59bfe4',
  '9170b47cfbffa0596a251ca99ee943815d74b1b10928004aafe3fca94e27764c',
  '85fe7cecb67874c3ece1327fb0b70274f923d8e7fa14e6ee6644b18ca52f7ed2',
  '8e66657b3b6f7ecc57b457eacc83f5aaf765a3ce937213c1b6467b2945b5c893',
  'cc11fb1aaba131876ac6de8887a9b9593782d8b2ccd897409a5c8f4055cb4c3e',
];

export interface KeySecurityCheck {
  isLowEntropy: boolean;
  isDuplicate: boolean;
  details?: string;
}

/**
 * Checks if a public key is a known low-entropy key
 * @param publicKey Public key as hex string or base64 string
 * @param format Format of the input key ('hex' or 'base64'). Defaults to 'hex'.
 * @returns true if the key is in the low-entropy blacklist
 */
export function checkLowEntropyKey(publicKey: string, format: 'hex' | 'base64' = 'hex'): boolean {
  if (!publicKey) {
    return false;
  }

  try {
    // Convert to buffer based on format
    let keyBuffer: Buffer;
    if (format === 'base64') {
      keyBuffer = Buffer.from(publicKey, 'base64');
    } else {
      if (publicKey.length !== 64) {
        // Public key should be 32 bytes = 64 hex characters
        return false;
      }
      keyBuffer = Buffer.from(publicKey, 'hex');
    }

    // Validate key size (should be 32 bytes)
    if (keyBuffer.length !== 32) {
      logger.warn(`Invalid public key size: ${keyBuffer.length} bytes (expected 32)`);
      return false;
    }

    // Compute SHA-256 hash of the public key
    const hash = crypto.createHash('sha256');
    hash.update(keyBuffer);
    const keyHash = hash.digest('hex');

    // Check against known bad key hashes
    const isLowEntropy = LOW_ENTROPY_HASHES.includes(keyHash);

    if (isLowEntropy) {
      logger.warn(`🔐 Low-entropy public key detected! Hash: ${keyHash}`);
    }

    return isLowEntropy;
  } catch (error) {
    logger.error('Error checking low-entropy key:', error);
    return false;
  }
}

/**
 * Checks if multiple nodes share the same public key (duplicate detection)
 * @param nodes Array of nodes with public keys (stored as base64)
 * @returns Map of public key hashes to arrays of node numbers that share that key
 */
export function detectDuplicateKeys(
  nodes: Array<{ nodeNum: number; publicKey?: string | null }>
): Map<string, number[]> {
  const keyMap = new Map<string, number[]>();

  for (const node of nodes) {
    if (!node.publicKey) continue;

    try {
      // Public keys in database are base64-encoded
      const keyBuffer = Buffer.from(node.publicKey, 'base64');

      // Validate key size
      if (keyBuffer.length !== 32) {
        logger.warn(`Invalid public key size for node ${node.nodeNum}: ${keyBuffer.length} bytes`);
        continue;
      }

      const hash = crypto.createHash('sha256');
      hash.update(keyBuffer);
      const keyHash = hash.digest('hex');

      if (!keyMap.has(keyHash)) {
        keyMap.set(keyHash, []);
      }
      keyMap.get(keyHash)!.push(node.nodeNum);
    } catch (error) {
      logger.error(`Error processing public key for node ${node.nodeNum}:`, error);
    }
  }

  // Filter to only keep duplicates (keys shared by more than one node)
  const duplicates = new Map<string, number[]>();
  for (const [keyHash, nodeNums] of keyMap.entries()) {
    if (nodeNums.length > 1) {
      duplicates.set(keyHash, nodeNums);
      logger.warn(
        `🔐 Duplicate public key detected! Nodes ${nodeNums.join(', ')} share key hash: ${keyHash.substring(0, 16)}...`
      );
    }
  }

  return duplicates;
}

/**
 * Comprehensive security check for a public key
 * @param publicKey Public key as hex or base64 string (defaults to base64 for database compatibility)
 * @param nodeNum Node number for this key
 * @param allNodes Optional array of all nodes for duplicate detection
 * @param format Format of the input key ('hex' or 'base64'). Defaults to 'base64'.
 * @returns KeySecurityCheck result with isLowEntropy, isDuplicate, and details
 */
export function checkKeySecurity(
  publicKey: string | null | undefined,
  nodeNum: number,
  allNodes?: Array<{ nodeNum: number; publicKey?: string | null }>,
  format: 'hex' | 'base64' = 'base64'
): KeySecurityCheck {
  const result: KeySecurityCheck = {
    isLowEntropy: false,
    isDuplicate: false,
  };

  if (!publicKey) {
    return result;
  }

  // Check for low-entropy key
  result.isLowEntropy = checkLowEntropyKey(publicKey, format);

  // Check for duplicate key
  if (allNodes && allNodes.length > 0) {
    const duplicates = detectDuplicateKeys(allNodes);

    // Convert key to hash for comparison (database keys are base64)
    const keyBuffer = format === 'base64' ? Buffer.from(publicKey, 'base64') : Buffer.from(publicKey, 'hex');

    if (keyBuffer.length === 32) {
      const hash = crypto.createHash('sha256');
      hash.update(keyBuffer);
      const keyHash = hash.digest('hex');

      if (duplicates.has(keyHash)) {
        result.isDuplicate = true;
        const nodesWithSameKey = duplicates.get(keyHash)!;
        result.details = `Key shared with nodes: ${nodesWithSameKey.filter((n) => n !== nodeNum).join(', ')}`;
      }
    }
  }

  // Build details message
  if (result.isLowEntropy && !result.details) {
    result.details = 'Known low-entropy key detected';
  } else if (result.isLowEntropy && result.details) {
    result.details = `Known low-entropy key; ${result.details}`;
  }

  return result;
}
