import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { detectDuplicateKeys, checkLowEntropyKey } from '../../services/lowEntropyKeyService.js';
import type { DbNode } from '../../db/types.js';

/** Threshold for excessive packets per hour (spam detection) */
const EXCESSIVE_PACKETS_THRESHOLD = 30;

/** Threshold for time offset detection (in minutes, configurable via env var) */
const TIME_OFFSET_THRESHOLD_MINUTES = parseInt(process.env.TIME_OFFSET_THRESHOLD_MINUTES || '30', 10);
const TIME_OFFSET_THRESHOLD_MS = TIME_OFFSET_THRESHOLD_MINUTES * 60 * 1000;

/**
 * Scheduled security scanning service
 * Periodically scans all nodes for:
 * - Duplicate public keys
 * - Low-entropy keys
 * - Excessive packet rates (spam detection)
 * - Clock time offset detection
 */
class DuplicateKeySchedulerService {
  private intervalId: NodeJS.Timeout | null = null;
  private initialScanTimer: NodeJS.Timeout | null = null;
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

    logger.info(`🔐 Starting security scanner (runs every ${this.scanInterval / (60 * 60 * 1000)} hours)`);

    // Run initial scan after 5 minutes
    this.initialScanTimer = setTimeout(() => {
      this.initialScanTimer = null;
      this.runScan();
    }, 5 * 60 * 1000);

    // Schedule recurring scans
    this.intervalId = setInterval(() => {
      this.runScan();
    }, this.scanInterval);

