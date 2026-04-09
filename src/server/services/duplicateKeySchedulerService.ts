import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { detectDuplicateKeys, checkLowEntropyKey } from '../../services/lowEntropyKeyService.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import type { DbNode } from '../../db/types.js';

/** Threshold for excessive packets per hour (spam detection) */
const EXCESSIVE_PACKETS_THRESHOLD = 30;

/** Threshold for time offset detection (in minutes, configurable via env var) */
const TIME_OFFSET_THRESHOLD_MINUTES = parseInt(process.env.TIME_OFFSET_THRESHOLD_MINUTES || '30', 10);
const TIME_OFFSET_THRESHOLD_MS = TIME_OFFSET_THRESHOLD_MINUTES * 60 * 1000;

/**
 * Scheduled security scanning service — per-source.
 *
 * The scan interval remains a single operator-level setting, but each scan
 * cycle iterates every registered source manager and runs an independent
 * scan against that source's scoped data. Duplicate-key detection, spam
 * detection and time-offset detection all operate per-source so a problem on
 * one mesh never contaminates another.
 */
class DuplicateKeySchedulerService {
  private intervalId: NodeJS.Timeout | null = null;
  private initialScanTimer: NodeJS.Timeout | null = null;
  private scanInterval: number;
  // Per-source scan state. Keys = sourceId.
  private isScanning: Map<string, boolean> = new Map();
  private lastScanTime: Map<string, number> = new Map();

  /**
   * @param intervalHours - How often to scan (hours). Default: 24 hours.
   */
  constructor(intervalHours: number = 24) {
    this.scanInterval = intervalHours * 60 * 60 * 1000;
  }

  /**
   * Start the scheduler. One timer fires on interval and sweeps every source.
   */
  start(): void {
    if (this.intervalId) {
      logger.warn('🔐 Security scanner already running');
      return;
    }

    logger.info(`🔐 Starting security scanner (runs every ${this.scanInterval / (60 * 60 * 1000)} hours, per source)`);

    this.initialScanTimer = setTimeout(() => {
      this.initialScanTimer = null;
      this.runScanAllSources();
    }, 5 * 60 * 1000);

    this.intervalId = setInterval(() => {
      this.runScanAllSources();
    }, this.scanInterval);

    logger.info('✅ Security scanner initialized');
  }

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
   * Run a scan across every registered source. Sources run independently —
   * a collision in source A does not block a scan of source B.
   */
  async runScanAllSources(): Promise<void> {
    const managers = sourceManagerRegistry.getAllManagers();
    if (managers.length === 0) {
      logger.debug('🔐 No source managers registered — skipping scheduled security scan');
      return;
    }
    await Promise.all(managers.map(m => this.runScan(m.sourceId).catch(err => {
      logger.error(`Error scanning source ${m.sourceId}:`, err);
    })));
  }

