# Auto-Traceroute Node Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Last Heard Within" and "Hop Range" filters to auto-traceroute node selection.

**Architecture:** Five new settings keys stored via the existing settings table. Filter logic added as AND conditions in the node selection queries (both sync SQLite and async PG/MySQL paths). UI follows the existing toggle+input pattern in AutoTracerouteSection.

**Tech Stack:** TypeScript, React, SQLite/PostgreSQL/MySQL (Drizzle ORM), vitest

---

### Task 1: Add settings keys and getter/setter methods

**Files:**
- Modify: `src/server/constants/settings.ts` (VALID_SETTINGS_KEYS array)
- Modify: `src/services/database.ts` (add getter/setter methods near line 5606)

- [ ] **Step 1: Add keys to VALID_SETTINGS_KEYS**

In `src/server/constants/settings.ts`, add these 5 keys to the `VALID_SETTINGS_KEYS` array:

```typescript
'tracerouteFilterLastHeardEnabled',
'tracerouteFilterLastHeardHours',
'tracerouteFilterHopsEnabled',
'tracerouteFilterHopsMin',
'tracerouteFilterHopsMax',
```

- [ ] **Step 2: Add getter/setter methods to database.ts**

In `src/services/database.ts`, after the existing `isTracerouteFilterRegexEnabled` / `setTracerouteFilterRegexEnabled` methods (around line 5606), add:

```typescript
// Last Heard filter
isTracerouteFilterLastHeardEnabled(): boolean {
  const value = this.getSetting('tracerouteFilterLastHeardEnabled');
  // Default to true — skip stale nodes by default
  return value !== 'false';
}

setTracerouteFilterLastHeardEnabled(enabled: boolean): void {
  this.setSetting('tracerouteFilterLastHeardEnabled', enabled ? 'true' : 'false');
  logger.debug(`✅ Set traceroute filter last heard enabled: ${enabled}`);
}

getTracerouteFilterLastHeardHours(): number {
  const value = this.getSetting('tracerouteFilterLastHeardHours');
  if (!value) return 168; // Default: 7 days
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? 168 : parsed;
}

setTracerouteFilterLastHeardHours(hours: number): void {
  this.setSetting('tracerouteFilterLastHeardHours', hours.toString());
  logger.debug(`✅ Set traceroute filter last heard hours: ${hours}`);
}

// Hop range filter
isTracerouteFilterHopsEnabled(): boolean {
  const value = this.getSetting('tracerouteFilterHopsEnabled');
  // Default to false — disabled by default
  return value === 'true';
}

setTracerouteFilterHopsEnabled(enabled: boolean): void {
  this.setSetting('tracerouteFilterHopsEnabled', enabled ? 'true' : 'false');
  logger.debug(`✅ Set traceroute filter hops enabled: ${enabled}`);
}

getTracerouteFilterHopsMin(): number {
  const value = this.getSetting('tracerouteFilterHopsMin');
  if (!value) return 0;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? 0 : parsed;
}

setTracerouteFilterHopsMin(min: number): void {
  this.setSetting('tracerouteFilterHopsMin', min.toString());
  logger.debug(`✅ Set traceroute filter hops min: ${min}`);
}

getTracerouteFilterHopsMax(): number {
  const value = this.getSetting('tracerouteFilterHopsMax');
  if (!value) return 10;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? 10 : parsed;
}

setTracerouteFilterHopsMax(max: number): void {
  this.setSetting('tracerouteFilterHopsMax', max.toString());
  logger.debug(`✅ Set traceroute filter hops max: ${max}`);
}
```

- [ ] **Step 3: Commit**

```bash
git add src/server/constants/settings.ts src/services/database.ts
git commit -m "feat(traceroute): add settings keys and getter/setters for last-heard and hop filters (#2566)"
```

---

### Task 2: Add filter logic to node selection queries

**Files:**
- Modify: `src/services/database.ts` — `getNodeNeedingTraceroute` (sync, ~line 4995) and `getNodeNeedingTracerouteAsync` (async, ~line 5173)

- [ ] **Step 1: Add filter settings reads to the sync version**

