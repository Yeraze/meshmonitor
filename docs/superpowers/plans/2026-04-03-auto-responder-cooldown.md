# Auto-Responder Per-Node Cooldown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-node cooldown rate limiting to Auto-Acknowledge (global setting, 60s default) and Auto-Responder (per-trigger setting, 0s default).

**Architecture:** In-memory Maps track `nodeNum → lastResponseTimestamp`. Auto-Acknowledge uses a single class-level Map with one settings key. Auto-Responder adds a `cooldownSeconds` field to each trigger's JSON and a Map keyed by `"triggerIndex:nodeNum"`. No database persistence — cooldowns reset on restart.

**Tech Stack:** TypeScript, React, vitest

---

### Task 1: Auto-Acknowledge — settings key, getter/setter, and server-side cooldown logic

**Files:**
- Modify: `src/server/constants/settings.ts`
- Modify: `src/server/meshtasticManager.ts`

- [ ] **Step 1: Add settings key**

In `src/server/constants/settings.ts`, add to `VALID_SETTINGS_KEYS` after the existing `autoAckTestMessages` key:

```typescript
'autoAckCooldownSeconds',
```

- [ ] **Step 2: Add cooldown Map as class property**

In `src/server/meshtasticManager.ts`, in the class property declarations area (near line 300, where `geofenceCooldowns` is declared), add:

```typescript
private autoAckCooldowns: Map<number, number> = new Map(); // nodeNum -> lastResponseTimestamp
```

- [ ] **Step 3: Add cooldown check in checkAutoAcknowledge**

In `checkAutoAcknowledge()`, after the `autoAckSkipIncompleteNodes` check (after line 7118) and before the pattern matching / response logic, add:

```typescript
      // Per-node cooldown rate limiting
      const cooldownSetting = await databaseService.settings.getSetting('autoAckCooldownSeconds');
      const cooldownSeconds = cooldownSetting ? parseInt(cooldownSetting, 10) : 60;
      if (cooldownSeconds > 0) {
        const lastResponse = this.autoAckCooldowns.get(fromNum);
        if (lastResponse && Date.now() - lastResponse < cooldownSeconds * 1000) {
          logger.debug(`⏭️  Skipping auto-acknowledge for node ${fromNum}: cooldown active (${cooldownSeconds}s)`);
          return;
        }
      }
```

- [ ] **Step 4: Record cooldown timestamp after response**

Find where the auto-acknowledge response is sent. There are two send paths: tapback (around line 7205) and message reply (around line 7251). After BOTH sends, we need to record the timestamp. The cleanest approach: add a single line right before the method's final closing `catch`/`}`, after all response logic completes:

Search for the end of `checkAutoAcknowledge` — find the pattern where both tapback and reply have been sent. After the reply send block, add:

```typescript
      // Record cooldown timestamp
      this.autoAckCooldowns.set(fromNum, Date.now());
```

This should go after both the tapback and reply sends but before the catch block. Find the line that looks like the last action before the `} catch` at the end of the method.

- [ ] **Step 5: Commit**

```bash
git add src/server/constants/settings.ts src/server/meshtasticManager.ts
git commit -m "feat(auto-ack): add per-node cooldown rate limiting (#2565)"
```

---

### Task 2: Auto-Acknowledge — UI for cooldown setting

**Files:**
- Modify: `src/contexts/AutomationContext.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/AutoAcknowledgeSection.tsx`
- Modify: `public/locales/en.json`

- [ ] **Step 1: Add state to AutomationContext**

In `src/contexts/AutomationContext.tsx`:

1. Add to the context type interface (near `autoAckEnabled: boolean`):
```typescript
autoAckCooldownSeconds: number;
setAutoAckCooldownSeconds: (value: number) => void;
```

2. Add useState (near the other autoAck states):
```typescript
const [autoAckCooldownSeconds, setAutoAckCooldownSeconds] = useState<number>(60);
```

3. Add to the context value object:
```typescript
autoAckCooldownSeconds, setAutoAckCooldownSeconds,
```

- [ ] **Step 2: Load setting in App.tsx**

In `src/App.tsx`, find where other autoAck settings are loaded from the `/api/settings` response (look for `settings.autoAckEnabled`). Add nearby:

```typescript
if (settings.autoAckCooldownSeconds !== undefined) {
  setAutoAckCooldownSeconds(parseInt(settings.autoAckCooldownSeconds) || 60);
}
```

Also add to the destructuring from `useAutomation()` context (near the other autoAck destructures):
```typescript
autoAckCooldownSeconds, setAutoAckCooldownSeconds,
```

And pass as props to `<AutoAcknowledgeSection>`:
```typescript
cooldownSeconds={autoAckCooldownSeconds}
onCooldownSecondsChange={setAutoAckCooldownSeconds}
```

- [ ] **Step 3: Add props to AutoAcknowledgeSection**

In `src/components/AutoAcknowledgeSection.tsx`:

