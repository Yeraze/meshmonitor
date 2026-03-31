# Exchange Position Channel Selection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to select which Meshtastic channel to use when requesting a position exchange, via a split-button UI.

**Architecture:** The backend `/api/position/request` endpoint accepts an optional `channel` body param (0-7), falling back to the node's stored channel. The frontend adds a split-button with a channel dropdown to `MessagesTab.tsx`. The `channels` array (already loaded and filtered of disabled channels) is passed as a new prop.

**Tech Stack:** TypeScript, React, Express, Vitest, supertest

**Design doc:** `docs/plans/2026-02-25-exchange-position-channel-design.md`

---

### Task 1: Backend — Accept optional `channel` param in position request endpoint

**Files:**
- Modify: `src/server/server.ts:2752-2813` (the `/position/request` handler)

**Step 1: Modify the channel selection logic**

In `src/server/server.ts`, find the `/position/request` handler at line 2752. Replace line 2763:

```typescript
const channel = node?.channel ?? 0; // Default to 0 if node not found or channel not set
```

With:

```typescript
// Use explicit channel from request if provided and valid (0-7), otherwise fall back to node's stored channel
const channel = (typeof req.body.channel === 'number' && req.body.channel >= 0 && req.body.channel <= 7)
  ? req.body.channel
  : (node?.channel ?? 0);
```

**Step 2: Run existing tests to confirm no regressions**

Run: `npx vitest run src/server/server.test.ts`
Expected: All existing tests PASS

**Step 3: Commit**

```bash
git add src/server/server.ts
git commit -m "feat: accept optional channel param in position request endpoint (#2021)"
```

---

### Task 2: Frontend — Update `handleExchangePosition` to accept channel param

**Files:**
- Modify: `src/App.tsx:2621-2665` (`handleExchangePosition` function)
- Modify: `src/components/MessagesTab.tsx:170` (prop type)

**Step 1: Update the handler signature and API call in App.tsx**

In `src/App.tsx`, change line 2621 from:

```typescript
const handleExchangePosition = async (nodeId: string) => {
```

To:

```typescript
const handleExchangePosition = async (nodeId: string, channel?: number) => {
```

Then change line 2646 from:

```typescript
body: JSON.stringify({ destination: nodeNum }),
```

To:

```typescript
body: JSON.stringify({ destination: nodeNum, ...(channel !== undefined && { channel }) }),
```

**Step 2: Update the prop type in MessagesTab.tsx**

In `src/components/MessagesTab.tsx`, change line 170 from:

```typescript
handleExchangePosition: (nodeId: string) => Promise<void>;
```

To:

```typescript
handleExchangePosition: (nodeId: string, channel?: number) => Promise<void>;
```

**Step 3: Run TypeScript compilation check**

Run: `npx tsc --noEmit --project tsconfig.json`
Expected: No errors

**Step 4: Commit**

```bash
git add src/App.tsx src/components/MessagesTab.tsx
git commit -m "feat: pass optional channel to position exchange API call (#2021)"
```

---

### Task 3: Frontend — Add `channels` prop to MessagesTab

**Files:**
- Modify: `src/components/MessagesTab.tsx` (props interface, ~line 100-180)
- Modify: `src/App.tsx` (~line 4337, where `<MessagesTab` is rendered)

**Step 1: Add `channels` to MessagesTab props interface**

In `src/components/MessagesTab.tsx`, add to the props interface (near the other props around line 130):

```typescript
channels: Channel[];
```

Add the import at the top of the file if `Channel` isn't already imported:

```typescript
import { Channel } from '../types/device';
```

Destructure it in the component function alongside other props.

**Step 2: Pass `channels` from App.tsx**

In `src/App.tsx`, add `channels={channels}` to the `<MessagesTab` JSX (after line 4337, near the other props). Place it near `channelFilter`:

```typescript
channels={channels}
```

**Step 3: Run TypeScript compilation check**

Run: `npx tsc --noEmit --project tsconfig.json`
Expected: No errors

**Step 4: Commit**

```bash
git add src/components/MessagesTab.tsx src/App.tsx
git commit -m "feat: pass channels prop to MessagesTab (#2021)"
```

---

### Task 4: Frontend — Split-button UI for Exchange Position

**Files:**
- Modify: `src/components/MessagesTab.tsx:1600-1620` (Exchange Position button area)

**Step 1: Replace the Exchange Position button with a split-button**

In `src/components/MessagesTab.tsx`, replace the Exchange Position button block (lines ~1600-1620) with:

