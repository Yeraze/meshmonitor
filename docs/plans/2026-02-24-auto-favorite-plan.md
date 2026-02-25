# Auto Favorite Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically favorite eligible 0-hop nodes for zero-cost hop routing, with periodic staleness cleanup.

**Architecture:** Event-driven `checkAutoFavorite()` method triggered on NodeInfo updates (same pattern as `checkAutoWelcome()`), plus a periodic 60-minute sweep for staleness cleanup. Frontend is a self-contained `AutoFavoriteSection.tsx` component in the Automation tab. No database migrations needed — uses existing `isFavorite` column and the settings key-value store.

**Tech Stack:** TypeScript, React 19, Express 5, Vitest, useSaveBar hook, useCsrfFetch hook, Meshtastic admin messages (setFavoriteNode/removeFavoriteNode)

**Design doc:** `docs/plans/2026-02-24-auto-favorite-design.md`

---

## Key References

- **Eligibility logic:** See design doc "Eligibility Rules" table
- **Existing favorites infra:** `sendFavoriteNode()` at `src/server/meshtasticManager.ts:9837`, `sendRemoveFavoriteNode()` at line 9876, `supportsFavorites()` at line 9801
- **Call site for event trigger:** `src/server/meshtasticManager.ts:4057` (alongside `checkAutoWelcome`)
- **UI pattern to follow:** `src/components/AutoPingSection.tsx` (self-managed state, `useSaveBar`, `useCsrfFetch`)
- **App.tsx automation tab:** Lines 4493-4658 (nav entries + section rendering)
- **Favorite API endpoint:** `src/server/server.ts:916` (`POST /api/nodes/:nodeId/favorite`)
- **DeviceRole constants:** `src/constants/index.ts` (`CLIENT_BASE=12, ROUTER=2, ROUTER_LATE=11`)
- **DbNode type:** `src/db/types.ts:31` (has `role`, `hopsAway`, `isFavorite`, `lastHeard`)
- **Node role names:** `src/constants/index.ts` (`ROLE_NAMES` map)

---

### Task 1: Backend — `checkAutoFavorite()` method

**Files:**
- Modify: `src/server/meshtasticManager.ts` (add method + call site + Set guard property)
- Test: `src/server/meshtasticManager.autoFavorite.test.ts`

**Step 1: Write the failing test**

