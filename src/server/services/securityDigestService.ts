import { logger } from '../../utils/logger.js';
import { scheduleCron } from '../utils/cronScheduler.js';
import type { Cron as CronJob } from 'croner';

interface SecurityIssuesData {
  total: number;
  lowEntropyCount: number;
  duplicateKeyCount: number;
  excessivePacketsCount: number;
  timeOffsetCount: number;
  nodes: Array<{
    nodeNum: number;
    shortName: string | null;
    longName: string | null;
    keyIsLowEntropy?: boolean;
    duplicateKeyDetected?: boolean;
    keySecurityIssueDetails?: string | null;
    publicKey?: string | null;
    isExcessivePackets?: boolean;
    packetRatePerHour?: number | null;
    isTimeOffsetIssue?: boolean;
    timeOffsetSeconds?: number | null;
  }>;
  topBroadcasters: Array<{
    nodeNum: number;
    shortName: string | null;
    longName: string | null;
    packetCount: number;
  }>;
}

export function formatDigestSummary(
  issues: SecurityIssuesData,
  baseUrl: string,
  suppressEmpty: boolean = true
): string | null {
  const date = new Date().toISOString().split('T')[0];
  const issueTypeCount = [
    issues.duplicateKeyCount > 0,
    issues.lowEntropyCount > 0,
    issues.excessivePacketsCount > 0,
    issues.timeOffsetCount > 0,
  ].filter(Boolean).length;

  if (issues.total === 0) {
    if (suppressEmpty) return null;
    return [
      `MeshMonitor Security Digest — ${date}`,
      '',
      'No security issues detected.',
      '',
      `View details: ${baseUrl}/security`,
    ].join('\n');
  }

  return [
    `MeshMonitor Security Digest — ${date}`,
    '',
    `${issueTypeCount} issue type${issueTypeCount !== 1 ? 's' : ''} detected across ${issues.total} nodes`,
    '',
    `Duplicate PSK: ${issues.duplicateKeyCount} node${issues.duplicateKeyCount !== 1 ? 's' : ''}`,
    `Low-Entropy Key: ${issues.lowEntropyCount} node${issues.lowEntropyCount !== 1 ? 's' : ''}`,
    `Excessive Packets: ${issues.excessivePacketsCount} node${issues.excessivePacketsCount !== 1 ? 's' : ''}`,
    `Time Offset: ${issues.timeOffsetCount} node${issues.timeOffsetCount !== 1 ? 's' : ''}`,
    '',
    `View details: ${baseUrl}/security`,
  ].join('\n');
}

export function formatDigestDetailed(
  issues: SecurityIssuesData,
  baseUrl: string,
  suppressEmpty: boolean = true
): string | null {
  const date = new Date().toISOString().split('T')[0];
  const issueTypeCount = [
    issues.duplicateKeyCount > 0,
    issues.lowEntropyCount > 0,
    issues.excessivePacketsCount > 0,
    issues.timeOffsetCount > 0,
  ].filter(Boolean).length;

  if (issues.total === 0) {
    if (suppressEmpty) return null;
    return [
      `MeshMonitor Security Digest — ${date}`,
      '',
      'No security issues detected.',
      '',
      `View details: ${baseUrl}/security`,
    ].join('\n');
  }

  const lines: string[] = [
    `MeshMonitor Security Digest — ${date}`,
    '',
    `${issueTypeCount} issue type${issueTypeCount !== 1 ? 's' : ''} detected across ${issues.total} nodes`,
  ];

  // Duplicate PSK — group by publicKey
  const dupNodes = issues.nodes.filter(n => n.duplicateKeyDetected);
  lines.push('', '--- Duplicate PSK ---');
  if (dupNodes.length === 0) {
    lines.push('None');
  } else {
    const groups = new Map<string, string[]>();
    for (const node of dupNodes) {
      const key = node.publicKey || 'unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(node.longName || node.shortName || `!${node.nodeNum.toString(16).padStart(8, '0')}`);
    }
    let groupNum = 1;
    for (const [, nodeNames] of groups) {
      if (nodeNames.length > 1) {
        lines.push(`Group ${groupNum} (${nodeNames.length} nodes): ${nodeNames.join(', ')}`);
        groupNum++;
      }
    }
    if (groupNum === 1) {
      lines.push(`${dupNodes.length} node${dupNodes.length !== 1 ? 's' : ''} with duplicate keys`);
    }
  }

  // Low-Entropy Key
  const lowEntropyNodes = issues.nodes.filter(n => n.keyIsLowEntropy);
  lines.push('', '--- Low-Entropy Key ---');
  if (lowEntropyNodes.length === 0) {
    lines.push('None');
  } else {
    for (const node of lowEntropyNodes) {
      const name = node.longName || node.shortName || 'Unknown';
      const nodeId = `!${node.nodeNum.toString(16).padStart(8, '0')}`;
      lines.push(`${name} (${nodeId})`);
    }
  }

  // Excessive Packets
  const excessiveNodes = issues.nodes.filter(n => n.isExcessivePackets);
  lines.push('', '--- Excessive Packets ---');
  if (excessiveNodes.length === 0) {
    lines.push('None');
  } else {
    for (const node of excessiveNodes) {
      const name = node.longName || node.shortName || 'Unknown';
      const rate = node.packetRatePerHour != null ? ` — ${node.packetRatePerHour} pkt/hr` : '';
      lines.push(`${name}${rate}`);
    }
  }

  // Time Offset
  const timeOffsetNodes = issues.nodes.filter(n => n.isTimeOffsetIssue);
  lines.push('', '--- Time Offset ---');
  if (timeOffsetNodes.length === 0) {
    lines.push('None');
  } else {
    for (const node of timeOffsetNodes) {
      const name = node.longName || node.shortName || 'Unknown';
      const offset = node.timeOffsetSeconds != null ? ` — ${Math.abs(node.timeOffsetSeconds)}s drift` : '';
      lines.push(`${name}${offset}`);
    }
  }

  lines.push('', `View details: ${baseUrl}/security`);
  return lines.join('\n');
}

