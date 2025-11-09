# Release Notes - v2.16.1

## Overview
This is a minor feature release that improves the emoji reaction picker with a modal UI to prevent accidental sends and expands the available emoji selection for better expression in messages.

## Features

### Improved Emoji Response Picker (#500, #503)
Completely redesigned the emoji reaction picker to address usability issues, particularly on mobile devices.

**What Changed:**
- Replaced inline emoji buttons with a two-step modal interface
- Expanded emoji selection from 7 to 24 emojis
- Mobile-optimized design with larger touch targets
- Prevents accidental emoji sends on smaller screens

**Key Improvements:**
- **Two-Step Selection**: Click emoji button (😄) to open modal, then select from grid
- **Expanded Emoji Set (24 total)**:
  - Common reactions: 👍 👎 ❤️ 😂 😢 😮 😡 🎉
  - Questions/alerts: ❓ ❗ ‼️
  - Fun emojis (OLED compatible): 💩 👋 🤠 🐭 😈
  - Weather (OLED compatible): ☀️ ☔ ☁️ 🌫️
  - Additional: ✅ ❌ 🔥 💯
- **Mobile Safety**: Minimum 45px touch targets, proper spacing, visual feedback
- **Better UX**: Grid layout, hover tooltips, click outside to dismiss

**Before:**
- 7 inline emoji buttons appeared on hover
- Easy to accidentally tap wrong emoji on mobile
- Limited emoji selection

**After:**
- Single emoji picker button on hover
- Modal popup with 24 emoji grid
- Requires deliberate two-step action to send
- Larger, easier-to-tap buttons on mobile

## Technical Details

**Files Modified:**
- `src/App.tsx`: Added modal state, expanded emoji array, replaced inline buttons
- `src/App.css`: Added modal styling with responsive mobile design

**Changes:**
- +178 additions
- -27 deletions

## Migration Notes
No breaking changes. The feature is backward compatible and requires no configuration changes.

## Testing
- ✅ Build completed successfully
- ✅ Container running and tested
- ✅ Emoji picker opens on button click
- ✅ All 24 emojis display correctly
- ✅ Reactions send properly
- ✅ Modal closes correctly
- ✅ Responsive design tested

## Related Issues & PRs
- Fixes #500 - [FEAT] Improved Emoji Response Picker and Respond To Message Features
- Merged via #503

## Contributors
- @Yeraze
- Claude Code for implementation

## Full Changelog
https://github.com/Yeraze/meshmonitor/compare/v2.16.0...v2.16.1