Create `src/server/meshtasticManager.autoFavorite.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// We'll test the eligibility logic as a pure function extracted for testability.
// The actual checkAutoFavorite method is private, so we test via the exported helper.

import { isAutoFavoriteEligible } from '../constants/autoFavorite';
import { DeviceRole } from '../../constants';

describe('isAutoFavoriteEligible', () => {
  it('returns true for 0-hop ROUTER when local is ROUTER', () => {
    expect(isAutoFavoriteEligible(
      DeviceRole.ROUTER, // localRole
      { hopsAway: 0, role: DeviceRole.ROUTER, isFavorite: false } // targetNode
    )).toBe(true);
  });

  it('returns true for 0-hop ROUTER_LATE when local is ROUTER', () => {
    expect(isAutoFavoriteEligible(
      DeviceRole.ROUTER,
      { hopsAway: 0, role: DeviceRole.ROUTER_LATE, isFavorite: false }
    )).toBe(true);
  });

  it('returns true for 0-hop CLIENT_BASE when local is ROUTER', () => {
    expect(isAutoFavoriteEligible(
      DeviceRole.ROUTER,
      { hopsAway: 0, role: DeviceRole.CLIENT_BASE, isFavorite: false }
    )).toBe(true);
  });

  it('returns false for 0-hop CLIENT when local is ROUTER', () => {
    expect(isAutoFavoriteEligible(
      DeviceRole.ROUTER,
      { hopsAway: 0, role: DeviceRole.CLIENT, isFavorite: false }
    )).toBe(false);
  });

  it('returns true for 0-hop CLIENT when local is CLIENT_BASE (any role eligible)', () => {
    expect(isAutoFavoriteEligible(
      DeviceRole.CLIENT_BASE,
      { hopsAway: 0, role: DeviceRole.CLIENT, isFavorite: false }
    )).toBe(true);
  });

  it('returns true for 0-hop ROUTER when local is CLIENT_BASE', () => {
    expect(isAutoFavoriteEligible(
      DeviceRole.CLIENT_BASE,
      { hopsAway: 0, role: DeviceRole.ROUTER, isFavorite: false }
    )).toBe(true);
  });

  it('returns false for multi-hop node regardless of role', () => {
    expect(isAutoFavoriteEligible(
      DeviceRole.ROUTER,
      { hopsAway: 2, role: DeviceRole.ROUTER, isFavorite: false }
    )).toBe(false);
  });

  it('returns false when local role is CLIENT (not eligible)', () => {
    expect(isAutoFavoriteEligible(
      DeviceRole.CLIENT,
      { hopsAway: 0, role: DeviceRole.ROUTER, isFavorite: false }
    )).toBe(false);
  });

  it('returns false when target is already favorited', () => {
    expect(isAutoFavoriteEligible(
      DeviceRole.ROUTER,
      { hopsAway: 0, role: DeviceRole.ROUTER, isFavorite: true }
    )).toBe(false);
  });

  it('returns false when hopsAway is null/undefined', () => {
    expect(isAutoFavoriteEligible(
      DeviceRole.ROUTER,
      { hopsAway: null, role: DeviceRole.ROUTER, isFavorite: false }
    )).toBe(false);
    expect(isAutoFavoriteEligible(
      DeviceRole.ROUTER,
      { hopsAway: undefined, role: DeviceRole.ROUTER, isFavorite: false }
    )).toBe(false);
  });

  it('returns true for ROUTER_LATE local with 0-hop ROUTER target', () => {
    expect(isAutoFavoriteEligible(
      DeviceRole.ROUTER_LATE,
      { hopsAway: 0, role: DeviceRole.ROUTER, isFavorite: false }
    )).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/meshtasticManager.autoFavorite.test.ts`
Expected: FAIL — module `../constants/autoFavorite` not found

**Step 3: Write the eligibility helper**

Create `src/server/constants/autoFavorite.ts`:

```typescript
import { DeviceRole } from '../../constants';

/** Roles that benefit from zero-cost hop favoriting */
export const AUTO_FAVORITE_LOCAL_ROLES = new Set([
  DeviceRole.ROUTER,
  DeviceRole.ROUTER_LATE,
  DeviceRole.CLIENT_BASE,
]);

/** Roles eligible as zero-cost relay favorites (for ROUTER/ROUTER_LATE local) */
export const ZERO_HOP_RELAY_ROLES = new Set([
  DeviceRole.ROUTER,
  DeviceRole.ROUTER_LATE,
  DeviceRole.CLIENT_BASE,
]);

interface AutoFavoriteTarget {
  hopsAway?: number | null;
  role?: number | null;
  isFavorite?: boolean | null;
}

/**
 * Determines if a target node is eligible for auto-favoriting.
 * - Local must be ROUTER, ROUTER_LATE, or CLIENT_BASE
 * - Target must be 0-hop (hopsAway === 0)
 * - Target must not already be favorited
 * - For ROUTER/ROUTER_LATE local: target must also be ROUTER/ROUTER_LATE/CLIENT_BASE
 * - For CLIENT_BASE local: any role is eligible
 */
export function isAutoFavoriteEligible(
  localRole: number | undefined | null,
  target: AutoFavoriteTarget
): boolean {
  // Local role must be eligible
  if (localRole == null || !AUTO_FAVORITE_LOCAL_ROLES.has(localRole)) {
    return false;
  }

  // Target must be 0-hop
  if (target.hopsAway == null || target.hopsAway !== 0) {
    return false;
  }

  // Target must not already be favorited
  if (target.isFavorite) {
    return false;
  }

  // For ROUTER/ROUTER_LATE: target must have an eligible relay role
  if (localRole === DeviceRole.ROUTER || localRole === DeviceRole.ROUTER_LATE) {
    if (target.role == null || !ZERO_HOP_RELAY_ROLES.has(target.role)) {
      return false;
    }
  }

  // CLIENT_BASE: any 0-hop node is eligible (no role filter)
  return true;
}

/**
 * Checks if a local node role is valid for auto-favorite feature.
 */
export function isAutoFavoriteValidRole(role: number | undefined | null): boolean {
  return role != null && AUTO_FAVORITE_LOCAL_ROLES.has(role);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/meshtasticManager.autoFavorite.test.ts`
