# Decouple Node List from Map Permissions - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make nodes always visible in the node list regardless of viewOnMap permission, while stripping sensitive fields based on per-channel permission tiers.

**Architecture:** Add a new `applyChannelPermissionsToNodes()` function in `nodeEnhancer.ts` that returns all nodes but strips fields based on permission level (`none`, `read`, `viewOnMap`). Replace the `filterNodesByChannelPermission()` call in `/api/poll` with this new function. Keep `filterNodesByChannelPermission()` intact for other endpoints that need strict filtering. Add a `permissionLevel` field to the enhanced node response so the frontend can conditionally render indicators.

**Tech Stack:** TypeScript, Vitest, React

---

### Task 1: Add `applyChannelPermissionsToNodes()` to nodeEnhancer.ts

**Files:**
- Modify: `src/server/utils/nodeEnhancer.ts` (after line 116)
- Test: `src/server/utils/nodeEnhancer.test.ts`

**Step 1: Write failing tests**

Add tests to `src/server/utils/nodeEnhancer.test.ts` after the existing `filterNodesByChannelPermission` tests:

```typescript
describe('nodeEnhancer: applyChannelPermissionsToNodes', () => {
  const testNodes = [
    { nodeNum: 1, user: { id: '!aabb', longName: 'Node1', shortName: 'N1', role: 1 }, channel: 0, position: { latitude: 1, longitude: 2, altitude: 100 }, deviceMetrics: { batteryLevel: 85 }, viaMqtt: false, hasRemoteAdmin: true, mobile: 0, hopsAway: 1, snr: 5.5, rssi: -80, lastHeard: 1000 },
    { nodeNum: 2, user: { id: '!ccdd', longName: 'Node2', shortName: 'N2', role: 0 }, channel: 1, position: { latitude: 3, longitude: 4, altitude: 200 }, deviceMetrics: { batteryLevel: 50 }, viaMqtt: true, hasRemoteAdmin: false, mobile: 1, hopsAway: 2, snr: 3.0, rssi: -90, lastHeard: 2000 },
  ];

  it('should return all nodes for admin with permissionLevel viewOnMap', async () => {
    const result = await applyChannelPermissionsToNodes(testNodes, adminUser);
    expect(result).toHaveLength(2);
    expect(result[0].permissionLevel).toBe('viewOnMap');
    expect(result[0].user?.longName).toBe('Node1');
    expect(result[0].position?.latitude).toBe(1);
  });

  it('should strip position data for read-only permission', async () => {
    // User has read but not viewOnMap on channel_0
    const readOnlyUser = { id: 10, username: 'reader', isAdmin: false } as User;
    mockGetUserPermissionSetAsync.mockResolvedValue({
      channel_0: { viewOnMap: false, read: true, write: false },
      channel_1: { viewOnMap: false, read: false, write: false },
    });
    mockGetChannelDbPerms.mockResolvedValue({});
    const result = await applyChannelPermissionsToNodes(testNodes, readOnlyUser);
    expect(result).toHaveLength(2);
    // channel_0 node: read permission
    expect(result[0].permissionLevel).toBe('read');
    expect(result[0].user?.longName).toBe('Node1');
    expect(result[0].position).toBeUndefined();
    expect(result[0].deviceMetrics?.batteryLevel).toBe(85);
    // channel_1 node: no permission
    expect(result[1].permissionLevel).toBe('none');
    expect(result[1].user).toBeUndefined();
    expect(result[1].position).toBeUndefined();
    expect(result[1].deviceMetrics).toBeUndefined();
  });

  it('should strip user info and telemetry for no permission', async () => {
    const noPermUser = { id: 11, username: 'noperm', isAdmin: false } as User;
    mockGetUserPermissionSetAsync.mockResolvedValue({
      channel_0: { viewOnMap: false, read: false, write: false },
    });
    mockGetChannelDbPerms.mockResolvedValue({});
    const result = await applyChannelPermissionsToNodes(testNodes, noPermUser);
    expect(result).toHaveLength(2);
    expect(result[0].permissionLevel).toBe('none');
    expect(result[0].user).toBeUndefined();
    expect(result[0].position).toBeUndefined();
    expect(result[0].deviceMetrics).toBeUndefined();
    expect(result[0].viaMqtt).toBeUndefined();
    expect(result[0].hasRemoteAdmin).toBeUndefined();
    expect(result[0].mobile).toBeUndefined();
    // Basic fields still present
    expect(result[0].nodeNum).toBe(1);
    expect(result[0].hopsAway).toBe(1);
    expect(result[0].snr).toBe(5.5);
    expect(result[0].lastHeard).toBe(1000);
  });

  it('should return all nodes for null user with permissionLevel none', async () => {
    const result = await applyChannelPermissionsToNodes(testNodes, null);
    expect(result).toHaveLength(2);
    expect(result[0].permissionLevel).toBe('none');
    expect(result[0].user).toBeUndefined();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/utils/nodeEnhancer.test.ts`
