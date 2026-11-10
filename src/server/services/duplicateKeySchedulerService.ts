import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { detectDuplicateKeys, checkLowEntropyKey, isBenign28UpgradeRenumber } from '../../services/lowEntropyKeyService.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isAnyMeshCoreSourceType } from '../../utils/nodeTypeCategory.js';
import type { DbNode } from '../../db/types.js';
import type { MeshCoreSecurityFlagsUpdate } from '../../db/repositories/meshcore.js';
import meshcorePacketLogService from './meshcorePacketLogService.js';
import { loadMeshcorePackets } from './meshcorePacketWindow.js';
import {
  computeMeshcorePacketRates,
  computeMeshcoreClockOffsets,
  isClockOffsetFlagged,
} from './meshcoreSecurityScan.js';
import {
  EXCESSIVE_PACKETS_PER_HOUR,
  EXCESSIVE_PACKETS_WINDOW_MS,
  TIME_OFFSET_THRESHOLD_MS,
} from '../constants/securityThresholds.js';

/** Thresholds are shared with MeshCore, the digest and the UI copy (#6281). */
const EXCESSIVE_PACKETS_THRESHOLD = EXCESSIVE_PACKETS_PER_HOUR;

/** How far back the MeshCore scan reads the packet log (its retention window). */
const MESHCORE_SCAN_LOG_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How far back, and how many, DM sender clocks the MeshCore scan reads. */
const MESHCORE_SCAN_DM_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MESHCORE_SCAN_DM_LIMIT = 2000;

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
      this.runScanAllSources().catch(err => logger.error('Security scanner error:', err));
    }, 5 * 60 * 1000);

    this.intervalId = setInterval(() => {
      this.runScanAllSources().catch(err => logger.error('Security scanner error:', err));
    }, this.scanInterval);

    logger.debug('✅ Security scanner initialized');
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
    // MeshCore sources (device and MQTT ingest) run the packet-rate and
    // clock-offset scan only (#6281): identity is the key, so there are no
    // low-entropy or duplicate-key checks. `runScan` dispatches by source type.
    const managers = sourceManagerRegistry.getAllManagers();
    if (managers.length === 0) {
      logger.debug('🔐 No source managers registered — skipping scheduled security scan');
      return;
    }
    await Promise.all(managers.map(m => this.runScan(m.sourceId, m.sourceType).catch(err => {
      logger.error(`Error scanning source ${m.sourceId}:`, err);
    })));
  }

  /**
   * Run a single scan for a specific source.
   */
  async runScan(sourceId: string, sourceType?: string): Promise<void> {
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
      if (isAnyMeshCoreSourceType(sourceType ?? sourceManagerRegistry.getManager?.(sourceId)?.sourceType)) {
        await this.runMeshcoreScan(sourceId);
        this.lastScanTime.set(sourceId, Math.floor(Date.now() / 1000));
        return;
      }

      logger.debug(`🔐 Running scheduled security scan for source ${sourceId}...`);

      // Get all nodes with public keys for this source only
      const nodesWithKeys = await databaseService.nodes.getNodesWithPublicKeys(sourceId);

      if (nodesWithKeys.length === 0) {
        logger.debug(`ℹ️  [${sourceId}] No nodes with public keys found, skipping key scan`);
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
          logger.debug(`🔐 [${sourceId}] Clearing low-entropy flag from node ${node.nodeNum} (no longer has a public key)`);
          await databaseService.nodes.updateNodeLowEntropyFlag(Number(node.nodeNum), false, undefined, sourceId);
          node.keyIsLowEntropy = false;
        }
      }

      if (lowEntropyCount > 0) {
        logger.info(`🔐 [${sourceId}] Found ${lowEntropyCount} nodes with low-entropy keys`);
      }

      // Duplicate detection — scoped to THIS source. A node sharing a key with
      // a node on a different source is NOT a duplicate.
      const allDuplicates = detectDuplicateKeys(nodesWithKeys);

      // Filter out benign Meshtastic 2.8 upgrade renumbers (issue #4251): a node
      // upgrading to 2.8 keeps its key but gets a new crc32(key)-derived NodeNum,
      // orphaning the old one — a same-key/two-NodeNum pattern that is NOT an
      // impersonation. Suppress those groups from the security-risk flagging;
      // anything that doesn't match the clean handoff fingerprint stays a
      // duplicate and is flagged as before.
      const keyByNodeNum = new Map<number, string | null | undefined>(
        nodesWithKeys.map((n) => [Number(n.nodeNum), n.publicKey])
      );
      const nowSec = Math.floor(Date.now() / 1000);
      const duplicates = new Map<string, number[]>();
      for (const [keyHash, nodeNums] of allDuplicates) {
        const groupNodes = nodeNums.map((num) => ({
          nodeNum: Number(num),
          publicKey: keyByNodeNum.get(Number(num)),
          lastHeard: nodeMap.get(Number(num))?.lastHeard ?? null,
        }));
        if (isBenign28UpgradeRenumber(groupNodes, nowSec)) {
          logger.info(
            `🔐 [${sourceId}] Ignoring benign Meshtastic 2.8 upgrade renumber (same key, crc32-derived NodeNum handoff): ${nodeNums
              .map((n) => `!${Number(n).toString(16).padStart(8, '0')}`)
              .join(' ↔ ')}`
          );
          continue;
        }
        duplicates.set(keyHash, nodeNums);
      }

      if (duplicates.size === 0) {
        logger.debug(`✅ [${sourceId}] Duplicate key scan complete: No duplicates found among ${nodesWithKeys.length} nodes`);

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
   * MeshCore scan for one source (#6281): per-key packet rates from the packet
   * log and clock offsets from ADVERT/DM sender times. DB reads and flag
   * writes only; nothing is sent and no event fires. Throws on failure so
   * `runScan` leaves `lastScanTime` alone.
   *
   * With the packet log off, rate flags are left untouched (no data to judge
   * by); offsets still come from DMs.
   */
  private async runMeshcoreScan(sourceId: string): Promise<void> {
    logger.debug(`🔐 [${sourceId}] Running MeshCore security scan...`);
    const repo = databaseService.meshcore;
    const nowMs = Date.now();
    const nodes = await repo.getNodesBySource(sourceId);
    const localKeys = new Set<string>(
      nodes.filter((n) => n.isLocalNode).map((n) => n.publicKey.toLowerCase()),
    );

    const logEnabled = await meshcorePacketLogService.isEnabled();
    const packets = logEnabled
      ? await loadMeshcorePackets([sourceId], nowMs - MESHCORE_SCAN_LOG_WINDOW_MS)
      : [];
    const dms = await repo.getLatestDmSenderTimes(sourceId, nowMs - MESHCORE_SCAN_DM_WINDOW_MS, MESHCORE_SCAN_DM_LIMIT);

    const rates = computeMeshcorePacketRates(packets, nodes, {
      nowMs,
      windowMs: EXCESSIVE_PACKETS_WINDOW_MS,
      localKeys,
    });
    const offsets = computeMeshcoreClockOffsets({
      adverts: packets.filter((p) => p.payloadType === 0x04),
      dms,
      nodes,
      nowMs,
      localKeys,
    });

    const writes: MeshCoreSecurityFlagsUpdate[] = [];
    let flaggedSpam = 0;
    let flaggedClock = 0;
    for (const node of nodes) {
      const pk = node.publicKey.toLowerCase();
      const row: MeshCoreSecurityFlagsUpdate = { publicKey: node.publicKey };
      let dirty = false;
      const isLocal = localKeys.has(pk);

      if (isLocal) {
        if (node.isExcessivePackets) {
          Object.assign(row, { isExcessivePackets: false, packetRatePerHour: null, advertRatePerHour: null, packetRateLastChecked: null });
          dirty = true;
        }
        if (node.isTimeOffsetIssue) {
          Object.assign(row, { isTimeOffsetIssue: false, timeOffsetSeconds: null, timeOffsetSource: null, timeOffsetCheckedAt: null });
          dirty = true;
        }
        if (dirty) writes.push(row);
        continue;
      }

      if (logEnabled) {
        const rate = rates.get(pk);
        const count = rate?.packets ?? 0;
        if (count > EXCESSIVE_PACKETS_PER_HOUR) {
          Object.assign(row, {
            isExcessivePackets: true,
            packetRatePerHour: count,
            advertRatePerHour: rate?.adverts ?? 0,
            packetRateLastChecked: nowMs,
          });
          flaggedSpam++;
          dirty = true;
        } else if (node.isExcessivePackets) {
          Object.assign(row, { isExcessivePackets: false, packetRatePerHour: null, advertRatePerHour: null, packetRateLastChecked: null });
          dirty = true;
        }
      }

      const off = offsets.get(pk);
      if (off && isClockOffsetFlagged(off.offsetMs, TIME_OFFSET_THRESHOLD_MS)) {
        Object.assign(row, {
          isTimeOffsetIssue: true,
          timeOffsetSeconds: Math.round(off.offsetMs / 1000),
          timeOffsetSource: off.source,
          timeOffsetCheckedAt: nowMs,
        });
        flaggedClock++;
        dirty = true;
      } else if (node.isTimeOffsetIssue) {
        Object.assign(row, { isTimeOffsetIssue: false, timeOffsetSeconds: null, timeOffsetSource: null, timeOffsetCheckedAt: null });
        dirty = true;
      }
      if (dirty) writes.push(row);
    }

    if (writes.length > 0) await repo.setNodeSecurityFlags(sourceId, writes);
    logger.info(
      `🔐 [${sourceId}] MeshCore security scan: ${nodes.length} nodes, ${flaggedSpam} excessive packets, ${flaggedClock} clock offsets${logEnabled ? '' : ' (packet log off: rates skipped)'}`,
    );
  }

  /**
   * Spam detection, scoped to a single source.
   * Uses per-source localNodeNum and per-source packet counts.
   */
  private async runSpamDetection(sourceId: string, sharedNodeMap: Map<number, DbNode>): Promise<void> {
    try {
      logger.debug(`🔐 [${sourceId}] Running spam detection...`);

      const localNodeNumStr = await databaseService.settings.getLocalNodeNumForSource(sourceId);
      const localNodeNum = localNodeNumStr ? parseInt(localNodeNumStr, 10) : null;

      const packetCounts = await databaseService.getPacketCountsPerNodeLastHourAsync(sourceId);

      if (packetCounts.length === 0) {
        logger.debug(`ℹ️  [${sourceId}] No packet data available for spam detection`);
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
        logger.debug(`✅ [${sourceId}] Spam detection complete: no nodes exceeding ${EXCESSIVE_PACKETS_THRESHOLD} pkt/hr`);
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
      logger.debug(`🔐 [${sourceId}] Running time offset detection...`);

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
        logger.debug(`✅ [${sourceId}] Time offset detection complete: no nodes exceeding threshold`);
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