Expected: All 11 tests PASS

**Step 5: Commit**

```bash
git add src/server/constants/autoFavorite.ts src/server/meshtasticManager.autoFavorite.test.ts
git commit -m "feat(auto-favorite): add eligibility logic with tests"
```

---

### Task 2: Backend — `checkAutoFavorite()` method in MeshtasticManager

**Files:**
- Modify: `src/server/meshtasticManager.ts`

**Step 1: Add the `autoFavoritingNodes` Set property**

Find the existing `welcomingNodes` property declaration in the class and add `autoFavoritingNodes` nearby. Search for `welcomingNodes` in the class properties area.

```typescript
private autoFavoritingNodes = new Set<number>();
```

**Step 2: Add the `checkAutoFavorite` method**

Add this method near `checkAutoWelcome` (after line ~8920):

```typescript
private async checkAutoFavorite(nodeNum: number, nodeId: string): Promise<void> {
  try {
    const autoFavoriteEnabled = databaseService.getSetting('autoFavoriteEnabled');
    if (autoFavoriteEnabled !== 'true') {
      return;
    }

    if (!this.supportsFavorites()) {
      return;
    }

    // Skip local node
    const localNodeNum = databaseService.getSetting('localNodeNum');
    if (localNodeNum && parseInt(localNodeNum) === nodeNum) {
      return;
    }

    // Prevent duplicate concurrent operations
    if (this.autoFavoritingNodes.has(nodeNum)) {
      return;
    }

    // Get local node role
    const localNodeNumInt = localNodeNum ? parseInt(localNodeNum) : this.localNodeInfo?.nodeNum;
    if (!localNodeNumInt) return;
    const localNode = databaseService.getNode(localNodeNumInt);
    if (!localNode) return;

    const targetNode = databaseService.getNode(nodeNum);
    if (!targetNode) return;

    // Check if already in auto-favorite list (prevent re-adding manually unfavorited nodes)
    const autoFavoriteNodesJson = databaseService.getSetting('autoFavoriteNodes') || '[]';
    const autoFavoriteNodes: number[] = JSON.parse(autoFavoriteNodesJson);
    if (autoFavoriteNodes.includes(nodeNum)) {
      return; // Already auto-managed
    }

    // Check eligibility
    const { isAutoFavoriteEligible } = await import('../server/constants/autoFavorite.js');
    if (!isAutoFavoriteEligible(localNode.role, targetNode)) {
      return;
    }

    this.autoFavoritingNodes.add(nodeNum);
    try {
      // Mark in DB
      databaseService.setNodeFavorite(nodeNum, true);

      // Sync to device
      try {
        await this.sendFavoriteNode(nodeNum);
        logger.info(`⭐ Auto-favorited node ${nodeId} (${targetNode.longName || 'Unknown'}) - 0-hop, role=${targetNode.role}`);
      } catch (error) {
        logger.warn(`⚠️ Auto-favorited node ${nodeId} in DB but device sync failed:`, error);
      }

      // Add to auto-favorite tracking list
      autoFavoriteNodes.push(nodeNum);
      databaseService.setSetting('autoFavoriteNodes', JSON.stringify(autoFavoriteNodes));
    } finally {
      this.autoFavoritingNodes.delete(nodeNum);
    }
  } catch (error) {
    logger.error('❌ Error in auto-favorite check:', error);
  }
}
```

**Step 3: Wire the call site**

At `src/server/meshtasticManager.ts:4057`, after the `checkAutoWelcome` call, add:

```typescript
await this.checkAutoFavorite(fromNum, nodeId);
```

**Step 4: Fix the import path**

The import inside `checkAutoFavorite` uses a dynamic import. Since the file is in `src/server/constants/autoFavorite.ts` and `meshtasticManager.ts` is in `src/server/`, the relative import path should be `./constants/autoFavorite.js`. Alternatively, add a static import at the top of the file:

