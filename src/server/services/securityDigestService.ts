import { logger } from '../../utils/logger.js';
import { scheduleCron } from '../utils/cronScheduler.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isAnyMeshCoreSourceType } from '../../utils/nodeTypeCategory.js';
import { resolveAppriseServerUrl, appriseNotifyEndpoint } from './appriseNotificationService.js';
import type { Cron as CronJob } from 'croner';
import { CLOCK_NOT_SET_OFFSET_SECONDS } from '../../utils/securityClock.js';
import {
  collectSecurityIssues,
  type CollectedSecurityIssues,
  type SecurityIssueNode,
} from './securityIssuesService.js';

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

/**
 * One digest section (#6281 S5): a title, how many nodes it covers, and the
 * detail lines the "detailed" report prints under the heading. Both protocols
 * build sections; one formatter renders them.
 */
export interface DigestSection {
  title: string;
  count: number;
  /** Detail lines under the heading; empty prints "None". */
  body: (markdown: boolean) => string[];
}

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
 * message. `externalUrl` is a global, admin-configurable setting (#4437) that defaults
 * to unset — an install that has never set it keeps getting no link, unchanged from
 * before #4437.
 */
function detailsLink(baseUrl: string, markdown: boolean): string | null {
  if (!baseUrl) return null;
  return markdown ? `[View details](${baseUrl}/security)` : `View details: ${baseUrl}/security`;
}

const plural = (n: number, word: string): string => `${n} ${word}${n !== 1 ? 's' : ''}`;

function emptyDigest(date: string, baseUrl: string, md: boolean): string {
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

/** The one summary renderer: a count table (markdown) or aligned count lines (text). */
export function formatSummarySections(
  sections: DigestSection[],
  total: number,
  baseUrl: string,
  suppressEmpty: boolean = true,
  format: DigestFormat = 'text',
): string | null {
  const date = new Date().toISOString().split('T')[0];
  const md = format === 'markdown';
  const issueTypeCount = sections.filter((x) => x.count > 0).length;

  if (total === 0) {
    if (suppressEmpty) return null;
    return emptyDigest(date, baseUrl, md);
  }

  if (md) {
    return [
      `# MeshMonitor Security Digest — ${date}`,
      '',
      `> **${plural(issueTypeCount, 'issue type')}** detected across **${total} nodes**`,
      '',
      '| Issue Type | Count |',
      '|---|---|',
      ...sections.map((x) => `| ${x.title} | ${x.count} |`),
      '',
      detailsLink(baseUrl, true),
    ].filter((l): l is string => l !== null).join('\n');
  }

  return [
    `MeshMonitor Security Digest — ${date}`,
    '',
    `${plural(issueTypeCount, 'issue type')} detected across ${total} nodes`,
    '',
    ...sections.map((x) => {
      const label = `${x.title}:`;
      return `  ${label.padEnd(18)}${label.length >= 18 ? ' ' : ''}${plural(x.count, 'node')}`;
    }),
    '',
    detailsLink(baseUrl, false),
  ].filter((l): l is string => l !== null).join('\n');
}

/** The one detailed renderer: every section, with its detail lines or "None". */
export function formatDetailedSections(
  sections: DigestSection[],
  total: number,
  baseUrl: string,
  suppressEmpty: boolean = true,
  format: DigestFormat = 'text',
): string | null {
  const date = new Date().toISOString().split('T')[0];
  const md = format === 'markdown';
  const issueTypeCount = sections.filter((x) => x.count > 0).length;

  if (total === 0) {
    if (suppressEmpty) return null;
    return emptyDigest(date, baseUrl, md);
  }

  const lines: string[] = [];
  if (md) {
    lines.push(
      `# MeshMonitor Security Digest — ${date}`,
      '',
      `> **${plural(issueTypeCount, 'issue type')}** detected across **${total} nodes**`,
    );
  } else {
    lines.push(
      `MeshMonitor Security Digest — ${date}`,
      '',
      `${plural(issueTypeCount, 'issue type')} detected across ${total} nodes`,
    );
  }

  for (const section of sections) {
    lines.push('', md ? `## ${section.title}` : `--- ${section.title} ---`);
    const body = section.body(md);
    lines.push(...(body.length > 0 ? body : [md ? '*None*' : 'None']));
  }

  const link = detailsLink(baseUrl, md);
  if (link !== null) lines.push('', link);
  return lines.join('\n');
}

function meshtasticSections(issues: SecurityIssuesData): DigestSection[] {
  const dupNodes = issues.nodes.filter(n => n.duplicateKeyDetected);
  const lowEntropyNodes = issues.nodes.filter(n => n.keyIsLowEntropy);
  const excessiveNodes = issues.nodes.filter(n => n.isExcessivePackets);
  const timeOffsetNodes = issues.nodes.filter(n => n.isTimeOffsetIssue);
  return [
    {
      title: 'Duplicate PSK',
      count: issues.duplicateKeyCount,
      // Group by publicKey.
      body: (md) => {
        const lines: string[] = [];
        if (dupNodes.length === 0) return lines;
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
              for (const node of groupNodes) lines.push(`- ${nodeName(node)} \`${nodeId(node.nodeNum)}\``);
            } else {
              lines.push(`  Group ${groupNum} (${groupNodes.length} nodes):`);
              for (const node of groupNodes) lines.push(`    - ${nodeName(node)} (${nodeId(node.nodeNum)})`);
            }
            groupNum++;
          }
        }
        if (groupNum === 1) {
          lines.push(`${dupNodes.length} node${dupNodes.length !== 1 ? 's' : ''} with duplicate keys`);
        }
        return lines;
      },
    },
    {
      title: 'Low-Entropy Key',
      count: issues.lowEntropyCount,
      body: (md) =>
        lowEntropyNodes.map((node) =>
          md ? `- **${nodeName(node)}** \`${nodeId(node.nodeNum)}\`` : `  - ${nodeName(node)} (${nodeId(node.nodeNum)})`),
    },
    {
      title: 'Excessive Packets',
      count: issues.excessivePacketsCount,
      body: (md) =>
        excessiveNodes.map((node) => {
          const rate = node.packetRatePerHour != null ? ` — ${node.packetRatePerHour} pkt/hr` : '';
          return md ? `- **${nodeName(node)}**${rate}` : `  - ${nodeName(node)}${rate}`;
        }),
    },
    {
      title: 'Time Offset',
      count: issues.timeOffsetCount,
      body: (md) =>
        timeOffsetNodes.map((node) => {
          const offset = node.timeOffsetSeconds != null ? ` — ${formatDrift(node.timeOffsetSeconds)} drift` : '';
          return md ? `- **${nodeName(node)}**${offset}` : `  - ${nodeName(node)}${offset}`;
        }),
    },
  ];
}

