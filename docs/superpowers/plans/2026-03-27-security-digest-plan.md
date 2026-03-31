# Daily Security Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a daily scheduled security digest report delivered via Apprise, configurable from the Security page.

**Architecture:** New `securityDigestService.ts` handles scheduling (via croner) and message generation using existing security scanner data. Settings stored as key-value pairs in the settings table. UI section added to SecurityTab with enable toggle, Apprise URL, time picker, report type, and send-now button. Completely independent from the per-user notification system.

**Tech Stack:** croner (via cronScheduler.ts), Apprise HTTP API, React, existing security data functions

**Spec:** `docs/superpowers/specs/2026-03-27-security-digest-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/server/constants/settings.ts` | Modify | Add 5 new setting keys |
| `src/server/services/securityDigestService.ts` | Create | Digest scheduling, message generation, Apprise delivery |
| `src/server/services/securityDigestService.test.ts` | Create | Unit tests for message generation and scheduling logic |
| `src/server/routes/securityRoutes.ts` | Modify | Add POST `/api/security/digest/send` endpoint |
| `src/server/server.ts` | Modify | Initialize digest service on startup |
| `src/components/SecurityTab.tsx` | Modify | Add "Security Digest" config section UI |
| `src/styles/SecurityTab.css` | Modify | Styles for digest section |

---

### Task 1: Register Settings Keys

**Files:**
- Modify: `src/server/constants/settings.ts`

- [ ] **Step 1: Add digest setting keys to VALID_SETTINGS_KEYS**

Open `src/server/constants/settings.ts` and add these 5 keys to the `VALID_SETTINGS_KEYS` array:

```typescript
'securityDigestEnabled',
'securityDigestAppriseUrl',
'securityDigestTime',
'securityDigestReportType',
'securityDigestSuppressEmpty',
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: Clean compilation

- [ ] **Step 3: Commit**

```bash
git add src/server/constants/settings.ts
git commit -m "feat(security-digest): register settings keys"
```

---

### Task 2: Create Security Digest Service — Message Generation

**Files:**
- Create: `src/server/services/securityDigestService.ts`
- Create: `src/server/services/securityDigestService.test.ts`

- [ ] **Step 1: Write failing test for summary message generation**

Create `src/server/services/securityDigestService.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { formatDigestSummary, formatDigestDetailed } from './securityDigestService.js';