```typescript
import { isAutoFavoriteEligible } from './constants/autoFavorite.js';
```

Then replace the dynamic import in the method with a direct call: `if (!isAutoFavoriteEligible(localNode.role, targetNode))`.

**Step 5: Commit**

```bash
git add src/server/meshtasticManager.ts
git commit -m "feat(auto-favorite): add checkAutoFavorite method and wire to NodeInfo processing"
```

---

### Task 3: Backend — Periodic Sweep for Staleness Cleanup

**Files:**
- Modify: `src/server/meshtasticManager.ts`

**Step 1: Add the `autoFavoriteSweep` method**

Add near `checkAutoFavorite`:

```typescript
private async autoFavoriteSweep(): Promise<void> {
  try {
    const autoFavoriteEnabled = databaseService.getSetting('autoFavoriteEnabled');
    const autoFavoriteNodesJson = databaseService.getSetting('autoFavoriteNodes') || '[]';
    const autoFavoriteNodes: number[] = JSON.parse(autoFavoriteNodesJson);

    if (autoFavoriteNodes.length === 0) {
      return;
    }

    // If feature was disabled, clean up all auto-favorited nodes
    if (autoFavoriteEnabled !== 'true') {
      logger.info(`🧹 Auto-favorite disabled, cleaning up ${autoFavoriteNodes.length} auto-favorited nodes`);
      for (const nodeNum of autoFavoriteNodes) {
        try {
          databaseService.setNodeFavorite(nodeNum, false);
          if (this.supportsFavorites() && this.isConnected) {
            await this.sendRemoveFavoriteNode(nodeNum);
          }
        } catch (error) {
          logger.warn(`⚠️ Failed to unfavorite node ${nodeNum} during cleanup:`, error);
        }
      }
      databaseService.setSetting('autoFavoriteNodes', '[]');
      return;
    }

    if (!this.supportsFavorites()) return;

    const staleHours = parseInt(databaseService.getSetting('autoFavoriteStaleHours') || '72');
    const staleThreshold = Date.now() / 1000 - (staleHours * 3600);

    // Get local node role for re-evaluation
    const localNodeNum = databaseService.getSetting('localNodeNum');
    const localNodeNumInt = localNodeNum ? parseInt(localNodeNum) : this.localNodeInfo?.nodeNum;
    const localNode = localNodeNumInt ? databaseService.getNode(localNodeNumInt) : null;

    const nodesToRemove: number[] = [];

    for (const nodeNum of autoFavoriteNodes) {
      const node = databaseService.getNode(nodeNum);
      if (!node) {
        nodesToRemove.push(nodeNum);
        continue;
      }

      let shouldRemove = false;
      let reason = '';

      // Check staleness
      if (node.lastHeard && node.lastHeard < staleThreshold) {
        shouldRemove = true;
        reason = `stale (not heard in ${staleHours}+ hours)`;
      }

      // Check hops changed
      if (!shouldRemove && (node.hopsAway == null || node.hopsAway > 0)) {
        shouldRemove = true;
        reason = `no longer 0-hop (hopsAway=${node.hopsAway})`;
      }

      // Check role eligibility changed (for ROUTER/ROUTER_LATE local)
      if (!shouldRemove && localNode) {
        const { isAutoFavoriteEligible } = await import('./constants/autoFavorite.js');
        // Temporarily mark as not-favorite for the check
        if (!isAutoFavoriteEligible(localNode.role, { ...node, isFavorite: false })) {
          shouldRemove = true;
          reason = 'no longer eligible (role changed)';
        }
      }

      if (shouldRemove) {
        nodesToRemove.push(nodeNum);
        try {
          databaseService.setNodeFavorite(nodeNum, false);
          if (this.isConnected) {
            await this.sendRemoveFavoriteNode(nodeNum);
          }
          const nodeId = node.nodeId || `!${nodeNum.toString(16).padStart(8, '0')}`;
          logger.info(`☆ Auto-unfavorited node ${nodeId} (${node.longName || 'Unknown'}) - ${reason}`);
        } catch (error) {
          logger.warn(`⚠️ Failed to auto-unfavorite node ${nodeNum}:`, error);
        }
      }
    }

    // Update the tracking list
    if (nodesToRemove.length > 0) {
      const removeSet = new Set(nodesToRemove);
      const remaining = autoFavoriteNodes.filter(n => !removeSet.has(n));
      databaseService.setSetting('autoFavoriteNodes', JSON.stringify(remaining));
      logger.info(`🧹 Auto-favorite sweep: removed ${nodesToRemove.length}, remaining ${remaining.length}`);
    }
  } catch (error) {
    logger.error('❌ Error in auto-favorite sweep:', error);
  }
}
```

