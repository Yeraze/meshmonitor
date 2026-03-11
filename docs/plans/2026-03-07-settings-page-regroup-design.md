# Settings Page Regrouping Design

**Date:** 2026-03-07
**Goal:** Reorganize the Settings page to be more logical and easier to navigate by breaking the mega "Display Preferences" section into focused groups and giving all orphaned toggles proper homes in the SectionNav.

## Current Problems

1. "Display Preferences" is a mega-section with 15+ unrelated items (sorting, units, map, theme, telemetry)
2. Six sections have no SectionNav entry: Custom Themes, Tapback Emojis, Reset UI Positions, Audio Notifications, Homoglyph Detection, Hide Incomplete Nodes, Dim Inactive Nodes
3. Standalone toggles float between Packet Monitor and Solar with no logical grouping

## New Section Order

| # | Section | Contents | Notes |
|---|---------|----------|-------|
| 1 | Language | Language selector | Unchanged |
| 2 | Units & Formats | Time format, date format, temperature, distance | From Display Preferences |
| 3 | Sorting | Node sort field/direction, dashboard sort | From Display Preferences |
| 4 | Appearance | Theme, custom themes, map pin style, tapback emojis | From Display Preferences + orphans |
| 5 | Map | Map tileset, custom tilesets, position history line style, embed maps (admin) | From Display Preferences + admin section |
| 6 | Node Display | Max node age, inactive thresholds, stats interval, hops calc, hide incomplete nodes, dim inactive nodes | Existing + orphaned toggles |
| 7 | Telemetry | Telemetry visualization hours, favorite telemetry storage days | From Display Preferences |
| 8 | Notifications & Security | Audio notifications, homoglyph detection | Orphaned toggles grouped |
| 9 | Packet Monitor | Toggle + packet log settings | Unchanged |
| 10 | Solar Monitoring | Toggle + solar config fields | Unchanged |
| 11 | System Backup | Backup/restore | Unchanged |
| 12 | Database Maintenance | SQLite VACUUM etc. | SQLite only, unchanged |
| 13 | Auto Upgrade | Auto upgrade test | Unchanged |
| 14 | Firmware Updates | OTA firmware | Admin only, unchanged |
| 15 | Reset UI Positions | Reset draggable positions | Was orphaned, now in nav |
| 16 | Settings Management | Reset to defaults | Unchanged |
| 17 | Danger Zone | Purge actions | Unchanged |

## Approach

- **Regroup and re-label only** — no new components, no layout changes
- Move settings items between `<div className="settings-section">` blocks
- Update SectionNav items array to match new sections
- Add new translation keys for new section headers
- All existing functionality preserved, just reorganized
