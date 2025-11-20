import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { detectDuplicateKeys, checkLowEntropyKey } from '../../services/lowEntropyKeyService.js';

/**
 * Scheduled duplicate key detection service
 * Periodically scans all nodes for duplicate public keys
 */
class DuplicateKeySchedulerService {
  private intervalId: NodeJS.Timeout | null = null;
  private scanInterval: number;
  private isScanning: boolean = false;
  private lastScanTime: number | null = null;

  /**
   * @param intervalHours - How often to scan for duplicates (in hours). Default: 24 hours
   */
  constructor(intervalHours: number = 24) {
    this.scanInterval = intervalHours * 60 * 60 * 1000; // Convert to milliseconds
  }

  /**
   * Start the duplicate key scanner
   */
  start(): void {
    if (this.intervalId) {
      logger.warn('🔐 Duplicate key scanner already running');
      return;
    }

    logger.info(`🔐 Starting duplicate key scanner (runs every ${this.scanInterval / (60 * 60 * 1000)} hours)`);

    // Run initial scan after 5 minutes
    setTimeout(() => {
      this.runScan();
    }, 5 * 60 * 1000);

    // Schedule recurring scans
    this.intervalId = setInterval(() => {
      this.runScan();
    }, this.scanInterval);

    logger.info('✅ Duplicate key scanner initialized');
  }