**Step 2: Schedule the sweep on startup**

Find where other automation timers are scheduled (search for `setInterval` near `autoAnnounce` or `cron.schedule` calls in the initialization area). Add:

```typescript
// Auto-favorite staleness sweep - runs every 60 minutes
setInterval(() => {
  this.autoFavoriteSweep().catch(error => {
    logger.error('❌ Error in auto-favorite sweep interval:', error);
  });
}, 60 * 60 * 1000);
```

Also run an initial sweep shortly after startup (30 seconds delay) to handle the case where the feature was disabled while the server was down:

```typescript
setTimeout(() => {
  this.autoFavoriteSweep().catch(error => {
    logger.error('❌ Error in initial auto-favorite sweep:', error);
  });
}, 30000);
```

**Step 3: Use static import instead of dynamic**

The `autoFavoriteSweep` method also uses `isAutoFavoriteEligible`. Since we already added the static import in Task 2, replace the dynamic import line with the direct call.

**Step 4: Commit**

```bash
git add src/server/meshtasticManager.ts
git commit -m "feat(auto-favorite): add periodic staleness sweep with auto-unfavorite"
```

---

### Task 4: Backend — Hook Manual Unfavorite into Auto-Favorite List

**Files:**
- Modify: `src/server/server.ts:916` (the `POST /api/nodes/:nodeId/favorite` route)

**Step 1: Add cleanup logic to the favorite endpoint**

At `src/server/server.ts:948`, after `databaseService.setNodeFavorite(nodeNum, isFavorite)`, add logic to remove the node from the `autoFavoriteNodes` list when manually unfavorited:

```typescript
// If manually unfavoriting, remove from auto-favorite tracking list
if (!isFavorite) {
  const autoFavoriteNodesJson = databaseService.getSetting('autoFavoriteNodes') || '[]';
  const autoFavoriteNodes: number[] = JSON.parse(autoFavoriteNodesJson);
  if (autoFavoriteNodes.includes(nodeNum)) {
    const updated = autoFavoriteNodes.filter(n => n !== nodeNum);
    databaseService.setSetting('autoFavoriteNodes', JSON.stringify(updated));
  }
}
```

**Step 2: Commit**

```bash
git add src/server/server.ts
git commit -m "feat(auto-favorite): remove from tracking list on manual unfavorite"
```

---

### Task 5: Backend — API Endpoint for Auto-Favorite Status

**Files:**
- Modify: `src/server/server.ts`

The frontend needs to know:
1. The auto-favorite settings (enabled, staleHours)
2. Which nodes are auto-favorited (the tracking list)
3. The local node's role and firmware version (for status banner)

Settings 1 & 2 are already accessible via `GET /api/settings`. For #3, we need the local node's role + firmware info. The existing `/api/status` endpoint doesn't include these.

**Step 1: Add a lightweight endpoint**

Add near the existing favorite route (after line ~990 in server.ts):

