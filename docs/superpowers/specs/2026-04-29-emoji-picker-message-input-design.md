# Emoji Picker Button for Message Input (Desktop-Only)

**Issue:** [#2575](https://github.com/Yeraze/meshmonitor/issues/2575)
**Date:** 2026-04-29
**Status:** Design — pending implementation plan

## Summary

Add an emoji picker button to the message composition inputs in the Channels and Messages tabs. Clicking the button opens a full emoji picker (Unicode 15, search, categories, skin tones) that inserts the chosen emoji at the textarea's cursor position. The button is rendered only on desktop pointer devices; mobile users continue to use their OS keyboard's built-in emoji input.

## Motivation

Today the only way to insert an emoji into an outgoing message is to copy and paste from another source. The reaction (tapback) picker is reaction-only and not wired into the compose textareas. Mobile keyboards already provide a native picker, so the addition is targeted at desktop users.

## Scope

### In scope

- Emoji insertion at cursor position into the DM textarea (`MessagesTab.tsx`) and the channel textarea (`ChannelsTab.tsx`).
- Visibility gated to pointer-fine (mouse) devices via `window.matchMedia('(pointer: fine)')`.
- Lazy-loaded picker bundle so the cost is paid only when the button is clicked.
- Theme-aware picker (matches existing light/dark theme).

### Out of scope

- `:joy:` shortcode auto-replacement (issue lists this as a "supplementary" idea — separate ticket).
- Reusing the limited tapback emoji set in the compose flow (user chose full picker).
- Changing the existing tapback `EmojiPickerModal`.
- Mobile picker rendering.

## Library

**`emoji-picker-react`** (latest stable, MIT). Chosen over `frimousse` because:

- Drop-in `<EmojiPicker>` component with built-in search, categories, skin tones, and recently used.
- Built-in light/dark theme prop pairs cleanly with existing theme system.
- Larger bundle (~280 KB minified) is acceptable because the picker is lazy-loaded behind a desktop-only button — non-clickers and mobile users never download it.
- Active maintenance, large user base.

## Architecture

### New files

- `src/hooks/useIsDesktop.ts` — reactive media query hook.
- `src/components/MessageEmojiButton/MessageEmojiButton.tsx` — button + picker popover.
- `src/components/MessageEmojiButton/MessageEmojiButton.css` — popover positioning, button styling.
- `src/components/MessageEmojiButton/index.ts` — barrel re-export.

### Modified files

- `src/components/MessagesTab.tsx` — render `<MessageEmojiButton>` adjacent to DM textarea inside `.message-input-container`.
- `src/components/ChannelsTab.tsx` — render `<MessageEmojiButton>` adjacent to channel textarea inside `.message-input-container`.
- `public/locales/en/translation.json` (and other locale bundles) — add new i18n keys.
- `package.json` / `package-lock.json` — add `emoji-picker-react` dependency.

### Component contract

```ts
interface MessageEmojiButtonProps {
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  value: string;
  onChange: (next: string) => void;
}
```

The button is fully self-contained: it owns the open/close state of its popover and the picker's lazy import. Parent components only pass the textarea ref + current value + setter.

### Desktop detection

```ts
// useIsDesktop.ts
export function useIsDesktop(): boolean {
  const get = () => window.matchMedia('(pointer: fine)').matches;
  const [isDesktop, setIsDesktop] = useState(get);
  useEffect(() => {
    const mql = window.matchMedia('(pointer: fine)');
    const handler = () => setIsDesktop(mql.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);
  return isDesktop;
}
```

`(pointer: fine)` evaluates true for mouse / trackpad devices and false for touch-primary devices. More accurate than viewport width because users can resize a desktop browser narrow without losing mouse input.

### Lazy loading

```ts
const EmojiPicker = React.lazy(() => import('emoji-picker-react'));
```

Wrapped in `<Suspense fallback={null}>` inside the popover so the picker code is only fetched when the popover opens for the first time.

### Insertion logic

```ts
function insertAtCursor(emoji: string) {
  const ta = textareaRef.current;
  if (!ta) {
    onChange(value + emoji);
    return;
  }
  const start = ta.selectionStart ?? value.length;
  const end = ta.selectionEnd ?? value.length;
  const next = value.slice(0, start) + emoji + value.slice(end);
  onChange(next);
  // Restore cursor after React re-render
  requestAnimationFrame(() => {
    ta.focus();
    const pos = start + emoji.length;
    ta.setSelectionRange(pos, pos);
  });
}
```

Byte-count enforcement is already a controlled-input concern of the parent; updating `value` via `onChange` flows through existing limits naturally.

### Popover behaviour

- Opens above the textarea (not as a full modal — it's an inline picker, not a reaction overlay).
- Closes on:
  - Outside click (mousedown listener on document).
  - `Escape` keypress.
  - Selecting an emoji.
- Z-index: above existing `.message-input-container` controls but below global modals (uses an existing token from CSS variables — `--z-popover` if defined, else `1000` to match existing patterns).

### Styling

- Button matches the size and look of existing inline action buttons (`🔔`, `📍`) in `ChannelsTab.tsx`. CSS class `emoji-insert-button`.
- Picker uses `theme="dark" | "light"` prop driven by the project's existing theme context.

## Internationalization

New translation keys (initially English; other locales can be backfilled by the existing translation pipeline):

- `messages.insert_emoji_button_title` — "Insert emoji"
- `channels.insert_emoji_button_title` — "Insert emoji"

(Distinct from the existing `messages.emoji_button_title` / `channels.emoji_button_title` which describe the tapback react button.)

## Testing

### Unit tests (Vitest + Testing Library)

`src/components/MessageEmojiButton/MessageEmojiButton.test.tsx`:

- Renders the button when `useIsDesktop()` returns `true`.
- Renders nothing when `useIsDesktop()` returns `false`.
- Click toggles popover open/closed.
- Escape closes popover.
- Outside click closes popover.
- Selecting an emoji calls `onChange` with emoji inserted at cursor position.
- Cursor is repositioned after the inserted emoji.

`src/hooks/useIsDesktop.test.ts`:

- Returns initial value from `matchMedia`.
- Updates when the media query change event fires.

### Mocking

`emoji-picker-react` is mocked in `src/test/setup.ts` (or per-test) to a lightweight stub exposing `onEmojiClick` so tests don't depend on the full Unicode dataset.

`window.matchMedia` is already mocked in `src/test/setup.ts` — extend with `(pointer: fine)` cases.

## Accessibility

- Button has `aria-label` from the i18n key.
- `aria-expanded` reflects popover state.
- `aria-haspopup="dialog"`.
- Popover container has `role="dialog"` and `aria-label="Emoji picker"`.
- Focus moves into the picker's search box when the popover opens; returns to the trigger button on close.

## Risk / mitigations

| Risk | Mitigation |
|---|---|
| 280 KB picker bundle ships to users who never use it | Lazy-load via `React.lazy` + `<Suspense>`; only fetched on first button click. |
| Picker DOM clashes with existing `.emoji-picker-modal` reaction styles | Component scoped to `MessageEmojiButton.css`; no global selectors; class names prefixed with `emoji-insert-`. |
| Cursor restoration races with React reconciliation | `requestAnimationFrame` after `onChange`; verified in test. |
| Emoji insertion exceeds Meshtastic byte limit | Existing byte-count display + character limits on the textarea handle this; no new logic needed. |
| Mobile users with mouse plugged in see the desktop picker (correct behaviour, but worth flagging) | `(pointer: fine)` correctly returns `true` here; intended outcome. |

## Out-of-scope follow-ups

- Shortcode auto-replace (`:joy:` → 😂) — separate ticket if requested.
- Surfacing the user's tapback emoji set as a "frequents" tab inside the picker.
- Localization of `emoji-picker-react`'s built-in strings (it has its own i18n props).