Expected: FAIL — `applyChannelPermissionsToNodes` is not exported

**Step 3: Implement `applyChannelPermissionsToNodes()`**

Add to `src/server/utils/nodeEnhancer.ts` after the `filterNodesByChannelPermission` function (after line 116):

```typescript
export type NodePermissionLevel = 'none' | 'read' | 'viewOnMap';

/**
 * Apply channel-based permissions to nodes by stripping fields based on permission level.
 * Unlike filterNodesByChannelPermission, this returns ALL nodes — it strips sensitive
 * fields instead of removing nodes entirely.
 *
 * Permission tiers:
 * - 'viewOnMap': Full data (position, telemetry, user info, indicators)
 * - 'read': User info & telemetry, but NO position/altitude/mobile status
 * - 'none': Only basic header fields (nodeNum, hopsAway, SNR, RSSI, lastHeard, channel)
 */
export async function applyChannelPermissionsToNodes<T extends Record<string, any>>(
  nodes: T[],
  user: User | null | undefined
): Promise<(T & { permissionLevel: NodePermissionLevel })[]> {
  // Admins get full access
  if (user?.isAdmin) {
    return nodes.map(node => ({ ...node, permissionLevel: 'viewOnMap' as const }));
  }

  // Get permissions
  const permissions: PermissionSet = user
    ? await databaseService.getUserPermissionSetAsync(user.id)
    : {};
  const channelDbPermissions = user
    ? await databaseService.getChannelDatabasePermissionsForUserAsSetAsync(user.id)
    : {};

  return nodes.map(node => {
    const channelNum = (node as { channel?: number }).channel ?? 0;

    // Determine permission level
    let hasViewOnMap = false;
    let hasRead = false;

    if (channelNum < CHANNEL_DB_OFFSET) {
      const channelResource = `channel_${channelNum}` as ResourceType;
      const perm = permissions[channelResource];
      hasViewOnMap = perm?.viewOnMap === true;
      hasRead = perm?.read === true;
    } else {
      const channelDbId = channelNum - CHANNEL_DB_OFFSET;
      const perm = channelDbPermissions[channelDbId];
      hasViewOnMap = perm?.viewOnMap === true;
      hasRead = perm?.read === true;
    }

    const permissionLevel: NodePermissionLevel = hasViewOnMap ? 'viewOnMap' : hasRead ? 'read' : 'none';

    if (permissionLevel === 'viewOnMap') {
      return { ...node, permissionLevel };
    }

    // Clone to avoid mutating original
    const stripped = { ...node, permissionLevel };

    if (permissionLevel === 'none') {
      // Strip user info, telemetry, position, indicators
      delete stripped.user;
      delete stripped.position;
      delete stripped.deviceMetrics;
      delete stripped.viaMqtt;
      delete stripped.hasRemoteAdmin;
      delete stripped.mobile;
      // Also strip position override fields
      delete stripped.latitudeOverride;
      delete stripped.longitudeOverride;
      delete stripped.altitudeOverride;
      delete stripped.positionOverrideEnabled;
      delete stripped.positionOverrideIsPrivate;
    } else {
      // 'read' — strip position-related fields only
      delete stripped.position;
      delete stripped.mobile;
      delete stripped.latitudeOverride;
      delete stripped.longitudeOverride;
      delete stripped.altitudeOverride;
      delete stripped.positionOverrideEnabled;
      delete stripped.positionOverrideIsPrivate;
    }

    return stripped;
  });
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/utils/nodeEnhancer.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/utils/nodeEnhancer.ts src/server/utils/nodeEnhancer.test.ts
git commit -m "feat: add applyChannelPermissionsToNodes for tiered field stripping"
```