```typescript
apiRouter.get('/auto-favorite/status', requirePermission('nodes', 'read'), (_req, res) => {
  try {
    const localNodeNum = databaseService.getSetting('localNodeNum');
    const localNodeNumInt = localNodeNum ? parseInt(localNodeNum) : meshtasticManager.getLocalNodeInfo()?.nodeNum;
    const localNode = localNodeNumInt ? databaseService.getNode(localNodeNumInt) : null;
    const firmwareVersion = meshtasticManager.getLocalNodeInfo()?.firmwareVersion || null;
    const supportsFavorites = meshtasticManager.supportsFavorites();

    const autoFavoriteNodesJson = databaseService.getSetting('autoFavoriteNodes') || '[]';
    const autoFavoriteNodeNums: number[] = JSON.parse(autoFavoriteNodesJson);

    // Get node details for each auto-favorited node
    const autoFavoriteNodes = autoFavoriteNodeNums
      .map(nodeNum => {
        const node = databaseService.getNode(nodeNum);
        if (!node) return null;
        return {
          nodeNum: node.nodeNum,
          nodeId: node.nodeId,
          longName: node.longName,
          shortName: node.shortName,
          role: node.role,
          hopsAway: node.hopsAway,
          lastHeard: node.lastHeard,
        };
      })
      .filter(Boolean);

    res.json({
      localNodeRole: localNode?.role ?? null,
      firmwareVersion,
      supportsFavorites,
      autoFavoriteNodes,
    });
  } catch (error) {
    logger.error('Error fetching auto-favorite status:', error);
    res.status(500).json({ error: 'Failed to fetch auto-favorite status' });
  }
});
```

**Step 2: Commit**

```bash
git add src/server/server.ts
git commit -m "feat(auto-favorite): add GET /api/auto-favorite/status endpoint"
```

---

### Task 6: Frontend — `AutoFavoriteSection.tsx` Component

**Files:**
- Create: `src/components/AutoFavoriteSection.tsx`

**Step 1: Create the component**