export function formatDigestSummary(
  issues: SecurityIssuesData,
  baseUrl: string,
  suppressEmpty: boolean = true,
  format: DigestFormat = 'text'
): string | null {
  return formatSummarySections(meshtasticSections(issues), issues.total, baseUrl, suppressEmpty, format);
}

export function formatDigestDetailed(
  issues: SecurityIssuesData,
  baseUrl: string,
  suppressEmpty: boolean = true,
  format: DigestFormat = 'text'
): string | null {
  return formatDetailedSections(meshtasticSections(issues), issues.total, baseUrl, suppressEmpty, format);
}

/** A year or more off: a node whose clock was never set (no RTC, factory default). */
const CLOCK_NOT_SET_SECONDS = CLOCK_NOT_SET_OFFSET_SECONDS;

function mcName(node: { longName: string | null; shortName: string | null; publicKey?: string | null }): string {
  return node.longName || node.shortName || (node.publicKey ? `mc:${node.publicKey.slice(0, 8)}` : 'unknown');
}

/** MeshCore sections (#6281): rates, clock, advert signatures, name reuse and the own-key change. */
export function meshcoreDigestSections(issues: CollectedSecurityIssues): DigestSection[] {
  const keyTag = (n: SecurityIssueNode): string => (n.publicKey ? `\`${n.publicKey.slice(0, 8)}\`` : '');
  const keyTagText = (n: SecurityIssueNode): string => (n.publicKey ? ` (${n.publicKey.slice(0, 8)})` : '');
  const nodes = issues.nodes;
  const own = issues.ownKeyChange;
  return [
    {
      title: 'Excessive packets',
      count: issues.counts.excessivePackets,
      body: (md) =>
        nodes.filter((n) => n.isExcessivePackets).map((n) => {
          const rate = n.packetRatePerHour != null ? ` — ${n.packetRatePerHour} pkt/hr` : '';
          return md ? `- **${mcName(n)}**${rate}` : `  - ${mcName(n)}${rate}`;
        }),
    },
    {
      title: 'Clock offset',
      count: issues.counts.timeOffset,
      body: (md) =>
        nodes.filter((n) => n.isTimeOffsetIssue).map((n) => {
          const sec = n.timeOffsetSeconds;
          const detail =
            sec == null ? '' : Math.abs(sec) >= CLOCK_NOT_SET_SECONDS ? ' — clock not set' : ` — ${formatDrift(sec)} drift`;
          return md ? `- **${mcName(n)}**${detail}` : `  - ${mcName(n)}${detail}`;
        }),
    },
    {
      title: 'Advert signature failed',
      count: issues.counts.signatureFailure,
      body: (md) =>
        nodes.filter((n) => n.advertSignatureFailed).map((n) =>
          md ? `- **${mcName(n)}** ${keyTag(n)}` : `  - ${mcName(n)}${keyTagText(n)}`),
    },
    {
      title: 'Name reused under new key',
      count: issues.counts.nameReuse,
      body: (md) =>
        nodes.filter((n) => n.nameReused).map((n) =>
          md ? `- **${mcName(n)}** ${keyTag(n)}` : `  - ${mcName(n)}${keyTagText(n)}`),
    },
    {
      title: 'Own key changed (pending acknowledge)',
      count: issues.counts.ownKeyChanged,
      body: (md) => {
        if (!own) return [];
        const from = own.previousKey ? own.previousKey.slice(0, 8) : 'unknown';
        const to = own.currentKey ? own.currentKey.slice(0, 8) : 'unknown';
        return [md ? `- \`${from}\` → \`${to}\`` : `  - ${from} -> ${to}`];
      },
    },
  ];
}