  /**
   * Stop the duplicate key scanner
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('🛑 Duplicate key scanner stopped');
    }
  }

  /**
   * Run a single scan for duplicate keys
   */
  async runScan(): Promise<void> {
    if (this.isScanning) {
      logger.debug('🔐 Duplicate key scan already in progress, skipping');
      return;
    }

    this.isScanning = true;

    try {
      logger.info('🔐 Running scheduled duplicate key scan...');

      // Get all nodes with public keys
      const nodesWithKeys = databaseService.getNodesWithPublicKeys();

      if (nodesWithKeys.length === 0) {
        logger.info('ℹ️  No nodes with public keys found, skipping scan');
        this.isScanning = false;
        return;
      }

      logger.debug(`🔐 Scanning ${nodesWithKeys.length} nodes for security issues (duplicates and low-entropy keys)`);

      // First, check all nodes for low-entropy keys
      let lowEntropyCount = 0;
      for (const nodeData of nodesWithKeys) {
        if (!nodeData.publicKey) continue;

        const node = databaseService.getNode(nodeData.nodeNum);
        if (!node) continue;

        const isLowEntropy = checkLowEntropyKey(nodeData.publicKey, 'base64');

        if (isLowEntropy && !node.keyIsLowEntropy) {
          // Flag this node as having low-entropy key
          databaseService.updateNodeLowEntropyFlag(nodeData.nodeNum, true, 'Known low-entropy key detected');
          lowEntropyCount++;
          logger.warn(`🔐 Low-entropy key detected on node ${nodeData.nodeNum}`);
        } else if (!isLowEntropy && node.keyIsLowEntropy) {
          // Clear the flag if it was previously set but key is not low-entropy
          databaseService.updateNodeLowEntropyFlag(nodeData.nodeNum, false, undefined);
        }
      }

      // CRITICAL: Also check nodes that previously had security flags but no longer have keys
      // This ensures flags are cleared when nodes go offline or clear their keys
      const allNodes = databaseService.getAllNodes();
      for (const node of allNodes) {
        // Skip nodes we already processed above (nodes with keys)
        const hasKey = nodesWithKeys.some(n => n.nodeNum === node.nodeNum);
        if (hasKey) continue;

        // If this node has no key but has the low-entropy flag set, clear it
        if (node.keyIsLowEntropy) {
          logger.info(`🔐 Clearing low-entropy flag from node ${node.nodeNum} (no longer has a public key)`);
          databaseService.updateNodeLowEntropyFlag(node.nodeNum, false, undefined);
        }
      }

      if (lowEntropyCount > 0) {
        logger.info(`🔐 Found ${lowEntropyCount} nodes with low-entropy keys`);
      }

      // Detect duplicates
      const duplicates = detectDuplicateKeys(nodesWithKeys);

      if (duplicates.size === 0) {
        logger.info(`✅ Duplicate key scan complete: No duplicates found among ${nodesWithKeys.length} nodes`);

        // Clear any previously set duplicate flags
        const allNodes = databaseService.getAllNodes();
        for (const node of allNodes) {
          if (node.duplicateKeyDetected) {
            const details = node.keyIsLowEntropy ? 'Known low-entropy key detected' : undefined;
            databaseService.updateNodeSecurityFlags(node.nodeNum, false, details);
          }
        }

        // Update last scan time (Unix timestamp in seconds)
        this.lastScanTime = Math.floor(Date.now() / 1000);

        this.isScanning = false;
        return;
      }

      // Build set of all nodes that currently have duplicates
      const currentDuplicateNodes = new Set<number>();
      for (const [, nodeNums] of duplicates) {
        nodeNums.forEach(num => currentDuplicateNodes.add(num));
      }

      // Clear duplicate flags from nodes that are no longer duplicates
      let clearedCount = 0;
      for (const node of allNodes) {
        if (node.duplicateKeyDetected && !currentDuplicateNodes.has(node.nodeNum)) {
          // This node was previously flagged but no longer has duplicates
          // This includes nodes that no longer have public keys
          const details = node.keyIsLowEntropy ? 'Known low-entropy key detected' : undefined;
          databaseService.updateNodeSecurityFlags(node.nodeNum, false, details);
          clearedCount++;
          logger.debug(`🔐 Cleared duplicate flag from node ${node.nodeNum} (no longer has duplicates)`);
        }
      }

      if (clearedCount > 0) {
        logger.info(`🔐 Cleared duplicate flags from ${clearedCount} nodes that no longer have duplicates`);
      }

      // Update database with duplicate flags
      let updateCount = 0;
      for (const [keyHash, nodeNums] of duplicates) {
        for (const nodeNum of nodeNums) {
          const node = databaseService.getNode(nodeNum);
          if (!node) continue;

          const otherNodes = nodeNums.filter(n => n !== nodeNum);
          const details = node.keyIsLowEntropy
            ? `Known low-entropy key; Key shared with nodes: ${otherNodes.join(', ')}`
            : `Key shared with nodes: ${otherNodes.join(', ')}`;

          databaseService.updateNodeSecurityFlags(nodeNum, true, details);

          updateCount++;
        }

        logger.warn(`🔐 Duplicate key detected: ${nodeNums.length} nodes sharing key hash ${keyHash.substring(0, 16)}...`);
      }

      logger.info(`✅ Duplicate key scan complete: ${updateCount} nodes flagged across ${duplicates.size} duplicate groups`);

      // Update last scan time (Unix timestamp in seconds)
      this.lastScanTime = Math.floor(Date.now() / 1000);

    } catch (error) {
      logger.error('Error during duplicate key scan:', error);
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * Get scanner status
   */
  getStatus(): { running: boolean; scanningNow: boolean; intervalHours: number; lastScanTime: number | null } {
    return {
      running: this.intervalId !== null,
      scanningNow: this.isScanning,
      intervalHours: this.scanInterval / (60 * 60 * 1000),
      lastScanTime: this.lastScanTime
    };
  }
}

// Export singleton instance
// Default: scan every 24 hours
// Can be configured via environment variable: DUPLICATE_KEY_SCAN_INTERVAL_HOURS
const intervalHours = process.env.DUPLICATE_KEY_SCAN_INTERVAL_HOURS
  ? parseInt(process.env.DUPLICATE_KEY_SCAN_INTERVAL_HOURS, 10)
  : 24;

export const duplicateKeySchedulerService = new DuplicateKeySchedulerService(intervalHours);