```typescript
import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSaveBar } from '../hooks/useSaveBar';
import { useToast } from './ToastContainer';
import { ROLE_NAMES, DeviceRole } from '../constants';

interface AutoFavoriteSectionProps {
  baseUrl: string;
}

interface AutoFavoriteStatus {
  localNodeRole: number | null;
  firmwareVersion: string | null;
  supportsFavorites: boolean;
  autoFavoriteNodes: Array<{
    nodeNum: number;
    nodeId: string;
    longName: string | null;
    shortName: string | null;
    role: number | null;
    hopsAway: number | null;
    lastHeard: number | null;
  }>;
}

const ELIGIBLE_LOCAL_ROLES = new Set([DeviceRole.ROUTER, DeviceRole.ROUTER_LATE, DeviceRole.CLIENT_BASE]);

const AutoFavoriteSection: React.FC<AutoFavoriteSectionProps> = ({ baseUrl }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const [localEnabled, setLocalEnabled] = useState(false);
  const [localStaleHours, setLocalStaleHours] = useState(72);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [initialSettings, setInitialSettings] = useState<{ enabled: boolean; staleHours: number } | null>(null);
  const [status, setStatus] = useState<AutoFavoriteStatus | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [settingsRes, statusRes] = await Promise.all([
        csrfFetch(`${baseUrl}/api/settings`),
        csrfFetch(`${baseUrl}/api/auto-favorite/status`),
      ]);
      if (settingsRes.ok) {
        const settings = await settingsRes.json();
        const enabled = settings.autoFavoriteEnabled === 'true';
        const staleHours = parseInt(settings.autoFavoriteStaleHours || '72');
        setLocalEnabled(enabled);
        setLocalStaleHours(staleHours);
        setInitialSettings({ enabled, staleHours });
      }
      if (statusRes.ok) {
        setStatus(await statusRes.json());
      }
    } catch (error) {
      console.error('Failed to fetch auto-favorite data:', error);
    }
  }, [baseUrl, csrfFetch]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    if (!initialSettings) return;
    setHasChanges(
      localEnabled !== initialSettings.enabled ||
      localStaleHours !== initialSettings.staleHours
    );
  }, [localEnabled, localStaleHours, initialSettings]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoFavoriteEnabled: localEnabled ? 'true' : 'false',
          autoFavoriteStaleHours: String(localStaleHours),
        }),
      });
      if (response.ok) {
        setInitialSettings({ enabled: localEnabled, staleHours: localStaleHours });
        setHasChanges(false);
        showToast(t('automation.auto_favorite.saved', 'Auto Favorite settings saved'), 'success');
        fetchData(); // Refresh status
      } else {
        showToast(t('automation.auto_favorite.save_error', 'Failed to save settings'), 'error');
      }
    } catch (error) {
      showToast(t('automation.auto_favorite.save_error', 'Failed to save settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [baseUrl, csrfFetch, localEnabled, localStaleHours, showToast, t, fetchData]);

  const resetChanges = useCallback(() => {
    if (initialSettings) {
      setLocalEnabled(initialSettings.enabled);
      setLocalStaleHours(initialSettings.staleHours);
    }
  }, [initialSettings]);

  useSaveBar({
    id: 'auto-favorite',
    sectionName: t('automation.auto_favorite.title', 'Auto Favorite'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges,
  });

  const roleValid = status?.localNodeRole != null && ELIGIBLE_LOCAL_ROLES.has(status.localNodeRole);
  const firmwareValid = status?.supportsFavorites ?? false;

  const getTargetDescription = () => {
    if (!status?.localNodeRole) return '';
    if (status.localNodeRole === DeviceRole.CLIENT_BASE) {
      return t('automation.auto_favorite.target_all', 'all 0-hop nodes');
    }
    return t('automation.auto_favorite.target_routers', '0-hop Router, Router Late, and Client Base nodes');
  };

  return (
    <div className="settings-section">
      <h3>{t('automation.auto_favorite.title', 'Auto Favorite')}</h3>

      <p className="settings-description">
        {t('automation.auto_favorite.description',
          'Automatically favorite eligible nodes for zero-cost hop routing.')}{' '}
        <a
          href="https://meshtastic.org/blog/zero-cost-hops-favorite-routers/"
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('automation.auto_favorite.read_more', 'Read more')}
        </a>
      </p>

      {/* Status/Warning Banners */}
      {status && (
        <>
          {!firmwareValid && (
            <div className="alert alert-warning">
              {t('automation.auto_favorite.firmware_warning',
                'Firmware {{version}} does not support favorites (requires >= 2.7.0)',
                { version: status.firmwareVersion || 'unknown' })}
            </div>
          )}
          {firmwareValid && !roleValid && (
            <div className="alert alert-warning">
              {t('automation.auto_favorite.role_warning',
                'Your node role is "{{role}}" \u2014 Auto Favorite requires Router, Router Late, or Client Base.',
                { role: ROLE_NAMES[status.localNodeRole ?? 0] || 'Unknown' })}
            </div>
          )}
          {firmwareValid && roleValid && (
            <div className="alert alert-success">
              {t('automation.auto_favorite.valid_config',
                'Valid configuration: {{role}} on firmware {{version}}. Will auto-favorite: {{targets}}.',
                {
                  role: ROLE_NAMES[status.localNodeRole!] || 'Unknown',
                  version: status.firmwareVersion || 'unknown',
                  targets: getTargetDescription(),
                })}
            </div>
          )}
        </>
      )}

      {/* Enable Checkbox */}
      <div className="settings-row">
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={localEnabled}
            onChange={(e) => setLocalEnabled(e.target.checked)}
          />
          {t('automation.auto_favorite.enable', 'Enable Auto Favorite')}
        </label>
      </div>

      {/* Staleness Threshold */}
      {localEnabled && (
        <div className="settings-row">
          <label>
            {t('automation.auto_favorite.stale_hours_label', 'Staleness threshold (hours)')}
            <input
              type="number"
              min={1}
              max={720}
              value={localStaleHours}
              onChange={(e) => setLocalStaleHours(parseInt(e.target.value) || 72)}
              style={{ width: '80px', marginLeft: '8px' }}
            />
          </label>
          <p className="settings-hint">
            {t('automation.auto_favorite.stale_hours_hint',
              'Nodes not heard from within this period are automatically unfavorited.')}
          </p>
        </div>
      )}

      {/* Auto-Favorited Nodes List */}
      {localEnabled && status && status.autoFavoriteNodes.length > 0 && (
        <div className="settings-row">
          <h4>{t('automation.auto_favorite.managed_nodes', 'Auto-Favorited Nodes')}</h4>
          <table className="simple-table">
            <thead>
              <tr>
                <th>{t('common.node', 'Node')}</th>
                <th>{t('common.role', 'Role')}</th>
                <th>{t('common.hops', 'Hops')}</th>
              </tr>
            </thead>
            <tbody>
              {status.autoFavoriteNodes.map((node) => (
                <tr key={node.nodeNum}>
                  <td>{node.longName || node.shortName || node.nodeId}</td>
                  <td>{ROLE_NAMES[node.role ?? 0] || 'Unknown'}</td>
                  <td>{node.hopsAway ?? '?'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {localEnabled && status && status.autoFavoriteNodes.length === 0 && (
        <p className="settings-hint">
          {t('automation.auto_favorite.no_nodes', 'No nodes auto-favorited yet.')}
        </p>
      )}
    </div>
  );
};

export default AutoFavoriteSection;
```

