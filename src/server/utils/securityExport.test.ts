import { describe, it, expect } from 'vitest';
import { buildSecurityExport } from './securityExport.js';
import type { CollectedSecurityIssues, SecurityIssueNode } from '../services/securityIssuesService.js';

function node(over: Partial<SecurityIssueNode>): SecurityIssueNode {
  return {
    nodeKey: 'mt:1', protocol: 'meshtastic', nodeNum: 1, shortName: 'S', longName: 'L', lastHeard: null,
    keyIsLowEntropy: false, duplicateKeyDetected: false, isExcessivePackets: false, packetRatePerHour: null,
    packetRateLastChecked: null, isTimeOffsetIssue: false, timeOffsetSeconds: null, ...over,
  };
}
function issues(nodes: SecurityIssueNode[], protocol: 'meshtastic' | 'meshcore' = 'meshtastic'): CollectedSecurityIssues {
  return {
    protocol, total: nodes.length, lowEntropyCount: 0, duplicateKeyCount: 0, excessivePacketsCount: 0, timeOffsetCount: 0,
    signatureFailureCount: 0, nameReuseCount: 0,
    counts: { lowEntropy: 0, duplicateKey: 0, excessivePackets: 0, timeOffset: 0, signatureFailure: 0, nameReuse: 0, ownKeyChanged: 0 },
    nodes, topBroadcasters: [], ownKeyChange: null,
  };
}

describe('buildSecurityExport CSV escaping', () => {
  it('quotes embedded quotes, commas and newlines, and neutralises formula cells', () => {
    const out = buildSecurityExport(
      issues([node({ shortName: '=cmd', longName: 'A "q", b\nc', keySecurityIssueDetails: 'x, y' })]),
      'csv',
    );
    expect(out.contentType).toBe('text/csv');
    expect(out.body).toContain(`'=cmd`);
    expect(out.body).toContain('"A ""q"", b\nc"');
    expect(out.body).toContain('"x, y"');
    expect(out.body.endsWith('\r\n')).toBe(true);
  });

  it('a negative offset stays a plain number', () => {
    const out = buildSecurityExport(issues([node({ isTimeOffsetIssue: true, timeOffsetSeconds: -90 })]), 'csv');
    expect(out.body).toContain(',Yes,-90,');
  });
});