/** Total shown in a MeshCore digest: flagged nodes plus an unacknowledged own-key change. */
export function meshcoreDigestTotal(issues: CollectedSecurityIssues): number {
  return issues.total + (issues.ownKeyChange ? 1 : 0);
}

/**
 * Drop a rendered digest's own title line (and the blank line after it), so a
 * per-source body can sit under a source heading in the combined digest (L14).
 */
export function stripDigestTitle(body: string): string {
  const lines = body.split('\n');
  if (/^(# )?MeshMonitor Security Digest/.test(lines[0] ?? '')) {
    lines.shift();
    if (lines[0] === '') lines.shift();
  }
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

  async sendDigest(sourceIdOverride?: string): Promise<{ success: boolean; message: string; skipped?: boolean }> {
    if (!this.databaseService) {
      return { success: false, message: 'Service not initialized' };
    }

    // When a specific sourceId is requested, dispatch only that one; otherwise
    // iterate every registered source (Meshtastic and MeshCore, #6281) and
    // build a per-source digest.
    const targetSourceIds = sourceIdOverride
      ? [sourceIdOverride]
      : sourceManagerRegistry.getAllManagers().map(m => m.sourceId);

    if (targetSourceIds.length === 0) {
      return { success: false, message: 'No sources available' };
    }

    const results: Array<{ sourceId: string; success: boolean; message: string; skipped?: boolean }> = [];
    if (sourceIdOverride) {
      results.push(await this.sendDigestForSource(sourceIdOverride));
    } else {
      // L14 (4.17.3 review): sources with their own Apprise URL get their own
      // digest. Sources that fall back to the global URL share ONE combined
      // digest, so a global URL saved before #6281 does not turn into one
      // message per source every day.
      const fallbackSourceIds: string[] = [];
      for (const sid of targetSourceIds) {
        if (await this.hasOwnDigestUrl(sid)) {
          results.push(await this.sendDigestForSource(sid));
        } else {
          fallbackSourceIds.push(sid);
        }
      }
      if (fallbackSourceIds.length === 1) {
        // One source: its digest is already the combined one; keep its title.
        results.push(await this.sendDigestForSource(fallbackSourceIds[0]));
      } else if (fallbackSourceIds.length > 1) {
        results.push(...await this.sendCombinedDigest(fallbackSourceIds));
      }
    }

    const anyFailure = results.some(r => !r.success);
    const summary = results.map(r => `${r.sourceId}:${r.skipped ? 'skipped' : r.success ? 'ok' : r.message}`).join(', ');
    const allSkipped = results.length > 0 && results.every(r => r.skipped);
    return {
      success: !anyFailure,
      message: summary || 'No digests sent',
      ...(allSkipped ? { skipped: true } : {}),
    };
  }

  /**
   * A digest setting for a source. The four per-source digest keys fall back to
   * the global row when the source has none (#6281): the Security tab used to
   * save them globally, so an existing global Apprise URL still applies.
   */
  private async digestSetting(sourceId: string, key: string): Promise<string | null> {
    const own = await this.databaseService.settings.getSettingForSource(sourceId, key);
    if (own !== null && own !== undefined && own !== '') return own;
    const global = await this.databaseService.settings.getSetting?.(key);
    return global ?? own ?? null;
  }

  /** True when the source has its own (non-empty) digest Apprise URL row. */
  private async hasOwnDigestUrl(sourceId: string): Promise<boolean> {
    if (!this.databaseService.settings) return false;
    const own = await this.databaseService.settings.getSettingForSource(sourceId, 'securityDigestAppriseUrl');
    return own !== null && own !== undefined && own !== '';
  }

  /** A source's display name, or its id. */
  private async sourceNameOf(sourceId: string): Promise<string> {
    try {
      const source = this.databaseService.sources
        ? await this.databaseService.sources.getSource(sourceId)
        : null;
      if (source?.name) return source.name;
    } catch {
      // fall back to sourceId
    }
    return sourceId;
  }

  /**
   * Collect one source's issues and render its digest body, or null when it
   * has none and `suppressEmpty` is on.
   */
  private async renderSourceDigest(
    sourceId: string,
    opts: { reportType: string; suppressEmpty: boolean; format: DigestFormat; baseUrl: string },
  ): Promise<{ body: string | null; total: number }> {
    const protocol = isAnyMeshCoreSourceType(sourceManagerRegistry.getManager?.(sourceId)?.sourceType)
      ? 'meshcore'
      : 'meshtastic';
    const collected = await collectSecurityIssues(this.databaseService, sourceId, { protocol, topBroadcasters: 10 });
    let sections: DigestSection[];
    let total: number;
    if (protocol === 'meshcore') {
      sections = meshcoreDigestSections(collected);
      total = meshcoreDigestTotal(collected);
    } else {
      sections = meshtasticSections({
        total: collected.total,
        lowEntropyCount: collected.lowEntropyCount,
        duplicateKeyCount: collected.duplicateKeyCount,
        excessivePacketsCount: collected.excessivePacketsCount,
        timeOffsetCount: collected.timeOffsetCount,
        nodes: collected.nodes,
        topBroadcasters: collected.topBroadcasters,
      });
      total = collected.total;
    }
    const body = opts.reportType === 'detailed'
      ? formatDetailedSections(sections, total, opts.baseUrl, opts.suppressEmpty, opts.format)
      : formatSummarySections(sections, total, opts.baseUrl, opts.suppressEmpty, opts.format);
    return { body, total };
  }

  /**
   * One digest for every source that uses the global Apprise URL (L14). Uses
   * the global report type, format and suppress-empty settings, since one
   * message has one format. Each source is a section; a source with no
   * issues is left out when suppress-empty is on, and nothing is sent when
   * every section is empty. One source failing to build does not stop the rest.
   */
  private async sendCombinedDigest(sourceIds: string[]): Promise<Array<{ sourceId: string; success: boolean; message: string; skipped?: boolean }>> {
    const settings = this.databaseService.settings;
    const globalUrl = settings ? await settings.getSetting?.('securityDigestAppriseUrl') : null;
    if (!globalUrl) {
      return sourceIds.map((sourceId) => ({ sourceId, success: true, skipped: true, message: 'No Apprise URL configured' }));
    }
    const reportType = (await settings.getSetting?.('securityDigestReportType')) || 'summary';
    const suppressEmpty = (await settings.getSetting?.('securityDigestSuppressEmpty')) !== 'false';
    const format = ((await settings.getSetting?.('securityDigestFormat')) || 'text') as DigestFormat;
    const baseUrl = (await settings.getSetting('externalUrl')) || '';
    const md = format === 'markdown';

    const results: Array<{ sourceId: string; success: boolean; message: string; skipped?: boolean }> = [];
    const included: string[] = [];
    const blocks: string[] = [];
    let grandTotal = 0;
    for (const sourceId of sourceIds) {
      try {
        const { body, total } = await this.renderSourceDigest(sourceId, { reportType, suppressEmpty, format, baseUrl });
        if (body === null) {
          results.push({ sourceId, success: true, message: 'No issues found, digest suppressed' });
          continue;
        }
        const name = await this.sourceNameOf(sourceId);
        blocks.push([md ? `## ${name}` : `=== ${name} ===`, '', stripDigestTitle(body)].join('\n'));
        included.push(sourceId);
        grandTotal += total;
      } catch (error) {
        logger.error(`[${sourceId}] Error building security digest:`, error);
        results.push({ sourceId, success: false, message: error instanceof Error ? error.message : 'Unknown error' });
      }
    }
    if (blocks.length === 0) {
      logger.debug('Combined security digest suppressed — no issues found');
      return results;
    }

    const date = new Date().toISOString().split('T')[0];
    try {
      const appriseServerUrl = await resolveAppriseServerUrl(settings, null);
      const response = await fetch(appriseNotifyEndpoint(appriseServerUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: [globalUrl],
          title: `MeshMonitor Security Digest — ${date} (${blocks.length} ${blocks.length === 1 ? 'source' : 'sources'})`,
          body: blocks.join(md ? '\n\n---\n\n' : '\n\n'),
          type: grandTotal > 0 ? 'warning' : 'info',
          format: md ? 'markdown' : 'text',
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        const text = await response.text();
        logger.error(`Combined security digest delivery failed: ${response.status} ${text}`);
        for (const sourceId of included) results.push({ sourceId, success: false, message: `Apprise returned ${response.status}` });
        return results;
      }
      logger.info(`Combined security digest sent for ${included.length} sources (${reportType}, ${grandTotal} issues)`);
      for (const sourceId of included) results.push({ sourceId, success: true, message: 'Sent in the combined digest' });
    } catch (error) {
      logger.error('Error sending combined security digest:', error);
      for (const sourceId of included) results.push({ sourceId, success: false, message: error instanceof Error ? error.message : 'Unknown error' });
    }
    return results;
  }

  private async sendDigestForSource(sourceId: string): Promise<{ sourceId: string; success: boolean; message: string; skipped?: boolean }> {
    const appriseUrl = this.databaseService.settings
      ? await this.digestSetting(sourceId, 'securityDigestAppriseUrl')
      : null;
    if (!appriseUrl) {
      // Not configured is not a failure: nothing was asked for (#6281).
      return { sourceId, success: true, skipped: true, message: 'No Apprise URL configured' };
    }

    const reportType = (await this.digestSetting(sourceId, 'securityDigestReportType')) || 'summary';
    const suppressEmptyRaw = await this.digestSetting(sourceId, 'securityDigestSuppressEmpty');
    const suppressEmpty = suppressEmptyRaw !== 'false';
    const format = ((await this.digestSetting(sourceId, 'securityDigestFormat')) || 'text') as DigestFormat;
    // externalUrl is a GLOBAL-only setting (#4437) — one origin per install, not
    // one per source (see settingsRoutes.ts's validation comment). Deliberately
    // `getSetting`, NOT `getSettingForSource`: the latter, when passed a truthy
    // sourceId, reads ONLY the `source:<id>:externalUrl` row and does NOT fall
    // back to the global key (that per-source-miss fallback was removed from
    // getSettingForSource for #2839/#2840 — see settings.ts's own docstring).
    // Since externalUrl has no per-source writer, getSettingForSource(sourceId, …)
    // here would always read null and silently break the "View details" link
    // for every source. `getSetting` reads the global row directly.
    const baseUrl = (await this.databaseService.settings.getSetting('externalUrl')) || '';

    const sourceName = await this.sourceNameOf(sourceId);

    try {
      const { body: rawBody, total } = await this.renderSourceDigest(sourceId, { reportType, suppressEmpty, format, baseUrl });
      const issues = { total };

      if (rawBody === null) {
        logger.debug(`[${sourceId}] Security digest suppressed — no issues found`);
        return { sourceId, success: true, message: 'No issues found, digest suppressed' };
      }

      // The title names the source, so operators can tell which mesh a digest
      // came from when they run several. The body does not repeat it (#5593).
      const body = rawBody;

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