```tsx
{/* Exchange Position - Split Button */}
{hasPermission('messages', 'write') && (
  <div style={{ display: 'flex', flex: '1 1 auto', minWidth: '120px', position: 'relative' }}>
    <button
      onClick={() => handleExchangePosition(selectedDMNode)}
      disabled={connectionStatus !== 'connected' || positionLoading === selectedDMNode}
      style={{
        flex: 1,
        padding: '0.5rem 1rem',
        backgroundColor: 'var(--ctp-blue)',
        color: 'var(--ctp-base)',
        border: 'none',
        borderRadius: channels.length > 1 ? '4px 0 0 4px' : '4px',
        cursor: connectionStatus !== 'connected' || positionLoading === selectedDMNode ? 'not-allowed' : 'pointer',
        opacity: connectionStatus !== 'connected' || positionLoading === selectedDMNode ? 0.5 : 1,
        fontSize: '0.9rem'
      }}
    >
      {positionLoading === selectedDMNode ? <span className="spinner"></span> : '📍'} {t('messages.exchange_position')}
    </button>
    {channels.length > 1 && (
      <button
        onClick={(e) => {
          e.stopPropagation();
          setShowPositionChannelDropdown(prev => !prev);
        }}
        disabled={connectionStatus !== 'connected' || positionLoading === selectedDMNode}
        title={t('messages.exchange_position_channel')}
        style={{
          padding: '0.5rem 0.5rem',
          backgroundColor: 'var(--ctp-blue)',
          color: 'var(--ctp-base)',
          border: 'none',
          borderLeft: '1px solid var(--ctp-base)',
          borderRadius: '0 4px 4px 0',
          cursor: connectionStatus !== 'connected' || positionLoading === selectedDMNode ? 'not-allowed' : 'pointer',
          opacity: connectionStatus !== 'connected' || positionLoading === selectedDMNode ? 0.5 : 1,
          fontSize: '0.9rem'
        }}
      >
        ▾
      </button>
    )}
    {showPositionChannelDropdown && (
      <div style={{
        position: 'absolute',
        top: '100%',
        right: 0,
        marginTop: '4px',
        background: 'var(--ctp-surface0)',
        border: '1px solid var(--ctp-surface2)',
        borderRadius: '4px',
        zIndex: 1000,
        minWidth: '160px',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)'
      }}>
        {channels.map((ch) => (
          <button
            key={ch.id}
            onClick={() => {
              handleExchangePosition(selectedDMNode, ch.id);
              setShowPositionChannelDropdown(false);
            }}
            style={{
              display: 'block',
              width: '100%',
              padding: '0.5rem 1rem',
              background: 'none',
              border: 'none',
              color: 'var(--ctp-text)',
              cursor: 'pointer',
              textAlign: 'left',
              fontSize: '0.85rem'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--ctp-surface1)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
          >
            {ch.name || `Channel ${ch.id}`}{ch.id === 0 ? ' (Primary)' : ''}
          </button>
        ))}
      </div>
    )}
  </div>
)}
```

**Step 2: Add state and click-outside handler**

Near the top of the MessagesTab component (where other `useState` calls are), add:

```typescript
const [showPositionChannelDropdown, setShowPositionChannelDropdown] = useState(false);
```

Add a click-outside effect to close the dropdown (near other `useEffect` hooks):

```typescript
useEffect(() => {
  if (!showPositionChannelDropdown) return;
  const handleClickOutside = () => setShowPositionChannelDropdown(false);
  document.addEventListener('click', handleClickOutside);
  return () => document.removeEventListener('click', handleClickOutside);
}, [showPositionChannelDropdown]);
```

**Step 3: Run TypeScript compilation check**

Run: `npx tsc --noEmit --project tsconfig.json`
Expected: No errors

**Step 4: Commit**

```bash
git add src/components/MessagesTab.tsx
git commit -m "feat: add split-button channel selector for Exchange Position (#2021)"
```

---

### Task 5: i18n — Add translation key

**Files:**
- Modify: `public/locales/en.json`

**Step 1: Add the translation key**

In `public/locales/en.json`, find the `messages.exchange_position_title` key (line ~306) and add after it:

```json
"messages.exchange_position_channel": "Select channel for position exchange",
```

**Step 2: Commit**

```bash
git add public/locales/en.json
git commit -m "feat: add i18n key for position exchange channel selector (#2021)"
```

---

### Task 6: Run full test suite and verify

**Step 1: Run full vitest suite**

Run: `npx vitest run`
Expected: All tests pass, no regressions

**Step 2: Run TypeScript compilation**

Run: `npx tsc --noEmit --project tsconfig.json`
Expected: No errors

**Step 3: Squash/fixup commits if needed, then create PR branch**

```bash
git checkout -b feat/exchange-position-channel-2021
git push -u origin feat/exchange-position-channel-2021
```