describe('securityDigestService', () => {
  const baseUrl = 'https://meshmonitor.example.com';

  describe('formatDigestSummary', () => {
    it('formats summary with counts', () => {
      const issues = {
        total: 5,
        lowEntropyCount: 1,
        duplicateKeyCount: 3,
        excessivePacketsCount: 1,
        timeOffsetCount: 0,
        nodes: [],
        topBroadcasters: [],
      };

      const result = formatDigestSummary(issues, baseUrl);
      expect(result).toContain('Security Digest');
      expect(result).toContain('5 nodes');
      expect(result).toContain('Duplicate PSK: 3');
      expect(result).toContain('Low-Entropy Key: 1');
      expect(result).toContain('Excessive Packets: 1');
      expect(result).toContain('Time Offset: 0');
      expect(result).toContain(baseUrl);
    });

    it('returns null when no issues and suppress is true', () => {
      const issues = {
        total: 0,
        lowEntropyCount: 0,
        duplicateKeyCount: 0,
        excessivePacketsCount: 0,
        timeOffsetCount: 0,
        nodes: [],
        topBroadcasters: [],
      };

      const result = formatDigestSummary(issues, baseUrl, true);
      expect(result).toBeNull();
    });

    it('returns message when no issues and suppress is false', () => {
      const issues = {
        total: 0,
        lowEntropyCount: 0,
        duplicateKeyCount: 0,
        excessivePacketsCount: 0,
        timeOffsetCount: 0,
        nodes: [],
        topBroadcasters: [],
      };

      const result = formatDigestSummary(issues, baseUrl, false);
      expect(result).toContain('No security issues');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/services/securityDigestService.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement summary message formatter**

Create `src/server/services/securityDigestService.ts`:

```typescript
import { logger } from '../../utils/logger.js';

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
      `🛡️ MeshMonitor Security Digest — ${date}`,
      '',
      '✅ No security issues detected.',
      '',
      `View details: ${baseUrl}/security`,
    ].join('\n');
  }

  return [
    `🛡️ MeshMonitor Security Digest — ${date}`,
    '',
    `⚠️ ${issueTypeCount} issue type${issueTypeCount !== 1 ? 's' : ''} detected across ${issues.total} nodes`,
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
      `🛡️ MeshMonitor Security Digest — ${date}`,
      '',
      '✅ No security issues detected.',
      '',
      `View details: ${baseUrl}/security`,
    ].join('\n');
  }

  const lines: string[] = [
    `🛡️ MeshMonitor Security Digest — ${date}`,
    '',
    `⚠️ ${issueTypeCount} issue type${issueTypeCount !== 1 ? 's' : ''} detected across ${issues.total} nodes`,
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/services/securityDigestService.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing test for detailed message generation**

Add to the test file:

```typescript
describe('formatDigestDetailed', () => {
  it('formats detailed report with node names grouped by issue', () => {
    const issues = {
      total: 3,
      lowEntropyCount: 1,
      duplicateKeyCount: 2,
      excessivePacketsCount: 0,
      timeOffsetCount: 0,
      nodes: [
        { nodeNum: 0x11111111, shortName: 'ALPH', longName: 'NodeAlpha', duplicateKeyDetected: true, publicKey: 'key1', keyIsLowEntropy: false, isExcessivePackets: false, isTimeOffsetIssue: false, keySecurityIssueDetails: null, packetRatePerHour: null, timeOffsetSeconds: null },
        { nodeNum: 0x22222222, shortName: 'BETA', longName: 'NodeBeta', duplicateKeyDetected: true, publicKey: 'key1', keyIsLowEntropy: false, isExcessivePackets: false, isTimeOffsetIssue: false, keySecurityIssueDetails: null, packetRatePerHour: null, timeOffsetSeconds: null },
        { nodeNum: 0x33333333, shortName: 'GAMM', longName: 'NodeGamma', duplicateKeyDetected: false, publicKey: 'key2', keyIsLowEntropy: true, isExcessivePackets: false, isTimeOffsetIssue: false, keySecurityIssueDetails: null, packetRatePerHour: null, timeOffsetSeconds: null },
      ],
      topBroadcasters: [],
    };

    const result = formatDigestDetailed(issues, baseUrl);
    expect(result).not.toBeNull();
    expect(result).toContain('NodeAlpha');
    expect(result).toContain('NodeBeta');
    expect(result).toContain('Group 1');
    expect(result).toContain('NodeGamma');
    expect(result).toContain('Low-Entropy Key');
  });
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/server/services/securityDigestService.test.ts`
Expected: PASS (implementation already handles this)

- [ ] **Step 7: Commit**

```bash
git add src/server/services/securityDigestService.ts src/server/services/securityDigestService.test.ts
git commit -m "feat(security-digest): add message formatters with tests"
```

---

### Task 3: Add Digest Service — Scheduling and Sending

**Files:**
- Modify: `src/server/services/securityDigestService.ts`

- [ ] **Step 1: Add the service class with scheduling and send logic**

Append to `src/server/services/securityDigestService.ts`:

```typescript
import { scheduleCron } from '../utils/cronScheduler.js';
import type { CronJob } from 'croner';

class SecurityDigestService {
  private cronJob: CronJob | null = null;
  private databaseService: any = null;

  initialize(databaseService: any): void {
    this.databaseService = databaseService;
    this.reschedule();
    logger.info('🛡️ Security digest service initialized');
  }

  reschedule(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }

    if (!this.databaseService) return;

    const enabled = this.databaseService.getSetting('securityDigestEnabled');
    if (enabled !== 'true') {
      logger.debug('🛡️ Security digest is disabled');
      return;
    }

    const time = this.databaseService.getSetting('securityDigestTime') || '06:00';
    const [hours, minutes] = time.split(':').map(Number);
    const cronExpression = `${minutes} ${hours} * * *`;

    this.cronJob = scheduleCron(cronExpression, async () => {
      await this.sendDigest();
    });

    logger.info(`🛡️ Security digest scheduled at ${time} daily`);
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
      const issues = {
        total: allNodes.length,
        lowEntropyCount: allNodes.filter(n => n.keyIsLowEntropy).length,
        duplicateKeyCount: allNodes.filter(n => n.duplicateKeyDetected).length,
        excessivePacketsCount: allNodes.filter(n => n.isExcessivePackets).length,
        timeOffsetCount: allNodes.filter(n => n.isTimeOffsetIssue).length,
        nodes: allNodes,
        topBroadcasters,
      };

      const body = reportType === 'detailed'
        ? formatDigestDetailed(issues, baseUrl, suppressEmpty)
        : formatDigestSummary(issues, baseUrl, suppressEmpty);

      if (body === null) {
        logger.info('🛡️ Security digest suppressed — no issues found');
        return { success: true, message: 'No issues found, digest suppressed' };
      }

      // Send via Apprise API directly
      const response = await fetch('http://localhost:8000/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: appriseUrl,
          title: '🛡️ MeshMonitor Security Digest',
          body,
          type: issues.total > 0 ? 'warning' : 'info',
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        const text = await response.text();
        logger.error(`🛡️ Security digest delivery failed: ${response.status} ${text}`);
        return { success: false, message: `Apprise returned ${response.status}` };
      }

      logger.info(`🛡️ Security digest sent (${reportType}, ${issues.total} issues)`);
      return { success: true, message: `Digest sent with ${issues.total} issue(s)` };
    } catch (error) {
      logger.error('🛡️ Error sending security digest:', error);
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
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: Clean compilation

- [ ] **Step 3: Commit**

```bash
git add src/server/services/securityDigestService.ts
git commit -m "feat(security-digest): add scheduling and Apprise delivery"
```

---

### Task 4: Add API Endpoint and Service Initialization

**Files:**
- Modify: `src/server/routes/securityRoutes.ts`
- Modify: `src/server/server.ts`

- [ ] **Step 1: Add the digest send endpoint**

In `src/server/routes/securityRoutes.ts`, add the import at the top:

```typescript
import { securityDigestService } from '../services/securityDigestService.js';
```

Add the route before the `export default router`:

```typescript
/**
 * POST /api/security/digest/send
 * Manually trigger a security digest (admin only)
 */
router.post('/digest/send', requirePermission('security', 'write'), async (_req, res) => {
  try {
    const result = await securityDigestService.sendDigest();
    res.json(result);
  } catch (error) {
    logger.error('Error sending security digest:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});
```

- [ ] **Step 2: Initialize the service in server.ts**

In `src/server/server.ts`, add the import near the other service imports:

```typescript
import { securityDigestService } from './services/securityDigestService.js';
```

After the existing service initializations (near duplicateKeySchedulerService.start()), add:

```typescript
// Security digest scheduler
securityDigestService.initialize(databaseService);
logger.debug('Security digest service initialized');
```

- [ ] **Step 3: Add reschedule call when settings change**

In `src/server/server.ts`, find the POST `/api/settings` handler. After the settings are saved, add a call to reschedule the digest if any digest setting changed:

```typescript
// Reschedule security digest if settings changed
if (Object.keys(req.body).some(k => k.startsWith('securityDigest'))) {
  securityDigestService.reschedule();
}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: Clean compilation

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/securityRoutes.ts src/server/server.ts
git commit -m "feat(security-digest): add API endpoint and service initialization"
```

---

### Task 5: Add Security Digest UI Section

**Files:**
- Modify: `src/components/SecurityTab.tsx`
- Modify: `src/styles/SecurityTab.css`

- [ ] **Step 1: Add digest state and fetch logic to SecurityTab.tsx**

In SecurityTab.tsx, add state variables near the existing scanner state:

```typescript
// Security Digest state
const [digestEnabled, setDigestEnabled] = useState(false);
const [digestAppriseUrl, setDigestAppriseUrl] = useState('');
const [digestTime, setDigestTime] = useState('06:00');
const [digestReportType, setDigestReportType] = useState<'summary' | 'detailed'>('summary');
const [digestSuppressEmpty, setDigestSuppressEmpty] = useState(true);
const [digestSaving, setDigestSaving] = useState(false);
const [digestSending, setDigestSending] = useState(false);
const [digestMessage, setDigestMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
```

In the `fetchSecurityData` function (or in a separate useEffect), load digest settings from `/api/settings`:

```typescript
// Fetch digest settings
try {
  const settings = await api.get<Record<string, string>>('/api/settings');
  setDigestEnabled(settings.securityDigestEnabled === 'true');
  setDigestAppriseUrl(settings.securityDigestAppriseUrl || '');
  setDigestTime(settings.securityDigestTime || '06:00');
  setDigestReportType((settings.securityDigestReportType as 'summary' | 'detailed') || 'summary');
  setDigestSuppressEmpty(settings.securityDigestSuppressEmpty !== 'false');
} catch (err) {
  // Settings may not exist yet, use defaults
}
```

- [ ] **Step 2: Add save and send handlers**

```typescript
const saveDigestSettings = async () => {
  setDigestSaving(true);
  setDigestMessage(null);
  try {
    await csrfFetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        securityDigestEnabled: String(digestEnabled),
        securityDigestAppriseUrl: digestAppriseUrl,
        securityDigestTime: digestTime,
        securityDigestReportType: digestReportType,
        securityDigestSuppressEmpty: String(digestSuppressEmpty),
      }),
    });
    setDigestMessage({ type: 'success', text: t('common.saved', 'Settings saved') });
  } catch (err) {
    setDigestMessage({ type: 'error', text: t('common.save_failed', 'Failed to save settings') });
  } finally {
    setDigestSaving(false);
  }
};

const sendDigestNow = async () => {
  setDigestSending(true);
  setDigestMessage(null);
  try {
    const result = await api.post<{ success: boolean; message: string }>('/api/security/digest/send', {});
    setDigestMessage({
      type: result.success ? 'success' : 'error',
      text: result.message,
    });
  } catch (err) {
    setDigestMessage({ type: 'error', text: t('common.failed', 'Failed to send digest') });
  } finally {
    setDigestSending(false);
  }
};
```

- [ ] **Step 3: Add the JSX for the digest section**

Add after the scanner status section (before the issues list), guarded by `canWrite`:

```tsx
{canWrite && (
  <div className="issues-section digest-section">
    <h3>🛡️ {t('security.digest_title', 'Security Digest')}</h3>
    <p className="section-description">
      {t('security.digest_description', 'Schedule a daily security report delivered via Apprise.')}
    </p>

    <div className="digest-controls">
      <div className="digest-row">
        <label className="digest-label">
          <input
            type="checkbox"
            checked={digestEnabled}
            onChange={e => setDigestEnabled(e.target.checked)}
          />
          {t('security.digest_enabled', 'Enable daily digest')}
        </label>
      </div>

      <div className="digest-row">
        <label className="digest-label">{t('security.digest_apprise_url', 'Apprise URL')}</label>
        <input
          type="text"
          className="digest-input"
          value={digestAppriseUrl}
          onChange={e => setDigestAppriseUrl(e.target.value)}
          placeholder="discord://webhook_id/webhook_token"
        />
      </div>

      <div className="digest-row">
        <label className="digest-label">{t('security.digest_time', 'Send at')}</label>
        <input
          type="time"
          className="digest-input digest-time"
          value={digestTime}
          onChange={e => setDigestTime(e.target.value)}
        />
      </div>

      <div className="digest-row">
        <label className="digest-label">{t('security.digest_report_type', 'Report type')}</label>
        <select
          className="digest-input digest-select"
          value={digestReportType}
          onChange={e => setDigestReportType(e.target.value as 'summary' | 'detailed')}
        >
          <option value="summary">{t('security.digest_summary', 'Summary')}</option>
          <option value="detailed">{t('security.digest_detailed', 'Detailed')}</option>
        </select>
      </div>

      <div className="digest-row">
        <label className="digest-label">
          <input
            type="checkbox"
            checked={digestSuppressEmpty}
            onChange={e => setDigestSuppressEmpty(e.target.checked)}
          />
          {t('security.digest_suppress_empty', 'Suppress when no issues')}
        </label>
      </div>

      <div className="digest-actions">
        <button
          className="digest-save-btn"
          onClick={saveDigestSettings}
          disabled={digestSaving}
        >
          {digestSaving ? t('common.saving', 'Saving...') : t('common.save', 'Save')}
        </button>
        <button
          className="digest-send-btn"
          onClick={sendDigestNow}
          disabled={digestSending || !digestAppriseUrl}
        >
          {digestSending ? t('common.sending', 'Sending...') : t('security.digest_send_now', 'Send Now')}
        </button>
      </div>

      {digestMessage && (
        <div className={`digest-message ${digestMessage.type}`}>
          {digestMessage.text}
        </div>
      )}
    </div>
  </div>
)}
```

- [ ] **Step 4: Add CSS for the digest section**

Append to `src/styles/SecurityTab.css`:

```css
/* Security Digest Section */
.digest-section {
  margin-bottom: 20px;
}

.digest-controls {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  background: var(--ctp-surface0);
  border-radius: var(--radius-lg);
}

.digest-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.digest-label {
  min-width: 140px;
  font-size: 14px;
  color: var(--ctp-text);
  display: flex;
  align-items: center;
  gap: 6px;
}

.digest-input {
  flex: 1;
  padding: 6px 10px;
  background: var(--ctp-surface1);
  border: 1px solid var(--ctp-surface2);
  border-radius: var(--radius-sm);
  color: var(--ctp-text);
  font-size: 14px;
}

.digest-input:focus {
  outline: none;
  border-color: var(--ctp-blue);
}

.digest-time {
  max-width: 120px;
  flex: unset;
}

.digest-select {
  max-width: 200px;
  flex: unset;
}

.digest-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.digest-save-btn,
.digest-send-btn {
  padding: 8px 16px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s;
}

.digest-save-btn {
  background: var(--ctp-blue);
  color: var(--ctp-base);
}

.digest-save-btn:hover:not(:disabled) {
  background: var(--ctp-sapphire);
}

.digest-send-btn {
  background: var(--ctp-green);
  color: var(--ctp-base);
}

.digest-send-btn:hover:not(:disabled) {
  background: var(--ctp-teal);
}

.digest-save-btn:disabled,
.digest-send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.digest-message {
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 13px;
}

.digest-message.success {
  background: var(--ctp-green);
  color: var(--ctp-base);
}

.digest-message.error {
  background: var(--ctp-red);
  color: var(--ctp-base);
}
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: Clean compilation

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/components/SecurityTab.tsx src/styles/SecurityTab.css
git commit -m "feat(security-digest): add UI section to Security tab"
```

---

### Task 6: Integration Test and Final Verification

**Files:**
- All files from previous tasks

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass including new securityDigestService tests

- [ ] **Step 2: TypeScript compilation check**

Run: `npx tsc --noEmit`
Expected: Clean compilation

- [ ] **Step 3: Build and deploy dev container**

```bash
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml build
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml up -d
```

Verify at http://localhost:8081/meshmonitor:
1. Navigate to Security tab
2. See "Security Digest" section with all controls
3. Configure settings and click Save
4. Click "Send Now" (will fail without Apprise running — that's expected in dev)

- [ ] **Step 4: Final commit if any adjustments needed**

```bash
git add -A
git commit -m "feat(security-digest): final adjustments"
```
