import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { detectDuplicateKeys } from '../../services/lowEntropyKeyService.js';

/**
 * Scheduled duplicate key detection service
 * Periodically scans all nodes for duplicate public keys
 */
class DuplicateKeySchedulerService {
  private intervalId: NodeJS.Timeout | null = null;
  private scanInterval: number;
  private isScanning: boolean = false;

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

      logger.debug(`🔐 Scanning ${nodesWithKeys.length} nodes for duplicate keys`);

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

        this.isScanning = false;
        return;
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

    } catch (error) {
      logger.error('Error during duplicate key scan:', error);
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * Get scanner status
   */
  getStatus(): { running: boolean; scanningNow: boolean; intervalHours: number } {
    return {
      running: this.intervalId !== null,
      scanningNow: this.isScanning,
      intervalHours: this.scanInterval / (60 * 60 * 1000)
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