In `getNodeNeedingTraceroute`, after the existing filter reads (around line 5005), add:

```typescript
// Last heard and hop range filters (AND logic, applied before OR union filters)
const filterLastHeardEnabled = this.isTracerouteFilterLastHeardEnabled();
const filterLastHeardHours = this.getTracerouteFilterLastHeardHours();
const filterHopsEnabled = this.isTracerouteFilterHopsEnabled();
const filterHopsMin = this.getTracerouteFilterHopsMin();
const filterHopsMax = this.getTracerouteFilterHopsMax();
```

- [ ] **Step 2: Add AND filter logic to the sync version**

In `getNodeNeedingTraceroute`, after the SQL query returns `eligibleNodes` (after line 5045) and BEFORE the existing `if (filterEnabled)` block (line 5049), add:

```typescript
// Apply last-heard filter (AND logic — applied before OR union filters)
if (filterLastHeardEnabled) {
  const lastHeardCutoff = Math.floor(Date.now() / 1000) - (filterLastHeardHours * 3600);
  eligibleNodes = eligibleNodes.filter(node => {
    // Exclude nodes with no lastHeard or lastHeard older than cutoff
    return node.lastHeard != null && node.lastHeard >= lastHeardCutoff;
  });
}

// Apply hop range filter (AND logic)
if (filterHopsEnabled) {
  eligibleNodes = eligibleNodes.filter(node => {
    // Treat NULL hopsAway as 1 (direct neighbor)
    const hops = node.hopsAway ?? 1;
    return hops >= filterHopsMin && hops <= filterHopsMax;
  });
}
```

- [ ] **Step 3: Add the same filter reads to the async version**

In `getNodeNeedingTracerouteAsync`, after the existing filter reads (around line 5183), add the same 5 lines:

```typescript
// Last heard and hop range filters (AND logic, applied before OR union filters)
const filterLastHeardEnabled = this.isTracerouteFilterLastHeardEnabled();
const filterLastHeardHours = this.getTracerouteFilterLastHeardHours();
const filterHopsEnabled = this.isTracerouteFilterHopsEnabled();
const filterHopsMin = this.getTracerouteFilterHopsMin();
const filterHopsMax = this.getTracerouteFilterHopsMax();
```

- [ ] **Step 4: Add AND filter logic to the async version**

In `getNodeNeedingTracerouteAsync`, after the eligible nodes are fetched and BEFORE the existing `if (filterEnabled)` block, add the same two filter blocks as Step 2.

- [ ] **Step 5: Commit**

```bash
git add src/services/database.ts
git commit -m "feat(traceroute): apply last-heard and hop-range filters to node selection (#2566)"
```

---

### Task 3: Add new fields to the API get/set endpoints and FilterSettings

**Files:**
- Modify: `src/services/database.ts` — `getTracerouteFilterSettingsAsync` (~line 5724) and `setTracerouteFilterSettingsAsync` (~line 5757)
- Modify: `src/server/server.ts` — POST `/settings/traceroute-nodes` (~line 5096)

- [ ] **Step 1: Extend getTracerouteFilterSettingsAsync return type and body**

In `src/services/database.ts`, add these fields to the return type (after `sortByHops: boolean`):

```typescript
filterLastHeardEnabled: boolean;
filterLastHeardHours: number;
filterHopsEnabled: boolean;
filterHopsMin: number;
filterHopsMax: number;
```

And add to the return object:

```typescript
filterLastHeardEnabled: this.isTracerouteFilterLastHeardEnabled(),
filterLastHeardHours: this.getTracerouteFilterLastHeardHours(),
filterHopsEnabled: this.isTracerouteFilterHopsEnabled(),
filterHopsMin: this.getTracerouteFilterHopsMin(),
filterHopsMax: this.getTracerouteFilterHopsMax(),
```

- [ ] **Step 2: Extend setTracerouteFilterSettingsAsync parameters and body**

Add to the parameter type (after `sortByHops?: boolean`):

```typescript
filterLastHeardEnabled?: boolean;
filterLastHeardHours?: number;
filterHopsEnabled?: boolean;
filterHopsMin?: number;
filterHopsMax?: number;
```