1. Add to `AutoAcknowledgeSectionProps` interface:
```typescript
cooldownSeconds: number;
onCooldownSecondsChange: (value: number) => void;
```

2. Add to the component destructuring.

3. Add local state:
```typescript
const [localCooldownSeconds, setLocalCooldownSeconds] = useState(cooldownSeconds);
```

4. Add to the `useEffect` that syncs props → local state:
```typescript
setLocalCooldownSeconds(cooldownSeconds);
```

5. Add to change detection `useEffect`:
```typescript
const cooldownChanged = localCooldownSeconds !== cooldownSeconds;
```
Add `cooldownChanged` to the `changed` expression and `localCooldownSeconds` + `cooldownSeconds` to the dependency array.

6. Add to save handler body (inside the `JSON.stringify`):
```typescript
autoAckCooldownSeconds: String(localCooldownSeconds),
```

7. Add to the callback after save succeeds:
```typescript
onCooldownSecondsChange(localCooldownSeconds);
```

- [ ] **Step 4: Add UI input**

In the JSX of `AutoAcknowledgeSection.tsx`, add a numeric input near the "Skip incomplete nodes" or "Ignored nodes" settings. Add:

```tsx
<div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
  <label style={{ fontSize: '0.9rem' }}>
    {t('automation.auto_acknowledge.cooldown_label')}
  </label>
  <input
    type="number"
    value={localCooldownSeconds}
    onChange={(e) => setLocalCooldownSeconds(Math.max(0, parseInt(e.target.value) || 0))}
    min={0}
    style={{ width: '80px', padding: '2px 4px' }}
  />
  <span style={{ fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
    {t('automation.auto_acknowledge.cooldown_help')}
  </span>
</div>
```

- [ ] **Step 5: Add translation keys**

In `public/locales/en.json`, under `automation.auto_acknowledge`, add:

```json
"cooldown_label": "Per-node cooldown (seconds):",
"cooldown_help": "0 = disabled"
```

- [ ] **Step 6: Commit**

```bash
git add src/contexts/AutomationContext.tsx src/App.tsx src/components/AutoAcknowledgeSection.tsx public/locales/en.json
git commit -m "feat(auto-ack): add cooldown settings UI (#2565)"
```

---

### Task 3: Auto-Responder — per-trigger cooldown field and server-side logic

**Files:**
- Modify: `src/components/auto-responder/types.ts`
- Modify: `src/server/meshtasticManager.ts`

- [ ] **Step 1: Add cooldownSeconds to trigger type**

In `src/components/auto-responder/types.ts`, add to `AutoResponderTrigger` interface (after `scriptArgs`):

```typescript
cooldownSeconds?: number; // Per-node cooldown in seconds (0 = disabled, default)
```

- [ ] **Step 2: Add cooldown Map as class property**

In `src/server/meshtasticManager.ts`, near the `autoAckCooldowns` Map added in Task 1, add:

```typescript
private autoResponderCooldowns: Map<string, number> = new Map(); // "triggerIndex:nodeNum" -> lastResponseTimestamp
```

- [ ] **Step 3: Add cooldown check in checkAutoResponder**

In `checkAutoResponder()`, find the trigger loop (search for `for (const trigger of triggers)` or similar). The loop needs a trigger index, so if it uses `for...of`, change to indexed iteration:

```typescript
for (let triggerIdx = 0; triggerIdx < triggers.length; triggerIdx++) {
  const trigger = triggers[triggerIdx];
```

After a trigger pattern matches (after the match is confirmed, before the response is executed), add:

```typescript
        // Per-node cooldown rate limiting
        const cooldownSeconds = trigger.cooldownSeconds || 0;
        if (cooldownSeconds > 0) {
          const cooldownKey = `${triggerIdx}:${message.fromNodeNum}`;
          const lastResponse = this.autoResponderCooldowns.get(cooldownKey);
          if (lastResponse && Date.now() - lastResponse < cooldownSeconds * 1000) {
            logger.debug(`⏭️  Skipping auto-responder trigger ${triggerIdx} for node ${message.fromNodeNum}: cooldown active (${cooldownSeconds}s)`);
            continue; // Try next trigger
          }
        }
```

After the response is sent (after the message queue enqueue or HTTP/script response), add:

```typescript
        // Record cooldown timestamp
        if (cooldownSeconds > 0) {
          const cooldownKey = `${triggerIdx}:${message.fromNodeNum}`;
          this.autoResponderCooldowns.set(cooldownKey, Date.now());
        }
```

- [ ] **Step 4: Commit**

```bash
git add src/components/auto-responder/types.ts src/server/meshtasticManager.ts
git commit -m "feat(auto-responder): add per-trigger per-node cooldown (#2565)"
```

---

### Task 4: Auto-Responder — UI for per-trigger cooldown

**Files:**
- Modify: `src/components/auto-responder/TriggerItem.tsx`
- Modify: `src/components/AutoResponderSection.tsx`
- Modify: `public/locales/en.json`