    logger.info('✅ Security scanner initialized');
  }

  /**
   * Stop the duplicate key scanner
   */
  stop(): void {
    if (this.initialScanTimer) {
      clearTimeout(this.initialScanTimer);
      this.initialScanTimer = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('🛑 Security scanner stopped');
    }
  }

  /**
   * Run a single scan for duplicate keys
   */
  async runScan(): Promise<void> {
    if (this.isScanning) {
      logger.debug('🔐 Security scan already in progress, skipping');
      return;
    }

    this.isScanning = true;
    let scanSuccessful = true;

    try {
      logger.info('🔐 Running scheduled security scan...');

      // Get all nodes with public keys
      const nodesWithKeys = await databaseService.nodes.getNodesWithPublicKeys();

      if (nodesWithKeys.length === 0) {
        logger.info('ℹ️  No nodes with public keys found, skipping scan');
        // Still run spam and time offset detection, and update lastScanTime via finally path
        await Promise.all([
          this.runSpamDetection(),
          this.runTimeOffsetDetection()
        ]);
        this.lastScanTime = Math.floor(Date.now() / 1000);
        return;
      }

      logger.debug(`🔐 Scanning ${nodesWithKeys.length} nodes for security issues (duplicates and low-entropy keys)`);

      // Fetch all nodes once and build a lookup map to avoid N+1 queries
      const allNodesList = await databaseService.nodes.getAllNodes();
      const nodeMap = new Map<number, DbNode>(allNodesList.map(n => [n.nodeNum, n]));

      // First, check all nodes for low-entropy keys
      let lowEntropyCount = 0;
      for (const nodeData of nodesWithKeys) {
        if (!nodeData.publicKey) continue;

        const node = nodeMap.get(nodeData.nodeNum);
        if (!node) continue;

        const isLowEntropy = checkLowEntropyKey(nodeData.publicKey, 'base64');

        if (isLowEntropy && !node.keyIsLowEntropy) {
          // Flag this node as having low-entropy key
          await databaseService.nodes.updateNodeLowEntropyFlag(nodeData.nodeNum, true, 'Known low-entropy key detected');
          node.keyIsLowEntropy = true; // Keep map in sync
          lowEntropyCount++;
          logger.warn(`🔐 Low-entropy key detected on node ${nodeData.nodeNum}`);
        } else if (!isLowEntropy && node.keyIsLowEntropy) {
          // Clear the flag if it was previously set but key is not low-entropy
          await databaseService.nodes.updateNodeLowEntropyFlag(nodeData.nodeNum, false, undefined);
          node.keyIsLowEntropy = false; // Keep map in sync
        }
      }

      // CRITICAL: Also check nodes that previously had security flags but no longer have keys
      // This ensures flags are cleared when nodes go offline or clear their keys
      const nodesWithKeysSet = new Set(nodesWithKeys.map(n => n.nodeNum));
      for (const node of allNodesList) {
        if (nodesWithKeysSet.has(node.nodeNum)) continue;

        // If this node has no key but has the low-entropy flag set, clear it
        if (node.keyIsLowEntropy) {
          logger.info(`🔐 Clearing low-entropy flag from node ${node.nodeNum} (no longer has a public key)`);
          await databaseService.nodes.updateNodeLowEntropyFlag(node.nodeNum, false, undefined);
          node.keyIsLowEntropy = false; // Keep map in sync
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
        for (const node of allNodesList) {
          if (node.duplicateKeyDetected) {
            const details = node.keyIsLowEntropy ? 'Known low-entropy key detected' : undefined;
            await databaseService.nodes.updateNodeSecurityFlags(node.nodeNum, false, details);
          }
        }
      } else {
        // Build set of all nodes that currently have duplicates
        const currentDuplicateNodes = new Set<number>();
        for (const [, nodeNums] of duplicates) {
          nodeNums.forEach(num => currentDuplicateNodes.add(num));
        }

        // Clear duplicate flags from nodes that are no longer duplicates
        let clearedCount = 0;
        for (const node of allNodesList) {
          if (node.duplicateKeyDetected && !currentDuplicateNodes.has(node.nodeNum)) {
            const details = node.keyIsLowEntropy ? 'Known low-entropy key detected' : undefined;
            await databaseService.nodes.updateNodeSecurityFlags(node.nodeNum, false, details);
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
            const node = nodeMap.get(nodeNum);
            if (!node) continue;

            const otherNodes = nodeNums.filter(n => n !== nodeNum);
            const details = node.keyIsLowEntropy
              ? `Known low-entropy key; Key shared with nodes: ${otherNodes.join(', ')}`
              : `Key shared with nodes: ${otherNodes.join(', ')}`;

            await databaseService.nodes.updateNodeSecurityFlags(nodeNum, true, details);

            updateCount++;
          }

          logger.warn(`🔐 Duplicate key detected: ${nodeNums.length} nodes sharing key hash ${keyHash.substring(0, 16)}...`);
        }

        logger.info(`✅ Duplicate key scan complete: ${updateCount} nodes flagged across ${duplicates.size} duplicate groups`);
      }

      // Run spam detection and time offset detection in parallel (they are independent)
      await Promise.all([
        this.runSpamDetection(),
        this.runTimeOffsetDetection()
      ]);

      // Update last scan time (Unix timestamp in seconds)
      this.lastScanTime = Math.floor(Date.now() / 1000);

    } catch (error) {
      scanSuccessful = false;
      logger.error('Error during security scan:', error);
    } finally {
      this.isScanning = false;
      // Only update lastScanTime if scan completed without top-level error
      if (!scanSuccessful) {
        // Don't update lastScanTime on failure so status reflects the last successful scan
      }
    }
  }

  /**
   * Run spam detection (excessive packet rate check)
   * Sub-scan errors are intentionally caught here so other scans still run.
   */
  private async runSpamDetection(): Promise<void> {
    try {
      logger.info('🔐 Running spam detection (excessive packet rate check)...');

      // Get the local node number to exclude from spam detection
      // (local node has high packet counts due to admin/config traffic)
      const localNodeNumStr = await databaseService.settings.getSetting('localNodeNum');
      const localNodeNum = localNodeNumStr ? parseInt(localNodeNumStr, 10) : null;

      // Get packet counts per node for the last hour
      const packetCounts = await databaseService.getPacketCountsPerNodeLastHourAsync();

      if (packetCounts.length === 0) {
        logger.info('ℹ️  No packet data available for spam detection');
        return;
      }

      // Get all nodes to track which ones we need to clear flags from
      const allNodes = await databaseService.nodes.getAllNodes();
      const nodesWithCurrentPackets = new Set(packetCounts.map(p => p.nodeNum));
      const nodeMap = new Map<number, DbNode>(allNodes.map(n => [n.nodeNum, n]));

      let flaggedCount = 0;
      let clearedCount = 0;

      const now = Math.floor(Date.now() / 1000);

      // Check each node with packet activity
      for (const { nodeNum, packetCount } of packetCounts) {
        // Skip the local node - it has high packet counts due to admin traffic
        if (localNodeNum && nodeNum === localNodeNum) {
          continue;
        }

        const node = nodeMap.get(nodeNum);
        if (!node) continue;

        const isExcessive = packetCount > EXCESSIVE_PACKETS_THRESHOLD;
        const wasExcessive = node.isExcessivePackets;
        const stateChanged = isExcessive !== !!wasExcessive;

        // Only write to DB if state or rate actually changed
        if (stateChanged) {
          await databaseService.updateNodeSpamFlagsAsync(nodeNum, isExcessive, packetCount, now);
          if (isExcessive) {
            flaggedCount++;
            logger.warn(`🚨 Excessive packets detected: Node ${nodeNum} (${node.shortName || 'Unknown'}) sent ${packetCount} packets in the last hour (threshold: ${EXCESSIVE_PACKETS_THRESHOLD})`);
          } else {
            clearedCount++;
            logger.info(`✅ Spam flag cleared: Node ${nodeNum} (${node.shortName || 'Unknown'}) now at ${packetCount} packets/hour`);
          }
        }
        // Note: we skip the DB write when state hasn't changed to reduce write amplification
      }

      // Clear flags from nodes that have no packet activity in the last hour
      // Also clear flags from the local node (it's excluded from spam detection)
      for (const node of allNodes) {
        const isLocalNode = localNodeNum && node.nodeNum === localNodeNum;

        if (node.isExcessivePackets) {
          if (isLocalNode) {
            // Clear spam flag from local node - it's excluded from detection
            await databaseService.updateNodeSpamFlagsAsync(node.nodeNum, false, 0, now);
            clearedCount++;
            logger.info(`✅ Spam flag cleared: Local node ${node.nodeNum} (${node.shortName || 'Unknown'}) - excluded from spam detection`);
          } else if (!nodesWithCurrentPackets.has(node.nodeNum)) {
            await databaseService.updateNodeSpamFlagsAsync(node.nodeNum, false, 0, now);
            clearedCount++;
            logger.info(`✅ Spam flag cleared: Node ${node.nodeNum} (${node.shortName || 'Unknown'}) - no packets in last hour`);
          }
        }
      }

      if (flaggedCount > 0) {
        logger.info(`🚨 Spam detection complete: ${flaggedCount} nodes flagged for excessive packets`);
      } else {
        logger.info(`✅ Spam detection complete: No nodes exceeding ${EXCESSIVE_PACKETS_THRESHOLD} packets/hour`);
      }

      if (clearedCount > 0) {
        logger.info(`✅ Cleared spam flags from ${clearedCount} nodes`);
      }

    } catch (error) {
      logger.error('Error during spam detection:', error);
    }
  }

  /**
   * Detect nodes with significant clock offset.
   * Compares the node's self-reported packetTimestamp against the server's timestamp
   * from the most recent telemetry record.
   * Sub-scan errors are intentionally caught here so other scans still run.
   */
  private async runTimeOffsetDetection(): Promise<void> {
    try {
      logger.info('🔐 Running time offset detection...');

      const latestTimestamps = await databaseService.getLatestPacketTimestampsPerNodeAsync();
      const allNodes = await databaseService.nodes.getAllNodes();
      const nodesWithTimestamps = new Set(latestTimestamps.map(t => t.nodeNum));
      const nodeMap = new Map<number, DbNode>(allNodes.map(n => [n.nodeNum, n]));

      let flaggedCount = 0;
      let clearedCount = 0;

      for (const { nodeNum, timestamp, packetTimestamp } of latestTimestamps) {
        const node = nodeMap.get(nodeNum);
        if (!node) continue;

        // Both timestamp and packetTimestamp are in milliseconds
        const offsetMs = timestamp - packetTimestamp;
        const offsetSeconds = Math.round(offsetMs / 1000);
        const isOffsetExcessive = Math.abs(offsetMs) > TIME_OFFSET_THRESHOLD_MS;
        const wasOffsetIssue = node.isTimeOffsetIssue;
        const stateChanged = isOffsetExcessive !== !!wasOffsetIssue;

        // Only write to DB if state actually changed
        if (stateChanged) {
          await databaseService.updateNodeTimeOffsetFlagsAsync(nodeNum, isOffsetExcessive, offsetSeconds);
          if (isOffsetExcessive) {
            flaggedCount++;
            logger.warn(`🕐 Time offset detected: Node ${nodeNum} (${node.shortName || 'Unknown'}) offset ${offsetSeconds}s (threshold: ${TIME_OFFSET_THRESHOLD_MINUTES}min)`);
          } else {
            clearedCount++;
            logger.info(`✅ Time offset cleared: Node ${nodeNum} (${node.shortName || 'Unknown'}) now at ${offsetSeconds}s`);
          }
        }
        // Note: we skip the DB write when state hasn't changed to reduce write amplification
      }

      // Clear flags from nodes with no recent timestamp data
      for (const node of allNodes) {
        if (node.isTimeOffsetIssue && !nodesWithTimestamps.has(node.nodeNum)) {
          await databaseService.updateNodeTimeOffsetFlagsAsync(node.nodeNum, false, null);
          clearedCount++;
          logger.info(`✅ Time offset cleared: Node ${node.nodeNum} (${node.shortName || 'Unknown'}) - no timestamp data`);
        }
      }

      if (flaggedCount > 0) {
        logger.info(`🕐 Time offset detection complete: ${flaggedCount} nodes flagged`);
      } else {
        logger.info(`✅ Time offset detection complete: No nodes exceeding ${TIME_OFFSET_THRESHOLD_MINUTES} minute threshold`);
      }

      if (clearedCount > 0) {
        logger.info(`✅ Cleared time offset flags from ${clearedCount} nodes`);
      }
    } catch (error) {
      logger.error('Error during time offset detection:', error);
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