class SecurityDigestService {
  private cronJob: CronJob | null = null;
  private databaseService: any = null;

  initialize(databaseService: any): void {
    this.databaseService = databaseService;
    this.reschedule();
    logger.info('Security digest service initialized');
  }

  reschedule(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }

    if (!this.databaseService) return;

    const enabled = this.databaseService.getSetting('securityDigestEnabled');
    if (enabled !== 'true') {
      logger.debug('Security digest is disabled');
      return;
    }

    const time = this.databaseService.getSetting('securityDigestTime') || '06:00';
    const [hours, minutes] = time.split(':').map(Number);
    const cronExpression = `${minutes} ${hours} * * *`;

    this.cronJob = scheduleCron(cronExpression, async () => {
      await this.sendDigest();
    });

    logger.info(`Security digest scheduled at ${time} daily`);
  }

  async sendDigest(): Promise<{ success: boolean; message: string }> {
    if (!this.databaseService) {
      return { success: false, message: 'Service not initialized' };
    }

    const appriseUrl = this.databaseService.getSetting('securityDigestAppriseUrl');
    if (!appriseUrl) {
      return { success: false, message: 'No Apprise URL configured' };
    }

    const reportType = this.databaseService.getSetting('securityDigestReportType') || 'summary';
    const suppressEmpty = this.databaseService.getSetting('securityDigestSuppressEmpty') !== 'false';
    const baseUrl = this.databaseService.getSetting('externalUrl') || '';

    try {
      // Gather security data using existing functions
      const [keyIssueNodes, excessiveNodes, topBroadcasters] = await Promise.all([
        this.databaseService.getNodesWithKeySecurityIssuesAsync(),
        this.databaseService.getNodesWithExcessivePacketsAsync(),
        this.databaseService.getTopBroadcastersAsync(10),
      ]);

      // Merge and deduplicate (same pattern as securityRoutes.ts)
      const nodeMap = new Map<number, any>();
      for (const node of keyIssueNodes) {
        nodeMap.set(node.nodeNum, { ...node, isExcessivePackets: false, packetRatePerHour: null, isTimeOffsetIssue: false, timeOffsetSeconds: null });
      }
      for (const node of excessiveNodes) {
        const existing = nodeMap.get(node.nodeNum);
        if (existing) {
          existing.isExcessivePackets = true;
          existing.packetRatePerHour = node.packetRatePerHour;
        } else {
          nodeMap.set(node.nodeNum, { ...node, keyIsLowEntropy: false, duplicateKeyDetected: false, isExcessivePackets: true });
        }
      }

      const allNodes = Array.from(nodeMap.values());
      const issues: SecurityIssuesData = {
        total: allNodes.length,
        lowEntropyCount: allNodes.filter((n: any) => n.keyIsLowEntropy).length,
        duplicateKeyCount: allNodes.filter((n: any) => n.duplicateKeyDetected).length,
        excessivePacketsCount: allNodes.filter((n: any) => n.isExcessivePackets).length,
        timeOffsetCount: allNodes.filter((n: any) => n.isTimeOffsetIssue).length,
        nodes: allNodes,
        topBroadcasters,
      };

      const body = reportType === 'detailed'
        ? formatDigestDetailed(issues, baseUrl, suppressEmpty)
        : formatDigestSummary(issues, baseUrl, suppressEmpty);

      if (body === null) {
        logger.info('Security digest suppressed — no issues found');
        return { success: true, message: 'No issues found, digest suppressed' };
      }

      // Send via Apprise API directly
      const response = await fetch('http://localhost:8000/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: [appriseUrl],
          title: 'MeshMonitor Security Digest',
          body,
          type: issues.total > 0 ? 'warning' : 'info',
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        const text = await response.text();
        logger.error(`Security digest delivery failed: ${response.status} ${text}`);
        return { success: false, message: `Apprise returned ${response.status}` };
      }

      logger.info(`Security digest sent (${reportType}, ${issues.total} issues)`);
      return { success: true, message: `Digest sent with ${issues.total} issue(s)` };
    } catch (error) {
      logger.error('Error sending security digest:', error);
      return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
  }
}

export const securityDigestService = new SecurityDigestService();