Add to the method body (after the `sortByHops` block):

```typescript
if (settings.filterLastHeardEnabled !== undefined) {
  this.setTracerouteFilterLastHeardEnabled(settings.filterLastHeardEnabled);
}
if (settings.filterLastHeardHours !== undefined) {
  this.setTracerouteFilterLastHeardHours(settings.filterLastHeardHours);
}
if (settings.filterHopsEnabled !== undefined) {
  this.setTracerouteFilterHopsEnabled(settings.filterHopsEnabled);
}
if (settings.filterHopsMin !== undefined) {
  this.setTracerouteFilterHopsMin(settings.filterHopsMin);
}
if (settings.filterHopsMax !== undefined) {
  this.setTracerouteFilterHopsMax(settings.filterHopsMax);
}
```

- [ ] **Step 3: Extend the POST endpoint validation in server.ts**

In `src/server/server.ts`, in the POST `/settings/traceroute-nodes` handler:

1. Add to destructuring (line 5098):
```typescript
filterLastHeardEnabled, filterLastHeardHours,
filterHopsEnabled, filterHopsMin, filterHopsMax,
```

2. Add validation after the `expirationHours` validation block (after line 5193):
```typescript
// Validate filterLastHeardEnabled (optional boolean)
let validatedFilterLastHeardEnabled: boolean | undefined;
try {
  validatedFilterLastHeardEnabled = validateOptionalBoolean(filterLastHeardEnabled, 'filterLastHeardEnabled');
} catch (error) {
  return res.status(400).json({ error: (error as Error).message });
}

// Validate filterLastHeardHours (optional, must be integer >= 1)
let validatedFilterLastHeardHours: number | undefined;
if (filterLastHeardHours !== undefined) {
  if (!Number.isInteger(filterLastHeardHours) || filterLastHeardHours < 1) {
    return res.status(400).json({ error: 'Invalid filterLastHeardHours value. Must be an integer >= 1.' });
  }
  validatedFilterLastHeardHours = filterLastHeardHours;
}

// Validate filterHopsEnabled (optional boolean)
let validatedFilterHopsEnabled: boolean | undefined;
try {
  validatedFilterHopsEnabled = validateOptionalBoolean(filterHopsEnabled, 'filterHopsEnabled');
} catch (error) {
  return res.status(400).json({ error: (error as Error).message });
}

// Validate filterHopsMin/Max (optional, must be integers >= 0, min <= max)
let validatedFilterHopsMin: number | undefined;
let validatedFilterHopsMax: number | undefined;
if (filterHopsMin !== undefined) {
  if (!Number.isInteger(filterHopsMin) || filterHopsMin < 0) {
    return res.status(400).json({ error: 'Invalid filterHopsMin value. Must be a non-negative integer.' });
  }
  validatedFilterHopsMin = filterHopsMin;
}
if (filterHopsMax !== undefined) {
  if (!Number.isInteger(filterHopsMax) || filterHopsMax < 0) {
    return res.status(400).json({ error: 'Invalid filterHopsMax value. Must be a non-negative integer.' });
  }
  validatedFilterHopsMax = filterHopsMax;
}
if (validatedFilterHopsMin !== undefined && validatedFilterHopsMax !== undefined && validatedFilterHopsMin > validatedFilterHopsMax) {
  return res.status(400).json({ error: 'filterHopsMin cannot be greater than filterHopsMax.' });
}
```

3. Add to the `setTracerouteFilterSettingsAsync` call (line 5196):
```typescript
filterLastHeardEnabled: validatedFilterLastHeardEnabled,
filterLastHeardHours: validatedFilterLastHeardHours,
filterHopsEnabled: validatedFilterHopsEnabled,
filterHopsMin: validatedFilterHopsMin,
filterHopsMax: validatedFilterHopsMax,
```

- [ ] **Step 4: Commit**

```bash
git add src/services/database.ts src/server/server.ts
git commit -m "feat(traceroute): expose last-heard and hop filters via API (#2566)"
```

---

### Task 4: Add UI for the two new filters

