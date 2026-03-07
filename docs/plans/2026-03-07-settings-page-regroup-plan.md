# Settings Page Regrouping Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reorganize the Settings page sections so the "Display Preferences" mega-section is broken into focused groups and all orphaned toggles have proper nav entries.

**Architecture:** Pure UI reorganization of `src/components/SettingsTab.tsx`. Move JSX blocks between section `<div>`s, update SectionNav items, add translation keys. No new components, no logic changes.

**Tech Stack:** React, i18next, existing SettingsTab component

---

### Task 1: Add new translation keys

**Files:**
- Modify: `public/locales/en.json`

**Step 1: Add new section header translation keys**

Add these keys near the existing `settings.*` keys (around line 1287):

```json
"settings.units_and_formats": "Units & Formats",
"settings.sorting": "Sorting",
"settings.appearance": "Appearance",
"settings.map": "Map",
"settings.telemetry": "Telemetry",
"settings.notifications_and_security": "Notifications & Security",
```

**Step 2: Verify the file is valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('public/locales/en.json','utf8')); console.log('Valid JSON')"`
Expected: `Valid JSON`

**Step 3: Commit**

```bash
git add public/locales/en.json
git commit -m "feat: add translation keys for new settings sections"
```

---

### Task 2: Update SectionNav items

**Files:**
- Modify: `src/components/SettingsTab.tsx` (lines 817-831)

**Step 1: Replace the SectionNav items array**

Replace the current `SectionNav items={[...]}` block (lines 817-831) with:

```tsx
<SectionNav items={[
  { id: 'settings-language', label: t('settings.language') },
  { id: 'settings-units', label: t('settings.units_and_formats') },
  { id: 'settings-sorting', label: t('settings.sorting') },
  { id: 'settings-appearance', label: t('settings.appearance') },
  { id: 'settings-map', label: t('settings.map') },
  { id: 'settings-node-display', label: t('settings.node_display') },
  { id: 'settings-telemetry', label: t('settings.telemetry') },
  { id: 'settings-notifications', label: t('settings.notifications_and_security') },
  { id: 'settings-packet-monitor', label: t('settings.packet_monitor') },
  { id: 'settings-solar', label: t('settings.solar_monitoring') },
  { id: 'settings-backup', label: t('settings.system_backup', 'System Backup') },
  ...(databaseType === 'sqlite' ? [{ id: 'settings-maintenance', label: t('maintenance.title', 'Database Maintenance') }] : []),
  ...(isAdmin ? [{ id: 'settings-embed', label: t('settings.embed_maps', 'Embed Maps') }] : []),
  ...(isAdmin && firmwareOtaEnabled ? [{ id: 'settings-firmware', label: t('firmware.title', 'Firmware Updates') }] : []),
  { id: 'settings-reset-ui', label: t('settings.reset_ui_positions') },
  { id: 'settings-management', label: t('settings.settings_management') },
  { id: 'settings-danger', label: t('settings.danger_zone') },
]} />
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No errors (nav items are just strings, IDs don't need to match yet)

**Step 3: Commit**

```bash
git add src/components/SettingsTab.tsx
git commit -m "feat: update SectionNav with new settings sections"
```

---

### Task 3: Break "Display Preferences" into new sections

This is the main task. The current `<div id="settings-display-prefs">` (lines 952-1194) contains all the items that need to be distributed into 4 new sections. Also move the orphaned sections that follow it.

**Files:**
- Modify: `src/components/SettingsTab.tsx` (lines 952-1349)

**Step 1: Replace the Display Preferences section and orphaned sections**

Remove the entire block from line 952 (`<div id="settings-display-prefs">`) through line 1349 (end of dim inactive nodes section), and replace with these new sections in order:

**Section: Units & Formats** (id=`settings-units`)
Contains: time format, date format, temperature unit, distance unit

**Section: Sorting** (id=`settings-sorting`)
Contains: node sort field, node sort direction, dashboard sort

**Section: Appearance** (id=`settings-appearance`)
Contains: theme selector, custom theme management, map pin style, tapback emojis

**Section: Map** (id=`settings-map`)
Contains: map tileset, custom tileset manager, position history line style
Note: Embed Maps stays where it is (admin-gated section later in the file) but gets its `id` changed to just anchor under the Map nav entry if desired. Actually per the design, embed maps moves INTO this section. Move the `{isAdmin && (<div id="settings-embed">...)}` block from its current location (line 1462-1467) into the end of the Map section.

**Section: Node Display** (id=`settings-node-display`) — keep existing
Contains: existing items (max node age, inactive thresholds, stats interval, hops calc) PLUS move in:
- Hide Incomplete Nodes toggle (currently orphaned ~line 1281)
- Dim Inactive Nodes toggle + sub-settings (currently orphaned ~line 1298)

**Section: Telemetry** (id=`settings-telemetry`)
Contains: telemetry visualization hours, favorite telemetry storage days

**Section: Notifications & Security** (id=`settings-notifications`)
Contains: audio notifications toggle, homoglyph detection toggle

Then keep Packet Monitor and Solar Monitoring sections as-is.

**Step 2: Move Reset UI Positions section**

The Reset UI Positions section (currently at ~line 1202) should be moved to after Firmware Updates and before Settings Management. Give it `id="settings-reset-ui"`.

**Step 3: Remove the standalone Embed Maps section**

Since Embed Maps was moved into the Map section, remove the standalone `{isAdmin && (<div id="settings-embed">...)}` block from its old location.

**Step 4: Update the Embed Maps nav entry**

Since Embed Maps is now inside the Map section, remove its separate SectionNav entry (already done in Task 2 — but if we want to keep it as a separate nav anchor for admins, we need to keep the `id="settings-embed"` div wrapper inside the Map section).

**Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

**Step 6: Commit**

```bash
git add src/components/SettingsTab.tsx
git commit -m "feat: reorganize settings page into focused sections"
```

---

### Task 4: Build, deploy, and verify

**Step 1: Build Docker image**

Run: `docker compose -f docker-compose.dev.yml build --no-cache meshmonitor 2>&1 | tail -5`

**Step 2: Deploy**

Run: `docker compose -f docker-compose.dev.yml up -d meshmonitor`

**Step 3: Verify new sections appear**

Check the running app at port 8080. Verify:
- SectionNav shows all 17 section links
- Each section has a proper header
- All settings items are present (none lost)
- Clicking nav links scrolls to correct section

**Step 4: Commit any fixes if needed**