---

### Task 2: Update `/api/poll` to use `applyChannelPermissionsToNodes()`

**Files:**
- Modify: `src/server/server.ts:3751` and `src/server/server.ts:3773-3775`

**Step 1: Update the import**

In `src/server/server.ts` line 41, add `applyChannelPermissionsToNodes` to the import:

```typescript
import { enhanceNodeForClient, filterNodesByChannelPermission, checkNodeChannelAccess, applyChannelPermissionsToNodes } from './utils/nodeEnhancer.js';
```

**Step 2: Replace the filtering call in `/api/poll`**

At line 3751, change:
```typescript
const filteredMemoryNodes = await filterNodesByChannelPermission(allMemoryNodes, user);
```
to:
```typescript
const permissionedNodes = await applyChannelPermissionsToNodes(allMemoryNodes, user);
```

**Step 3: Update the node enhancement section**

At lines 3773-3775, change:
```typescript
result.nodes = await Promise.all(filteredMemoryNodes.map(node => enhanceNodeForClient(node, user, estimatedPositions, canViewPrivate)));
```
to:
```typescript
result.nodes = await Promise.all(permissionedNodes.map(async node => {
  // Only enhance with position logic if user has viewOnMap permission
  if (node.permissionLevel === 'viewOnMap') {
    const enhanced = await enhanceNodeForClient(node, user, estimatedPositions, canViewPrivate);
    return { ...enhanced, permissionLevel: node.permissionLevel };
  }
  // For read/none, return as-is (position already stripped)
  return { ...node, isMobile: false, positionIsOverride: false };
}));
```

**Step 4: Run existing tests**

Run: `npx vitest run src/server/server.poll.test.ts`
Expected: Tests should still pass (poll tests use admin user which gets full access)

**Step 5: Commit**

```bash
git add src/server/server.ts
git commit -m "feat: use applyChannelPermissionsToNodes in /api/poll endpoint"
```

---

### Task 3: Update NodesTab to use `permissionLevel` for conditional rendering

**Files:**
- Modify: `src/components/NodesTab.tsx`

**Step 1: Update node name display (line ~1250)**

Change:
```tsx
{node.user?.longName || `Node ${node.nodeNum}`}
```
to:
```tsx
{node.user?.longName || (node.permissionLevel === 'none' ? `!${node.nodeNum.toString(16)}` : `Node ${node.nodeNum}`)}
```

**Step 2: Conditionally render indicators based on permissionLevel (lines ~1258-1275)**

Wrap the telemetry/capability indicators with a permission check. Replace the indicators block:

```tsx
{node.position && node.position.latitude != null && node.position.longitude != null && (
  <span className="node-indicator-icon" title={t('nodes.location')}>📍</span>
)}
{node.viaMqtt && (
  <span className="node-indicator-icon" title={t('nodes.via_mqtt')}>🌐</span>
)}
{node.user?.id && nodesWithTelemetry.has(node.user.id) && (
  <span className="node-indicator-icon" title={t('nodes.has_telemetry')}>📊</span>
)}
{node.user?.id && nodesWithWeatherTelemetry.has(node.user.id) && (
  <span className="node-indicator-icon" title={t('nodes.has_weather')}>☀️</span>
)}
{node.user?.id && nodesWithPKC.has(node.user.id) && (
  <span className="node-indicator-icon" title={t('nodes.has_pkc')}>🔐</span>
)}
{node.hasRemoteAdmin && (
  <span className="node-indicator-icon" title={t('nodes.has_remote_admin')}>🛠️</span>
)}
```