**Files:**
- Modify: `src/components/AutoTracerouteSection.tsx`

- [ ] **Step 1: Add to FilterSettings interface**

Add after `filterRegexEnabled: boolean;` (line 43):

```typescript
filterLastHeardEnabled: boolean;
filterLastHeardHours: number;
filterHopsEnabled: boolean;
filterHopsMin: number;
filterHopsMax: number;
```

- [ ] **Step 2: Add state variables**

After the existing `filterRegexEnabled` state (line 85), add:

```typescript
// Last heard filter
const [filterLastHeardEnabled, setFilterLastHeardEnabled] = useState(true);
const [filterLastHeardHours, setFilterLastHeardHours] = useState(168);

// Hop range filter
const [filterHopsEnabled, setFilterHopsEnabled] = useState(false);
const [filterHopsMin, setFilterHopsMin] = useState(0);
const [filterHopsMax, setFilterHopsMax] = useState(10);
```

- [ ] **Step 3: Add loading from server**

In the `fetchAllSettings` effect, after `setFilterRegexEnabled(data.filterRegexEnabled !== false);` (line 160), add:

```typescript
setFilterLastHeardEnabled(data.filterLastHeardEnabled !== false);
setFilterLastHeardHours(data.filterLastHeardHours || 168);
setFilterHopsEnabled(data.filterHopsEnabled || false);
setFilterHopsMin(data.filterHopsMin ?? 0);
setFilterHopsMax(data.filterHopsMax ?? 10);
```

- [ ] **Step 4: Add change detection**

In the `hasChanges` useEffect, add after `filterRegexEnabledChanged`:

```typescript
const filterLastHeardEnabledChanged = filterLastHeardEnabled !== (initialSettings.filterLastHeardEnabled !== false);
const filterLastHeardHoursChanged = filterLastHeardHours !== (initialSettings.filterLastHeardHours || 168);
const filterHopsEnabledChanged = filterHopsEnabled !== (initialSettings.filterHopsEnabled || false);
const filterHopsMinChanged = filterHopsMin !== (initialSettings.filterHopsMin ?? 0);
const filterHopsMaxChanged = filterHopsMax !== (initialSettings.filterHopsMax ?? 10);
```

Add these to the `changed` expression and the `useEffect` dependency array.

- [ ] **Step 5: Add to save handler**

In `handleSaveForSaveBar`, add to the POST body (line 450, inside the JSON.stringify):

```typescript
filterLastHeardEnabled,
filterLastHeardHours,
filterHopsEnabled,
filterHopsMin,
filterHopsMax,
```

Also add to the `setInitialSettings` call (line 477).

- [ ] **Step 6: Add to resetChanges**

In `resetChanges`, add after `setFilterRegexEnabled(...)`:

```typescript
setFilterLastHeardEnabled(initialSettings.filterLastHeardEnabled !== false);
setFilterLastHeardHours(initialSettings.filterLastHeardHours || 168);
setFilterHopsEnabled(initialSettings.filterHopsEnabled || false);
setFilterHopsMin(initialSettings.filterHopsMin ?? 0);
setFilterHopsMax(initialSettings.filterHopsMax ?? 10);
```

- [ ] **Step 7: Add UI for Last Heard filter**

After the Name Regex filter section (after the `</div>` closing the regex filter around line 1019), add:

```tsx
{/* Last Heard Filter */}
<div style={{ marginBottom: '0.5rem', opacity: filterLastHeardEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
  <div
    style={sectionHeaderStyle}
    onClick={() => toggleSection('lastHeard')}
  >
    <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <input
        type="checkbox"
        checked={filterLastHeardEnabled}
        onChange={(e) => {
          e.stopPropagation();
          setFilterLastHeardEnabled(e.target.checked);
        }}
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'auto', margin: 0, cursor: 'pointer' }}
      />
      <span>{expandedSections.lastHeard ? '▼' : '▶'}</span>
      {t('automation.auto_traceroute.filter_by_last_heard')}
      {filterLastHeardEnabled && (
        <span style={badgeStyle}>{filterLastHeardHours}h</span>
      )}
    </span>
  </div>
  {expandedSections.lastHeard && (
    <div style={{ padding: '0.5rem', background: 'var(--ctp-base)', borderRadius: '4px' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '12px' }}>
        {t('automation.auto_traceroute.last_heard_within')}
        <input
          type="number"
          value={filterLastHeardHours}
          onChange={(e) => setFilterLastHeardHours(Math.max(1, parseInt(e.target.value) || 1))}
          min={1}
          style={{ width: '80px', padding: '2px 4px' }}
        />
        {t('automation.auto_traceroute.hours')}
      </label>
    </div>
  )}
</div>
```