  /**
   * Run a single scan for a specific source.
   */
  async runScan(sourceId: string): Promise<void> {
    if (!sourceId) {
      logger.warn('🔐 runScan() called without a sourceId — refusing');
      return;
    }

    if (this.isScanning.get(sourceId)) {
      logger.debug(`🔐 Security scan already in progress for source ${sourceId}, skipping`);
      return;
    }

    this.isScanning.set(sourceId, true);
    let scanSuccessful = true;

    try {
      logger.info(`🔐 Running scheduled security scan for source ${sourceId}...`);

      // Get all nodes with public keys for this source only
      const nodesWithKeys = await databaseService.nodes.getNodesWithPublicKeys(sourceId);

      if (nodesWithKeys.length === 0) {
        logger.info(`ℹ️  [${sourceId}] No nodes with public keys found, skipping key scan`);
        const earlyAllNodes = await databaseService.nodes.getAllNodes(sourceId);
        const earlyNodeMap = new Map<number, DbNode>(earlyAllNodes.map(n => [Number(n.nodeNum), n]));

        await Promise.all([
          this.runSpamDetection(sourceId, earlyNodeMap),
          this.runTimeOffsetDetection(sourceId, earlyNodeMap)
        ]);
        this.lastScanTime.set(sourceId, Math.floor(Date.now() / 1000));
        return;
      }

      logger.debug(`🔐 [${sourceId}] Scanning ${nodesWithKeys.length} nodes for security issues`);

      const allNodesList = await databaseService.nodes.getAllNodes(sourceId);
      const nodeMap = new Map<number, DbNode>(allNodesList.map(n => [Number(n.nodeNum), n]));

      // Low-entropy key detection
      let lowEntropyCount = 0;
      for (const nodeData of nodesWithKeys) {
        if (!nodeData.publicKey) continue;

        const node = nodeMap.get(Number(nodeData.nodeNum));
        if (!node) continue;

        const isLowEntropy = checkLowEntropyKey(nodeData.publicKey, 'base64');

        if (isLowEntropy && !node.keyIsLowEntropy) {
          await databaseService.nodes.updateNodeLowEntropyFlag(Number(nodeData.nodeNum), true, 'Known low-entropy key detected', sourceId);
          node.keyIsLowEntropy = true;
          lowEntropyCount++;
          logger.warn(`🔐 [${sourceId}] Low-entropy key detected on node ${nodeData.nodeNum}`);
        } else if (!isLowEntropy && node.keyIsLowEntropy) {
          await databaseService.nodes.updateNodeLowEntropyFlag(Number(nodeData.nodeNum), false, undefined, sourceId);
          node.keyIsLowEntropy = false;
        }
      }

      const nodesWithKeysSet = new Set(nodesWithKeys.map(n => Number(n.nodeNum)));
      for (const node of allNodesList) {
        if (nodesWithKeysSet.has(Number(node.nodeNum))) continue;
        if (node.keyIsLowEntropy) {
          logger.info(`🔐 [${sourceId}] Clearing low-entropy flag from node ${node.nodeNum} (no longer has a public key)`);
          await databaseService.nodes.updateNodeLowEntropyFlag(Number(node.nodeNum), false, undefined, sourceId);
          node.keyIsLowEntropy = false;
        }
      }

      if (lowEntropyCount > 0) {
        logger.info(`🔐 [${sourceId}] Found ${lowEntropyCount} nodes with low-entropy keys`);
      }

      // Duplicate detection — scoped to THIS source. A node sharing a key with
      // a node on a different source is NOT a duplicate.
      const duplicates = detectDuplicateKeys(nodesWithKeys);

      if (duplicates.size === 0) {
        logger.info(`✅ [${sourceId}] Duplicate key scan complete: No duplicates found among ${nodesWithKeys.length} nodes`);

        for (const node of allNodesList) {
          if (node.duplicateKeyDetected) {
            const details = node.keyIsLowEntropy ? 'Known low-entropy key detected' : undefined;
            await databaseService.nodes.updateNodeSecurityFlags(Number(node.nodeNum), false, details, sourceId);
          }
        }
      } else {
        const currentDuplicateNodes = new Set<number>();
        for (const [, nodeNums] of duplicates) {
          nodeNums.forEach(num => currentDuplicateNodes.add(Number(num)));
        }

        let clearedCount = 0;
        for (const node of allNodesList) {
          if (node.duplicateKeyDetected && !currentDuplicateNodes.has(Number(node.nodeNum))) {
            const details = node.keyIsLowEntropy ? 'Known low-entropy key detected' : undefined;
            await databaseService.nodes.updateNodeSecurityFlags(Number(node.nodeNum), false, details, sourceId);
            clearedCount++;
          }
        }

        if (clearedCount > 0) {
          logger.info(`🔐 [${sourceId}] Cleared duplicate flags from ${clearedCount} nodes`);
        }

        let updateCount = 0;
        for (const [keyHash, nodeNums] of duplicates) {
          for (const nodeNum of nodeNums) {
            const node = nodeMap.get(Number(nodeNum));
            if (!node) continue;

            const otherNodes = nodeNums.filter(n => Number(n) !== Number(nodeNum));
            const details = node.keyIsLowEntropy
              ? `Known low-entropy key; Key shared with nodes: ${otherNodes.join(', ')}`
              : `Key shared with nodes: ${otherNodes.join(', ')}`;

            await databaseService.nodes.updateNodeSecurityFlags(Number(nodeNum), true, details, sourceId);
            updateCount++;
          }

          logger.warn(`🔐 [${sourceId}] Duplicate key detected: ${nodeNums.length} nodes sharing key hash ${keyHash.substring(0, 16)}...`);
        }

        logger.info(`✅ [${sourceId}] Duplicate key scan complete: ${updateCount} nodes flagged across ${duplicates.size} duplicate groups`);
      }

      await Promise.all([
        this.runSpamDetection(sourceId, nodeMap),
        this.runTimeOffsetDetection(sourceId, nodeMap)
      ]);

      this.lastScanTime.set(sourceId, Math.floor(Date.now() / 1000));

    } catch (error) {
      scanSuccessful = false;
      logger.error(`Error during security scan for source ${sourceId}:`, error);
    } finally {
      this.isScanning.set(sourceId, false);
      if (!scanSuccessful) {
        // Leave lastScanTime unchanged on failure.
      }
    }
  }

