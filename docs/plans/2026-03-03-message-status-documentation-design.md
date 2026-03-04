# Message Status Documentation Design

**Date:** 2026-03-03
**Issue:** #2118 - Add better documentation on message statuses

## Problem

Message delivery status icons are unclear to users. The FAQ documents node icons but not message delivery status icons. Also, the `status-confirmed` CSS class is missing styling.

## Changes

### 1. Fix `status-confirmed` CSS

Add missing CSS rule for `.status-confirmed` using `var(--ctp-blue)` to match the existing pattern of colored status indicators.

### 2. Add Message Status Section to FAQ

Add a new section to `docs/faq.md` near the existing icon documentation (~line 600) with a table documenting all 5 message delivery states:

| State | Icon | Tooltip | Meaning |
|-------|------|---------|---------|
| Failed | ❌ | Failed to send | Routing error or max retries exceeded |
| Confirmed | 🔒 | Received by target node | DM confirmed received by recipient |
| Delivered | ✅ | Transmitted to mesh | Message sent to the mesh network |
| Pending | ⏳ | Sending... | Awaiting acknowledgment (< 30s) |
| Timeout | ⏱️ | No acknowledgment received | No response after 30 seconds |

Note: Status icons only appear on messages you send.

### 3. Files to Modify

- `src/App.css` - Add `.status-confirmed` CSS rule
- `docs/faq.md` - Add message delivery status section