- [ ] **Step 8: Add UI for Hop Range filter**

After the Last Heard filter, add:

```tsx
{/* Hop Range Filter */}
<div style={{ marginBottom: '0.5rem', opacity: filterHopsEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
  <div
    style={sectionHeaderStyle}
    onClick={() => toggleSection('hops')}
  >
    <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <input
        type="checkbox"
        checked={filterHopsEnabled}
        onChange={(e) => {
          e.stopPropagation();
          setFilterHopsEnabled(e.target.checked);
        }}
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'auto', margin: 0, cursor: 'pointer' }}
      />
      <span>{expandedSections.hops ? '▼' : '▶'}</span>
      {t('automation.auto_traceroute.filter_by_hops')}
      {filterHopsEnabled && (
        <span style={badgeStyle}>{filterHopsMin}-{filterHopsMax}</span>
      )}
    </span>
  </div>
  {expandedSections.hops && (
    <div style={{ padding: '0.5rem', background: 'var(--ctp-base)', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '12px' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
        {t('automation.auto_traceroute.min_hops')}
        <input
          type="number"
          value={filterHopsMin}
          onChange={(e) => setFilterHopsMin(Math.max(0, parseInt(e.target.value) || 0))}
          min={0}
          max={filterHopsMax}
          style={{ width: '60px', padding: '2px 4px' }}
        />
      </label>
      <span>—</span>
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
        {t('automation.auto_traceroute.max_hops')}
        <input
          type="number"
          value={filterHopsMax}
          onChange={(e) => setFilterHopsMax(Math.max(filterHopsMin, parseInt(e.target.value) || 0))}
          min={filterHopsMin}
          style={{ width: '60px', padding: '2px 4px' }}
        />
      </label>
    </div>
  )}
</div>
```

- [ ] **Step 9: Add 'lastHeard' and 'hops' to expandedSections state**

Find the `expandedSections` state (search for `useState<Record<string, boolean>>` or similar). Add `lastHeard: false` and `hops: false` to the initial state object.

- [ ] **Step 10: Add translation keys**

In the English translation file (likely `src/locales/en.json` or similar), add under `automation.auto_traceroute`:

```json
"filter_by_last_heard": "Last Heard Within",
"last_heard_within": "Only nodes heard within",
"hours": "hours",
"filter_by_hops": "Hop Range",
"min_hops": "Min:",
"max_hops": "Max:"
```

- [ ] **Step 11: Commit**

```bash
git add src/components/AutoTracerouteSection.tsx src/locales/en.json
git commit -m "feat(traceroute): add last-heard and hop-range filter UI (#2566)"
```

---

### Task 5: Build, deploy, and verify

- [ ] **Step 1: Type check**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 2: Run unit tests**

```bash
./node_modules/.bin/vitest run
```

Expected: All tests pass (no new tests needed — the filter logic is exercised through existing traceroute tests and manual testing).

- [ ] **Step 3: Build and deploy**

```bash
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml build meshmonitor-sqlite
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml up -d meshmonitor-sqlite
```

- [ ] **Step 4: Manual verification**

1. Navigate to Automation > Auto Traceroute
2. Verify "Last Heard Within" filter appears, enabled by default with 168 hours
3. Verify "Hop Range" filter appears, disabled by default
4. Toggle both filters, change values, save — verify settings persist on reload
5. Verify auto-traceroute respects the filters (check traceroute log for skipped stale nodes)

- [ ] **Step 5: Final commit and push**

```bash
git push -u origin feat/auto-traceroute-filters
```