  /**
   * Spam detection, scoped to a single source.
   * Uses per-source localNodeNum and per-source packet counts.
   */
  private async runSpamDetection(sourceId: string, sharedNodeMap: Map<number, DbNode>): Promise<void> {
    try {
      logger.info(`🔐 [${sourceId}] Running spam detection...`);

      const localNodeNumStr = await databaseService.settings.getSettingForSource(sourceId, 'localNodeNum');
      const localNodeNum = localNodeNumStr ? parseInt(localNodeNumStr, 10) : null;

      const packetCounts = await databaseService.getPacketCountsPerNodeLastHourAsync(sourceId);

      if (packetCounts.length === 0) {
        logger.info(`ℹ️  [${sourceId}] No packet data available for spam detection`);
        return;
      }

      const allNodes = Array.from(sharedNodeMap.values());
      const nodesWithCurrentPackets = new Set(packetCounts.map(p => Number(p.nodeNum)));
      const nodeMap = sharedNodeMap;

      let flaggedCount = 0;
      let clearedCount = 0;

      const now = Math.floor(Date.now() / 1000);

      for (const { nodeNum, packetCount } of packetCounts) {
        if (localNodeNum && Number(nodeNum) === localNodeNum) continue;

        const node = nodeMap.get(Number(nodeNum));
        if (!node) continue;

        const isExcessive = packetCount > EXCESSIVE_PACKETS_THRESHOLD;
        const wasExcessive = node.isExcessivePackets;
        const stateChanged = isExcessive !== !!wasExcessive;

        if (stateChanged) {
          await databaseService.updateNodeSpamFlagsAsync(Number(nodeNum), isExcessive, packetCount, now, sourceId);
          if (isExcessive) {
            flaggedCount++;
            logger.warn(`🚨 [${sourceId}] Excessive packets: Node ${nodeNum} sent ${packetCount} pkt/hr`);
          } else {
            clearedCount++;
          }
        }
      }

      for (const node of allNodes) {
        const isLocalNode = localNodeNum && Number(node.nodeNum) === localNodeNum;

        if (node.isExcessivePackets) {
          if (isLocalNode) {
            await databaseService.updateNodeSpamFlagsAsync(Number(node.nodeNum), false, 0, now, sourceId);
            clearedCount++;
          } else if (!nodesWithCurrentPackets.has(Number(node.nodeNum))) {
            await databaseService.updateNodeSpamFlagsAsync(Number(node.nodeNum), false, 0, now, sourceId);
            clearedCount++;
          }
        }
      }

      if (flaggedCount > 0) {
        logger.info(`🚨 [${sourceId}] Spam detection complete: ${flaggedCount} flagged`);
      } else {
        logger.info(`✅ [${sourceId}] Spam detection complete: no nodes exceeding ${EXCESSIVE_PACKETS_THRESHOLD} pkt/hr`);
      }
    } catch (error) {
      logger.error(`Error during spam detection for source ${sourceId}:`, error);
    }
  }