**Step 2: Commit**

```bash
git add src/components/AutoFavoriteSection.tsx
git commit -m "feat(auto-favorite): add AutoFavoriteSection frontend component"
```

---

### Task 7: Frontend — Wire into App.tsx Automation Tab

**Files:**
- Modify: `src/App.tsx`

**Step 1: Add import**

Near line 33 (after the other Auto*Section imports), add:

```typescript
import AutoFavoriteSection from './components/AutoFavoriteSection';
```

**Step 2: Add nav entry**

At `src/App.tsx:4493`, in the automation nav entries array, add after the `auto-welcome` entry:

```typescript
{ id: 'auto-favorite', label: t('automation.auto_favorite.title', 'Auto Favorite') },
```

**Step 3: Add section rendering**

At `src/App.tsx:4523` (after the `</div>` closing the auto-welcome section), add:

```tsx
<div id="auto-favorite">
  <AutoFavoriteSection baseUrl={baseUrl} />
</div>
```

**Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat(auto-favorite): wire AutoFavoriteSection into Automation tab"
```

---

### Task 8: Frontend Component Test

**Files:**
- Create: `src/components/AutoFavoriteSection.test.tsx`

**Step 1: Write the component test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AutoFavoriteSection from './AutoFavoriteSection';

// Mock hooks
vi.mock('../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
}));

vi.mock('../hooks/useSaveBar', () => ({
  useSaveBar: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback: string) => fallback,
  }),
}));

vi.mock('./ToastContainer', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

describe('AutoFavoriteSection', () => {
  it('renders the title and description', () => {
    render(<AutoFavoriteSection baseUrl="" />);
    expect(screen.getByText('Auto Favorite')).toBeDefined();
    expect(screen.getByText(/Automatically favorite eligible nodes/)).toBeDefined();
  });

  it('renders the Read more link to meshtastic blog', () => {
    render(<AutoFavoriteSection baseUrl="" />);
    const link = screen.getByText('Read more');
    expect(link.getAttribute('href')).toBe('https://meshtastic.org/blog/zero-cost-hops-favorite-routers/');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('renders the enable checkbox', () => {
    render(<AutoFavoriteSection baseUrl="" />);
    expect(screen.getByText('Enable Auto Favorite')).toBeDefined();
  });
});
```

**Step 2: Run tests**

Run: `npx vitest run src/components/AutoFavoriteSection.test.tsx`
Expected: PASS

**Step 3: Commit**

```bash
git add src/components/AutoFavoriteSection.test.tsx
git commit -m "test(auto-favorite): add AutoFavoriteSection component tests"
```

---

### Task 9: Integration Verification

**Step 1: Build check**

Run: `npx tsc --noEmit`
Expected: No TypeScript errors

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass, including new auto-favorite tests

**Step 3: Fix any issues found**

Address any TypeScript errors, import path issues, or test failures.

**Step 4: Final commit if fixes were needed**

```bash
git add -A
git commit -m "fix(auto-favorite): address build/test issues from integration"
```

---

## Task Dependency Graph

```
Task 1 (eligibility logic + tests)
  └─► Task 2 (checkAutoFavorite method)
       └─► Task 3 (periodic sweep)
       └─► Task 4 (manual unfavorite hook)
       └─► Task 5 (status API endpoint)
            └─► Task 6 (frontend component)
                 └─► Task 7 (App.tsx wiring)
                 └─► Task 8 (frontend tests)
                      └─► Task 9 (integration verification)
```

Tasks 3, 4, 5 can be done in parallel after Task 2. Tasks 7 and 8 can be done in parallel after Task 6.