with:

```tsx
{node.position && node.position.latitude != null && node.position.longitude != null && (
  <span className="node-indicator-icon" title={t('nodes.location')}>📍</span>
)}
{node.permissionLevel !== 'none' && node.viaMqtt && (
  <span className="node-indicator-icon" title={t('nodes.via_mqtt')}>🌐</span>
)}
{node.permissionLevel !== 'none' && node.user?.id && nodesWithTelemetry.has(node.user.id) && (
  <span className="node-indicator-icon" title={t('nodes.has_telemetry')}>📊</span>
)}
{node.permissionLevel !== 'none' && node.user?.id && nodesWithWeatherTelemetry.has(node.user.id) && (
  <span className="node-indicator-icon" title={t('nodes.has_weather')}>☀️</span>
)}
{node.permissionLevel !== 'none' && node.user?.id && nodesWithPKC.has(node.user.id) && (
  <span className="node-indicator-icon" title={t('nodes.has_pkc')}>🔐</span>
)}
{node.permissionLevel !== 'none' && node.hasRemoteAdmin && (
  <span className="node-indicator-icon" title={t('nodes.has_remote_admin')}>🛠️</span>
)}
```

Note: The 📍 indicator doesn't need a permission guard because the position field itself is already stripped on the backend — it will naturally not render.

**Step 3: Conditionally render battery in stats (line ~1317)**

Change:
```tsx
{node.deviceMetrics?.batteryLevel !== undefined && node.deviceMetrics.batteryLevel !== null && (
```
to:
```tsx
{node.permissionLevel !== 'none' && node.deviceMetrics?.batteryLevel !== undefined && node.deviceMetrics.batteryLevel !== null && (
```

**Step 4: Conditionally render role (line ~1252)**

Change:
```tsx
{node.user?.role !== undefined && node.user?.role !== null && getRoleName(node.user.role) && (
```
to:
```tsx
{node.permissionLevel !== 'none' && node.user?.role !== undefined && node.user?.role !== null && getRoleName(node.user.role) && (
```

**Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors. The `permissionLevel` field comes from the API response; TypeScript may need a type update (see Task 4).

**Step 6: Commit**

```bash
git add src/components/NodesTab.tsx
git commit -m "feat: conditionally render node fields based on permissionLevel"
```

---

### Task 4: Add `permissionLevel` to the DeviceInfo type

**Files:**
- Modify: `src/server/meshtasticManager.ts` (DeviceInfo interface) or the type used by frontend

**Step 1: Find the DeviceInfo type definition**

Run: `grep -n "interface DeviceInfo" src/server/meshtasticManager.ts`

**Step 2: Add `permissionLevel` as an optional field**

Add to the DeviceInfo interface:
```typescript
permissionLevel?: 'none' | 'read' | 'viewOnMap';
```

**Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/server/meshtasticManager.ts
git commit -m "feat: add permissionLevel to DeviceInfo type"
```

---

### Task 5: Verify map markers still respect permissions

**Files:**
- Review: `src/components/NodesTab.tsx` (map marker rendering, line ~1587)

**Step 1: Verify map markers use `nodesWithPosition`**

The map markers are rendered from `nodesWithPosition` (line 859):
```typescript
const nodesWithPosition = processedNodes.filter(node => hasValidEffectivePosition(node));
```

Since nodes without `viewOnMap` have their `position` field stripped by the backend, they will be filtered out by `hasValidEffectivePosition()` and won't appear on the map. **No frontend changes needed for map markers.**

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 3: Final commit**

If any adjustments were needed, commit them.

---

### Task 6: System test and PR

**Step 1: Run system tests**

Run: `tests/system-tests.sh`
Expected: All tests pass

**Step 2: Commit any remaining changes and create PR**

Branch: `feature/decouple-nodelist-map-permissions`
PR title: `feat: decouple node list visibility from map permissions`
Reference: Design doc at `docs/plans/2026-03-06-decouple-nodelist-from-map-permissions-design.md`
