import { logger } from '../../utils/logger.js';
import { scheduleCron } from '../utils/cronScheduler.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { resolveAppriseServerUrl, appriseNotifyEndpoint } from './appriseNotificationService.js';
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

export type DigestFormat = 'text' | 'markdown';

function nodeName(node: { nodeNum: number; longName: string | null; shortName: string | null }): string {
  return node.longName || node.shortName || `!${node.nodeNum.toString(16).padStart(8, '0')}`;
}

function formatDrift(seconds: number): string {
  const abs = Math.abs(seconds);
  const days = Math.floor(abs / 86400);
  const hours = Math.floor((abs % 86400) / 3600);
  const mins = Math.floor((abs % 3600) / 60);
  const secs = abs % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours.toString().padStart(2, '0')}h`);
  parts.push(`${mins.toString().padStart(2, '0')}m`);
  parts.push(`${secs.toString().padStart(2, '0')}s`);
  return parts.join(' ');
}

function nodeId(nodeNum: number): string {
  return `!${nodeNum.toString(16).padStart(8, '0')}`;
}

/**
 * The digest's "View details" line. Omitted entirely when no absolute external URL is
 * configured, because `${''}/security` renders as a dead relative path in an Apprise
 * message. `externalUrl` currently has NO writer anywhere in the repo (#4419 / #4437);
 * whether it should become a user-configurable setting is a product decision, not a
 * cleanup. Until then this keeps the broken line out of every digest.
 */
function detailsLink(baseUrl: string, markdown: boolean): string | null {
  if (!baseUrl) return null;
  return markdown ? `[View details](${baseUrl}/security)` : `View details: ${baseUrl}/security`;
}

export function formatDigestSummary(
  issues: SecurityIssuesData,
  baseUrl: string,
  suppressEmpty: boolean = true,
  format: DigestFormat = 'text'
): string | null {
  const date = new Date().toISOString().split('T')[0];
  const md = format === 'markdown';
  const issueTypeCount = [
    issues.duplicateKeyCount > 0,
    issues.lowEntropyCount > 0,
    issues.excessivePacketsCount > 0,
    issues.timeOffsetCount > 0,
  ].filter(Boolean).length;

  if (issues.total === 0) {
    if (suppressEmpty) return null;
    if (md) {
      return [
        `# MeshMonitor Security Digest — ${date}`,
        '',
        '> No security issues detected.',
        '',
        detailsLink(baseUrl, true),
      ].filter((l): l is string => l !== null).join('\n');
    }
    return [
      `MeshMonitor Security Digest — ${date}`,
      '',
      'No security issues detected.',
      '',
      detailsLink(baseUrl, false),
    ].filter((l): l is string => l !== null).join('\n');
  }

  if (md) {
    return [
      `# MeshMonitor Security Digest — ${date}`,
      '',
      `> **${issueTypeCount} issue type${issueTypeCount !== 1 ? 's' : ''}** detected across **${issues.total} nodes**`,
      '',
      '| Issue Type | Count |',
      '|---|---|',
      `| Duplicate PSK | ${issues.duplicateKeyCount} |`,
      `| Low-Entropy Key | ${issues.lowEntropyCount} |`,
      `| Excessive Packets | ${issues.excessivePacketsCount} |`,
      `| Time Offset | ${issues.timeOffsetCount} |`,
      '',
      detailsLink(baseUrl, true),
    ].filter((l): l is string => l !== null).join('\n');
  }

  return [
    `MeshMonitor Security Digest — ${date}`,
    '',
    `${issueTypeCount} issue type${issueTypeCount !== 1 ? 's' : ''} detected across ${issues.total} nodes`,
    '',
    `  Duplicate PSK:    ${issues.duplicateKeyCount} node${issues.duplicateKeyCount !== 1 ? 's' : ''}`,
    `  Low-Entropy Key:  ${issues.lowEntropyCount} node${issues.lowEntropyCount !== 1 ? 's' : ''}`,
    `  Excessive Packets: ${issues.excessivePacketsCount} node${issues.excessivePacketsCount !== 1 ? 's' : ''}`,
    `  Time Offset:      ${issues.timeOffsetCount} node${issues.timeOffsetCount !== 1 ? 's' : ''}`,
    '',
    detailsLink(baseUrl, false),
  ].filter((l): l is string => l !== null).join('\n');
}