  /**
   * Time offset detection, scoped to a single source.
   */
  private async runTimeOffsetDetection(sourceId: string, sharedNodeMap: Map<number, DbNode>): Promise<void> {
    try {
      logger.info(`🔐 [${sourceId}] Running time offset detection...`);

      const latestTimestamps = await databaseService.getLatestPacketTimestampsPerNodeAsync(sourceId);
      const allNodes = Array.from(sharedNodeMap.values());
      const nodesWithTimestamps = new Set(latestTimestamps.map(t => Number(t.nodeNum)));
      const nodeMap = sharedNodeMap;

      let flaggedCount = 0;
      let clearedCount = 0;

      for (const { nodeNum, timestamp, packetTimestamp } of latestTimestamps) {
        const node = nodeMap.get(Number(nodeNum));
        if (!node) continue;

        const offsetMs = timestamp - packetTimestamp;
        const offsetSeconds = Math.round(offsetMs / 1000);
        const isOffsetExcessive = Math.abs(offsetMs) > TIME_OFFSET_THRESHOLD_MS;
        const wasOffsetIssue = node.isTimeOffsetIssue;
        const stateChanged = isOffsetExcessive !== !!wasOffsetIssue;

        if (stateChanged) {
          await databaseService.updateNodeTimeOffsetFlagsAsync(Number(nodeNum), isOffsetExcessive, offsetSeconds, sourceId);
          if (isOffsetExcessive) {
            flaggedCount++;
            logger.warn(`🕐 [${sourceId}] Time offset: Node ${nodeNum} offset ${offsetSeconds}s`);
          } else {
            clearedCount++;
          }
        }
      }

      for (const node of allNodes) {
        if (node.isTimeOffsetIssue && !nodesWithTimestamps.has(Number(node.nodeNum))) {
          await databaseService.updateNodeTimeOffsetFlagsAsync(Number(node.nodeNum), false, null, sourceId);
          clearedCount++;
        }
      }

      if (flaggedCount > 0) {
        logger.info(`🕐 [${sourceId}] Time offset detection complete: ${flaggedCount} flagged`);
      } else {
        logger.info(`✅ [${sourceId}] Time offset detection complete: no nodes exceeding threshold`);
      }
    } catch (error) {
      logger.error(`Error during time offset detection for source ${sourceId}:`, error);
    }
  }

  /**
   * Get scanner status for a specific source, or a map of all sources.
   */
  getStatus(sourceId?: string): any {
    if (sourceId) {
      return {
        running: this.intervalId !== null,
        scanningNow: this.isScanning.get(sourceId) === true,
        intervalHours: this.scanInterval / (60 * 60 * 1000),
        lastScanTime: this.lastScanTime.get(sourceId) ?? null,
      };
    }
    const sources: Record<string, { scanningNow: boolean; lastScanTime: number | null }> = {};
    const allKeys = new Set<string>([
      ...this.isScanning.keys(),
      ...this.lastScanTime.keys(),
      ...sourceManagerRegistry.getAllManagers().map(m => m.sourceId),
    ]);
    for (const sid of allKeys) {
      sources[sid] = {
        scanningNow: this.isScanning.get(sid) === true,
        lastScanTime: this.lastScanTime.get(sid) ?? null,
      };
    }
    return {
      running: this.intervalId !== null,
      intervalHours: this.scanInterval / (60 * 60 * 1000),
      sources,
    };
  }
}

// Default: scan every 24 hours. Override via DUPLICATE_KEY_SCAN_INTERVAL_HOURS.
const intervalHours = process.env.DUPLICATE_KEY_SCAN_INTERVAL_HOURS
  ? parseInt(process.env.DUPLICATE_KEY_SCAN_INTERVAL_HOURS, 10)
  : 24;

export const duplicateKeySchedulerService = new DuplicateKeySchedulerService(intervalHours);
export { DuplicateKeySchedulerService };
