import type { CSSProperties } from 'react';

/**
 * The styles a dnd-kit drag activator needs before it works under a finger.
 *
 * Issue #5233: the Channels drag handle used dnd-kit exactly like its siblings
 * but omitted `touch-action: none`, and was the only reorder handle in the app
 * that did. Without it the browser claims the touch gesture for scrolling or
 * text selection before `PointerSensor` sees a single `pointermove`, so on iOS
 * Safari a long-press raised the selection UI over the handle and no drag ever
 * started. Desktop was unaffected, because a mouse never contends for the
 * gesture — which is why this shipped.
 *
 * Spread this into every activator's style rather than restating the
 * properties, so a new handle cannot quietly ship without them:
 *
 *   <div ref={setActivatorNodeRef} {...listeners} style={{ ...DRAG_HANDLE_TOUCH_STYLE, ... }}>
 *
 * The prefixed pair is not redundant with `userSelect`. Safari honored
 * unprefixed `user-select` only from 17.4, so older iOS needs
 * `-webkit-user-select`; and the iOS long-press callout has no unprefixed
 * property at all, only `-webkit-touch-callout`.
 */
export const DRAG_HANDLE_TOUCH_STYLE: CSSProperties = {
  touchAction: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTouchCallout: 'none',
};