- [ ] **Step 1: Add cooldownSeconds to TriggerItem state and props**

In `src/components/auto-responder/TriggerItem.tsx`:

1. Add state variable (near other edit states like `editScriptArgs`):
```typescript
const [editCooldownSeconds, setEditCooldownSeconds] = useState(trigger.cooldownSeconds || 0);
```

2. Add to the reset logic when editing starts (where `setEditScriptArgs(trigger.scriptArgs || '')` is):
```typescript
setEditCooldownSeconds(trigger.cooldownSeconds || 0);
```

3. Extend the `onSaveEdit` prop signature to include `cooldownSeconds`:
```typescript
onSaveEdit: (trigger: string | string[], responseType: ResponseType, response: string, multiline: boolean, verifyResponse: boolean, channels: Array<number | 'dm' | 'none'>, scriptArgs?: string, cooldownSeconds?: number) => void;
```

4. In the save handler call, pass `editCooldownSeconds`:
```typescript
onSaveEdit(normalizedTrigger, editResponseType, editResponse, editMultiline, finalVerifyResponse, editChannels, scriptArgsToSave, editCooldownSeconds || undefined);
```

- [ ] **Step 2: Add UI input in TriggerItem**

In the editing JSX, add a cooldown input after the existing fields (e.g., after scriptArgs or channels):

```tsx
{/* Cooldown */}
<div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
  <label style={{ minWidth: '80px', fontSize: '0.9rem', fontWeight: 'bold' }}>{t('auto_responder.cooldown_label', 'Cooldown:')}</label>
  <input
    type="number"
    value={editCooldownSeconds}
    onChange={(e) => setEditCooldownSeconds(Math.max(0, parseInt(e.target.value) || 0))}
    min={0}
    className="setting-input"
    style={{ width: '80px' }}
  />
  <span style={{ fontSize: '0.75rem', color: 'var(--ctp-subtext0)' }}>
    {t('auto_responder.cooldown_help', 'seconds per node (0 = disabled)')}
  </span>
</div>
```

Also show the cooldown in the read-only (non-editing) view if > 0:
```tsx
{trigger.cooldownSeconds && trigger.cooldownSeconds > 0 && (
  <span style={{ fontSize: '0.75rem', color: 'var(--ctp-subtext0)' }}>
    ⏱ {trigger.cooldownSeconds}s {t('auto_responder.cooldown_badge', 'cooldown')}
  </span>
)}
```

- [ ] **Step 3: Update saveEdit in AutoResponderSection.tsx**

In `src/components/AutoResponderSection.tsx`, update the `saveEdit` function signature to accept `cooldownSeconds`:

```typescript
const saveEdit = (id: string, trigger: string | string[], responseType: ResponseType, response: string, multiline: boolean, verifyResponse: boolean, channels: Array<number | 'dm' | 'none'>, scriptArgs?: string, cooldownSeconds?: number) => {
```

In the `setLocalTriggers` call inside `saveEdit`, add `cooldownSeconds` to the spread:

```typescript
{ ...t, trigger: ..., responseType, response: ..., multiline: ..., verifyResponse, channels, channel: undefined, scriptArgs: ..., cooldownSeconds: cooldownSeconds || undefined }
```

Update the `onSaveEdit` lambda in the JSX to pass the new argument:

```typescript
onSaveEdit={(t, rt, r, m, v, c, sa, cd) => saveEdit(trigger.id, t, rt, r, m, v, c, sa, cd)}
```

- [ ] **Step 4: Add translation keys**

In `public/locales/en.json`, under `auto_responder`, add:

```json
"cooldown_label": "Cooldown:",
"cooldown_help": "seconds per node (0 = disabled)",
"cooldown_badge": "cooldown"
```

- [ ] **Step 5: Commit**

```bash
git add src/components/auto-responder/TriggerItem.tsx src/components/AutoResponderSection.tsx public/locales/en.json
git commit -m "feat(auto-responder): add per-trigger cooldown UI (#2565)"
```

---

### Task 5: Type check, test, build, deploy

- [ ] **Step 1: Type check**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 2: Run unit tests**

```bash
./node_modules/.bin/vitest run
```

Expected: All tests pass.

- [ ] **Step 3: Build and deploy**

```bash
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml build meshmonitor-sqlite
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml up -d meshmonitor-sqlite
```

- [ ] **Step 4: Manual verification**

1. Auto-Acknowledge: Navigate to Automation > Auto Acknowledge. Verify cooldown input appears with default 60. Save, reload, verify persistence. Send "test" twice quickly from a node — second should be ignored.
2. Auto-Responder: Navigate to Automation > Auto Responder. Edit a trigger. Verify cooldown input appears with default 0. Set to 30, save. Trigger it twice quickly — second should be ignored.

- [ ] **Step 5: Push**

```bash
git push -u origin feat/auto-responder-cooldown
```