export function formatDigestDetailed(
  issues: SecurityIssuesData,
  baseUrl: string,
  suppressEmpty: boolean = true,
  format: DigestFormat = 'text'
): string | null {
  const date = new Date().toISOString().split('T')[0];
  const md = format === 'markdown';
  const issueTypeCount = [
    issues.duplicateKeyCount > 0,
    issues.lowEntropyCount > 0,
    issues.excessivePacketsCount > 0,
    issues.timeOffsetCount > 0,
  ].filter(Boolean).length;

  if (issues.total === 0) {
    if (suppressEmpty) return null;
    if (md) {
      return [
        `# MeshMonitor Security Digest — ${date}`,
        '',
        '> No security issues detected.',
        '',
        detailsLink(baseUrl, true),
      ].filter((l): l is string => l !== null).join('\n');
    }
    return [
      `MeshMonitor Security Digest — ${date}`,
      '',
      'No security issues detected.',
      '',
      detailsLink(baseUrl, false),
    ].filter((l): l is string => l !== null).join('\n');
  }

  const lines: string[] = [];

  if (md) {
    lines.push(
      `# MeshMonitor Security Digest — ${date}`,
      '',
      `> **${issueTypeCount} issue type${issueTypeCount !== 1 ? 's' : ''}** detected across **${issues.total} nodes**`,
    );
  } else {
    lines.push(
      `MeshMonitor Security Digest — ${date}`,
      '',
      `${issueTypeCount} issue type${issueTypeCount !== 1 ? 's' : ''} detected across ${issues.total} nodes`,
    );
  }

  // Duplicate PSK — group by publicKey
  const dupNodes = issues.nodes.filter(n => n.duplicateKeyDetected);
  lines.push('', md ? '## Duplicate PSK' : '--- Duplicate PSK ---');
  if (dupNodes.length === 0) {
    lines.push(md ? '*None*' : 'None');
  } else {
    const groups = new Map<string, typeof issues.nodes>();
    for (const node of dupNodes) {
      const key = node.publicKey || 'unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(node);
    }
    let groupNum = 1;
    for (const [, groupNodes] of groups) {
      if (groupNodes.length > 1) {
        if (md) {
          lines.push(`**Group ${groupNum}** (${groupNodes.length} nodes):`);
          for (const node of groupNodes) {
            lines.push(`- ${nodeName(node)} \`${nodeId(node.nodeNum)}\``);
          }
        } else {
          lines.push(`  Group ${groupNum} (${groupNodes.length} nodes):`);
          for (const node of groupNodes) {
            lines.push(`    - ${nodeName(node)} (${nodeId(node.nodeNum)})`);
          }
        }
        groupNum++;
      }
    }
    if (groupNum === 1) {
      lines.push(`${dupNodes.length} node${dupNodes.length !== 1 ? 's' : ''} with duplicate keys`);
    }
  }

  // Low-Entropy Key
  const lowEntropyNodes = issues.nodes.filter(n => n.keyIsLowEntropy);
  lines.push('', md ? '## Low-Entropy Key' : '--- Low-Entropy Key ---');
  if (lowEntropyNodes.length === 0) {
    lines.push(md ? '*None*' : 'None');
  } else {
    for (const node of lowEntropyNodes) {
      if (md) {
        lines.push(`- **${nodeName(node)}** \`${nodeId(node.nodeNum)}\``);
      } else {
        lines.push(`  - ${nodeName(node)} (${nodeId(node.nodeNum)})`);
      }
    }
  }

  // Excessive Packets
  const excessiveNodes = issues.nodes.filter(n => n.isExcessivePackets);
  lines.push('', md ? '## Excessive Packets' : '--- Excessive Packets ---');
  if (excessiveNodes.length === 0) {
    lines.push(md ? '*None*' : 'None');
  } else {
    for (const node of excessiveNodes) {
      const rate = node.packetRatePerHour != null ? ` — ${node.packetRatePerHour} pkt/hr` : '';
      if (md) {
        lines.push(`- **${nodeName(node)}**${rate}`);
      } else {
        lines.push(`  - ${nodeName(node)}${rate}`);
      }
    }
  }

  // Time Offset
  const timeOffsetNodes = issues.nodes.filter(n => n.isTimeOffsetIssue);
  lines.push('', md ? '## Time Offset' : '--- Time Offset ---');
  if (timeOffsetNodes.length === 0) {
    lines.push(md ? '*None*' : 'None');
  } else {
    for (const node of timeOffsetNodes) {
      const offset = node.timeOffsetSeconds != null ? ` — ${formatDrift(node.timeOffsetSeconds)} drift` : '';
      if (md) {
        lines.push(`- **${nodeName(node)}**${offset}`);
      } else {
        lines.push(`  - ${nodeName(node)}${offset}`);
      }
    }
  }

  const link = detailsLink(baseUrl, md);
  if (link !== null) lines.push('', link);
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

  async sendDigest(sourceIdOverride?: string): Promise<{ success: boolean; message: string }> {
    if (!this.databaseService) {
      return { success: false, message: 'Service not initialized' };
    }

    // When a specific sourceId is requested, dispatch only that one; otherwise
    // iterate every registered source and build a per-source digest.
    const targetSourceIds = sourceIdOverride
      ? [sourceIdOverride]
      : sourceManagerRegistry.getAllManagers().filter(m => m.sourceType !== 'meshcore').map(m => m.sourceId);

    if (targetSourceIds.length === 0) {
      return { success: false, message: 'No sources available' };
    }

    const results: Array<{ sourceId: string; success: boolean; message: string }> = [];
    for (const sid of targetSourceIds) {
      results.push(await this.sendDigestForSource(sid));
    }

    const anyFailure = results.some(r => !r.success);
    const summary = results.map(r => `${r.sourceId}:${r.success ? 'ok' : r.message}`).join(', ');
    return { success: !anyFailure, message: summary || 'No digests sent' };
  }

  private async sendDigestForSource(sourceId: string): Promise<{ sourceId: string; success: boolean; message: string }> {
    // Apprise URL is per-source (falls back to global via getSettingForSource)
    const appriseUrl = this.databaseService.settings
      ? await this.databaseService.settings.getSettingForSource(sourceId, 'securityDigestAppriseUrl')
      : null;
    if (!appriseUrl) {
      return { sourceId, success: false, message: 'No Apprise URL configured' };
    }

    const reportType = (await this.databaseService.settings.getSettingForSource(sourceId, 'securityDigestReportType')) || 'summary';
    const suppressEmptyRaw = await this.databaseService.settings.getSettingForSource(sourceId, 'securityDigestSuppressEmpty');
    const suppressEmpty = suppressEmptyRaw !== 'false';
    const format = ((await this.databaseService.settings.getSettingForSource(sourceId, 'securityDigestFormat')) || 'text') as DigestFormat;
    const baseUrl = (await this.databaseService.settings.getSettingForSource(sourceId, 'externalUrl')) || '';

    // Resolve source name for the title/body prefix
    let sourceName = sourceId;
    try {
      const source = this.databaseService.sources
        ? await this.databaseService.sources.getSource(sourceId)
        : null;
      if (source?.name) sourceName = source.name;
    } catch {
      // fall back to sourceId
    }

    try {
      const [keyIssueNodes, excessiveNodes, timeOffsetNodes, topBroadcasters] = await Promise.all([
        this.databaseService.getNodesWithKeySecurityIssuesAsync(sourceId),
        this.databaseService.getNodesWithExcessivePacketsAsync(sourceId),
        this.databaseService.getNodesWithTimeOffsetIssuesAsync(sourceId),
        this.databaseService.getTopBroadcastersAsync(10, sourceId),
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
          nodeMap.set(node.nodeNum, { ...node, keyIsLowEntropy: false, duplicateKeyDetected: false, isExcessivePackets: true, isTimeOffsetIssue: false, timeOffsetSeconds: null });
        }
      }
      for (const node of timeOffsetNodes) {
        const existing = nodeMap.get(node.nodeNum);
        if (existing) {
          existing.isTimeOffsetIssue = (node as any).isTimeOffsetIssue || false;
          existing.timeOffsetSeconds = (node as any).timeOffsetSeconds || null;
        } else {
          nodeMap.set(node.nodeNum, { ...node, keyIsLowEntropy: false, duplicateKeyDetected: false, isExcessivePackets: false, isTimeOffsetIssue: (node as any).isTimeOffsetIssue || false, timeOffsetSeconds: (node as any).timeOffsetSeconds || null });
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

      const rawBody = reportType === 'detailed'
        ? formatDigestDetailed(issues, baseUrl, suppressEmpty, format)
        : formatDigestSummary(issues, baseUrl, suppressEmpty, format);

      if (rawBody === null) {
        logger.debug(`[${sourceId}] Security digest suppressed — no issues found`);
        return { sourceId, success: true, message: 'No issues found, digest suppressed' };
      }

      // Prefix every digest body with the source name so operators can tell
      // which mesh it came from when they run several.
      const body = `[${sourceName}]\n${rawBody}`;

      // Reuse the same Apprise API server resolution chain as every other
      // dispatch path (setting → appriseApiServerUrl → APPRISE_URL → bundled
      // localhost default) instead of hardcoding the endpoint — #4442.
      const appriseServerUrl = await resolveAppriseServerUrl(this.databaseService.settings, sourceId);
      const response = await fetch(appriseNotifyEndpoint(appriseServerUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: [appriseUrl],
          title: `[${sourceName}] MeshMonitor Security Digest`,
          body,
          type: issues.total > 0 ? 'warning' : 'info',
          format: format === 'markdown' ? 'markdown' : 'text',
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        const text = await response.text();
        logger.error(`[${sourceId}] Security digest delivery failed: ${response.status} ${text}`);
        return { sourceId, success: false, message: `Apprise returned ${response.status}` };
      }

      logger.info(`[${sourceId}] Security digest sent (${reportType}, ${issues.total} issues)`);
      return { sourceId, success: true, message: `Digest sent with ${issues.total} issue(s)` };
    } catch (error) {
      logger.error(`[${sourceId}] Error sending security digest:`, error);
      return { sourceId, success: false, message: error instanceof Error ? error.message : 'Unknown error' };
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
