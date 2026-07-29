# Traceroute Strip Interactivity — Phase 1 Implementation Spec

**Epic:** `docs/internal/dev-notes/TRACEROUTE_STRIP_INTERACTIVITY_EPIC.md` (Phase 1)
**Extends:** `docs/internal/dev-notes/TRACEROUTE_VISUAL_STRIP_SPEC.md` (the shipped strip, #4381 / PR #4392)
**Branch:** `feature/traceroute-strip-interactivity` — worktree `/home/yeraze/Development/meshmonitor-trs-phase1`
**Scope:** frontend only. No DB, no migration, no API, no new route. `TracerouteStrip` stays a pure,
data-fetch-free component.

---

## 0. Confirmed decisions (settled — do not re-litigate)

1. **The popup becomes hover-interactive.** `pointer-events: auto` plus a linger delay on
   mouse-leave so the pointer can travel across the 8 px gap into the card.
2. **The action button is the existing `more-details` `NodeActions` kind**, with its existing
   label (`node_popup.more_details` = "More Details"). The epic prose says "Node Details"; the
   shipped label for this exact action on the map popup and the node list is "More Details", and
   a second name for one action is worse than a slightly different word. **No new label key.**
3. **Loading details = `setSelectedDMNode(nodeUserId)`.** No `setActiveTab` — the strip only
   renders on the Messages tab.
4. **Edge tooltips reuse the existing portal + reposition machinery**, retargeted from
   "hovered glyph" to "hovered target (glyph | edge)". They are not a second popup system.
5. **Edge hit-testing is an invisible widened-stroke polyline overlay**, not `<title>`, not a
   library.
6. **Distance renders only when both endpoints have `meta.pos`.** Absent → the row is omitted
   entirely (no empty item), matching the strip's existing "no SNR sample ⇒ no label element at
   all" convention.
7. **Keyboard reaches the action from the anchor, not by tabbing into the portal.** `Enter` /
   `Space` on a focused glyph fires the same callback the button fires. Rationale and rejected
   alternative in §4.4.
8. **`role="tooltip"` stays on the portal container.** See §4.5 for why, and what compensates.
9. **New i18n keys go into `public/locales/en.json` only**, always with an inline English default
   in the `t()` call. See §6 — this is the shipped convention, verified against the tree.

---

## 1. Reuse inventory (mandatory first read)

### 1.1 Must reuse — existing code this phase builds on

| Thing | Where | How Phase 1 uses it |
|---|---|---|
| `NodeActions` + `ACTION_META` | `src/components/map/popups/sections.tsx:447-521` | Renders the button. `more-details` already maps to `UiIcon name="search"` + `t('node_popup.more_details','More Details')` and the `.node-popup-btn` class. Pass `actions={[{ kind: 'more-details', onClick }]}`. **Do not hand-roll a `<button>`** — the icon, label, class and disabled handling all live there. |
| `NodeCard` | `src/components/map/popups/NodeCard.tsx` | Already the popup body. The button goes into the existing `sections` node, after `LastHeardFooter`. No `NodeCard` change. |
| `IdentityItems` / `SignalItems` / `PositionItem` / `LastHeardFooter` | `sections.tsx:68/115/194/218` | Unchanged. The edge tooltip copies their **markup convention** (`.node-popup-grid` > `.node-popup-item` > `.node-popup-icon` + `.node-popup-value`) rather than inventing a layout — see §5.3. |
| `UiIcon` | `src/components/icons/UiIcon.tsx` | All icons. Names that exist and are used here: `route`, `link`, `ruler`, `radioSignal`. **No emoji, no inline SVG** (CLAUDE.md hard rule). |
| Portal + `reposition` + scroll/resize listeners | `TracerouteStrip.tsx:118-205, 402-414` | Generalized, not duplicated. The portal exists precisely because `.node` carries a `transform` and `.scroller` clips overflow — an edge tooltip rendered inside `.canvas` would be clipped exactly the same way, so it MUST go through the same portal. |
| `calculateDistance`, `formatDistance` | `src/utils/distance.ts:13, 45` | Edge distance. `formatDistance(km, 'km' \| 'mi', decimals=1)`. |
| `'nm'` coercion precedent | `src/utils/traceroute.tsx:247-248`, `sections.tsx:132` | `formatDistance` accepts only `'km' \| 'mi'`; the strip's `distanceUnit` prop union is `'km' \| 'mi' \| 'nm'`. Coerce with `distanceUnit === 'mi' ? 'mi' : 'km'`. **Do not extend `formatDistance`** in this phase. (In practice `'nm'` cannot arrive today: `MessagesTabProps.distanceUnit` is `'mi' \| 'km'`. The coercion exists because the strip's own prop union is wider.) |
| `TracerouteStripNodeMeta.pos` | `TracerouteStrip.tsx:52`, built at `src/utils/tracerouteStripMeta.ts:80-83` | The only position source. Already `{ lat, lng } \| undefined`, already gated on both coordinates being non-null. |
| `paddedHexId` | `src/utils/tracerouteStrip.ts:66` | Fallback endpoint name for unknown hops — already imported by the component. |
| `styles.srOnly` | `TracerouteStrip.module.css:148-158` | The clip-based sr-only pattern is already in this module (used for the SNR lane caption). The edge tooltip's per-row labels reuse it verbatim. |
| Existing i18n keys | `en.json` | `messages.traceroute_leg_forward` ("Forward"), `messages.traceroute_leg_return` ("Return"), `messages.traceroute_hop_snr` ("{{snr}} dB"), `messages.traceroute_snr_unknown`, `messages.traceroute_unknown_node`, `messages.traceroute_node_label_separator` (", "), `node_popup.more_details`. |
| `MessagesTab` strip mount | `src/components/MessagesTab.tsx:1937-2009` (render), `740-754` (`recentTrace` + `tracerouteStrip` memo) | One new `useCallback` + one new prop on `<TracerouteStrip>`. Nothing else moves. |
| `setSelectedDMNode` prop | `MessagesTab.tsx:131` (`(nodeId: string) => void`), sourced from `MessagingContext` via `App.tsx` | The details-load mechanism. Precedent: `NodesTab.tsx:1152-1157` (`handlePopupDMClick`) and `1179-1190` (`handleNodeDetailsClick`). |
| Test files to extend | `src/components/traceroute/TracerouteStrip.test.tsx`, `src/components/MessagesTab.tracerouteStrip.test.tsx` | Extend; do not create parallel files. Both already have the harnesses needed (local `react-i18next` mock that honours default values, `makeMeta`, `nodeDivFor`, `renderTab`, `QueryClientProvider`). |

### 1.2 New surface, each justified against the closest existing mechanism

| New thing | Closest existing | Why new is justified |
|---|---|---|
| `TracerouteStripProps.onOpenNodeDetails?: (nodeUserId: string) => void` | Passing `setSelectedDMNode` straight in | An optional narrow callback keeps `TracerouteStrip` free of `MessagingContext`, of `DeviceInfo`, and of any knowledge of tabs — the purity constraint the shipped spec §4.3 exists to protect. Same shape as `NodeActionSpec.onClick`. |
| `TracerouteStripNodeMeta.userId?: string` | Reusing the existing `nodeId` field | `nodeId` is a **display** string: `node.user?.id \|\| paddedHexId(nodeNum)` (`tracerouteStripMeta.ts:70`). Feeding a synthesised `paddedHexId` into `setSelectedDMNode` would select a conversation key that `nodes.find(n => n.user?.id === selectedDMNode)` cannot match, opening an empty details panel. `userId` is populated **only** from `node.user?.id`, so `!!userId` is the exact, honest gate for "this action can work". |
| `HoverTarget` discriminated union replacing `HoverState` | Adding a parallel `edgeHover` state | Two independent hover states would need two portals, two `reposition` callbacks, two sets of scroll listeners, and a rule for what happens when both are set. One target with a `kind` tag keeps exactly one popup open at a time by construction. |
| `.edgeHit` polyline overlay | SVG `<title>`; a tooltip library | `<title>` gives a ~1 s native delay, no styling, no touch, no keyboard, and no way to render the 4-row grid. A library is a dependency for one tooltip. The widened-stroke overlay is ~6 lines of CSS and reuses the portal we already own. |
| Edge tooltip body (plain JSX in `TracerouteStrip.tsx`) | `NodeCard` | `NodeCard` is *node* chrome — it renders `NodeCardHeader` from a `NodeCardModel` (long name, short name, favourite state…). An edge is not a node and has no model. The body reuses the popup **CSS classes** (`.node-popup`, `.node-popup-content`, `.node-popup-grid`, `.node-popup-item`) so it looks identical, without pretending to be a node. |
| 5 i18n keys | Reusing existing ones | Listed in §6; each is genuinely new copy. Direction, SNR, separator and "Unknown" all reuse existing keys. |

### 1.3 Explicitly NOT touched

`src/styles/nodes.css` (frozen), `src/utils/tracerouteStrip.ts` (the pure graph/layout module — no
geometry change is needed; the hit target reuses `layout.edgePaths`), `src/utils/distance.ts`,
`NodeCard.tsx`, `sections.tsx`, `TracerouteBody`, `TracerouteHistoryModal`,
`RouteSegmentTraceroutesModal`, `TracerouteWidget`, every locale file except `en.json`.

---

## 2. File-by-file change list

```
MOD  src/components/traceroute/TracerouteStrip.tsx          (WP1 + WP2)
MOD  src/components/traceroute/TracerouteStrip.module.css   (WP1 + WP2)
MOD  src/components/traceroute/TracerouteStrip.test.tsx     (WP1 + WP2)
MOD  src/utils/tracerouteStripMeta.ts                       (WP1 — one field)
MOD  src/utils/tracerouteStripMeta.test.ts                  (WP1)
MOD  src/components/MessagesTab.tsx                         (WP1 — one callback + one prop)
MOD  src/components/MessagesTab.tracerouteStrip.test.tsx    (WP1)
MOD  public/locales/en.json                                 (WP2 — 5 keys)
MOD  docs/internal/dev-notes/TRACEROUTE_STRIP_INTERACTIVITY_EPIC.md (WP3 — tick exit criteria)
```

No new files.

---

## 3. `src/utils/tracerouteStripMeta.ts` (WP1)

One field, one line. Inside the `for (const stripNode of graph.nodes)` loop, after the existing
`const nodeId = node.user?.id || paddedHexId(nodeNum);`:

```ts
    // Display id vs. actionable id. `nodeId` falls back to a synthesised hex
    // string so the card always shows something; `userId` is present ONLY when
    // the node really has a user record, because it is what
    // `setSelectedDMNode` keys the details panel off
    // (MessagesTab: `nodes.find(n => n.user?.id === selectedDMNode)`).
    // A synthesised id there opens an empty panel.
    const userId = node.user?.id || undefined;
```

…and add `userId,` to the `meta.set(nodeNum, { … })` literal.

Type change in `TracerouteStrip.tsx`:

```ts
export interface TracerouteStripNodeMeta {
  // …unchanged fields…
  /** `node.user.id` when the node has a real user record, else undefined.
   *  Distinct from `nodeId`, which falls back to `paddedHexId`. Gates the
   *  "More Details" action: only a real user id can select a conversation. */
  userId?: string;
}
```

Optional, so every existing fixture in `TracerouteStrip.test.tsx` still type-checks.

---

## 4. `src/components/traceroute/TracerouteStrip.tsx`

### 4.1 Props

```ts
export interface TracerouteStripProps {
  graph: TracerouteStripGraph;
  meta: Map<number, TracerouteStripNodeMeta>;
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
  distanceUnit?: 'km' | 'mi' | 'nm';
  /** Load this node into the Node Details panel. When omitted (or when the
   *  hovered hop has no `meta.userId`) the popup renders no action button.
   *  Kept as a narrow callback so the strip stays a pure function of plain
   *  data — it never learns about MessagingContext, tabs, or DeviceInfo. */
  onOpenNodeDetails?: (nodeUserId: string) => void;
}
```

### 4.2 Hover state — one target, two kinds (WP1 introduces, WP2 extends)

Replace `HoverState` with:

```ts
interface HoverNodeTarget {
  kind: 'node';
  /** StripNode id — identifies the exact glyph, not just the nodeNum. */
  id: string;
  nodeNum: number;
  isPlaceholder: boolean;
  fallbackId: string;
  anchor: HTMLElement;
}

/** WP2. */
interface HoverEdgeTarget {
  kind: 'edge';
  /** StripEdge id (`${leg}:${fromId}>${toId}`). */
  id: string;
  edge: StripEdge;
  anchor: SVGPolylineElement;
}

type HoverTarget = HoverNodeTarget | HoverEdgeTarget;
```

`reposition` reads only `target.anchor.getBoundingClientRect()`, so it works unchanged for an
`SVGPolylineElement` (its rect is the segment's bounding box; the tooltip therefore centres over
the segment and prefers above, exactly like a glyph).

`aria-describedby` / the portal `id` continue to key off `target.id`, which stays unique across
kinds (`StripNode.id` is `${lane}-${col}-${nodeNum}`; `StripEdge.id` is `${leg}:${from}>${to}`).

### 4.3 Linger mechanics (WP1)

```ts
/** How long the popup survives after the pointer leaves the glyph, so the
 *  pointer can cross the POPUP_GAP into the card and press its button.
 *  Pointer only — blur, scroll-out and unmount still hide immediately. */
const HOVER_LINGER_MS = 180;
```

Three functions replace the single `hide`:

```ts
const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

const clearHideTimer = useCallback(() => {
  if (hideTimer.current !== null) {
    clearTimeout(hideTimer.current);
    hideTimer.current = null;
  }
}, []);

/** Immediate — keyboard blur, anchor scrolled out of view, action taken. */
const hideNow = useCallback(() => {
  clearHideTimer();
  setHover(null);
  setPopupPos(null);
}, [clearHideTimer]);

/** Pointer-leave — deferred, so travel into the popup can cancel it. */
const scheduleHide = useCallback(() => {
  clearHideTimer();
  hideTimer.current = setTimeout(() => {
    hideTimer.current = null;
    setHover(null);
    setPopupPos(null);
  }, HOVER_LINGER_MS);
}, [clearHideTimer]);
```

- `show(...)` calls `clearHideTimer()` first (re-entering the same glyph, or moving to a
  neighbouring one, must cancel a pending hide).
- Unmount cleanup: `useEffect(() => clearHideTimer, [clearHideTimer]);`
- `reposition`'s off-screen branch calls `hideNow()` (was `hide()`).
- Glyph handlers: `onMouseEnter={show}`, `onMouseLeave={scheduleHide}`, `onFocus={show}`,
  `onBlur={hideNow}`.
- Portal container handlers: `onMouseEnter={clearHideTimer}`, `onMouseLeave={scheduleHide}`.

**Regression note for the implementer:** three existing tests assert the popup is gone
*synchronously* after `fireEvent.mouseLeave`. They must be updated — see §7.1. Do not "fix" this
by making mouse-leave immediate.

### 4.4 The action button (WP1)

Inside the `hoverCard` memo's resolved-node branch, after `LastHeardFooter`:

```tsx
{onOpenNodeDetails && hovered.userId && (
  <NodeActions
    actions={[{
      kind: 'more-details',
      onClick: () => {
        const userId = hovered.userId!;
        // Dismiss FIRST: selecting a different node re-renders the strip for
        // that node's traceroute, which unmounts the anchor glyph this popup
        // is positioned against. A surviving popup would be anchored to a
        // detached element.
        hideNow();
        onOpenNodeDetails(userId);
      },
    }]}
  />
)}
```

Omission rules (all three must hold for the button to render):
1. `onOpenNodeDetails` was supplied,
2. the hop resolved to real metadata (`!hover.isPlaceholder` and `meta.has(nodeNum)` — already
   expressed by the `hovered` binding), and
3. `hovered.userId` is set.

The unknown-hop fallback card branch (`!hovered`) renders **no** `NodeActions` at all.

`hoverCard`'s dep array gains `onOpenNodeDetails` and `hideNow`.

**Keyboard path.** The glyph gains:

```tsx
role={canOpenDetails ? 'button' : undefined}
onKeyDown={canOpenDetails ? (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    hideNow();
    onOpenNodeDetails!(userId);
  }
} : undefined}
```

where `canOpenDetails = !!onOpenNodeDetails && !!nodeMeta?.userId`.

> **Decision & tradeoff (§0.7).** The popup is portalled to `document.body`, i.e. at the very end
> of document order, so `Tab` from a glyph never reaches the button — getting there would need a
> focus trap plus return-focus management for a single control. Instead the action is bound to the
> anchor itself: keyboard users press `Enter`/`Space` on the focused glyph and get exactly what the
> button does. `role="button"` (set only when the action exists) is what makes that discoverable to
> assistive tech. Glyphs without an available action stay unrolled, focusable description anchors.
> Rejected: roving focus into the portal (disproportionate); rendering the popup inline
> (re-introduces the `transform` + `overflow` clipping the portal exists to escape).

### 4.5 `role="tooltip"` stays

A `role="tooltip"` container holding a `<button>` is an ARIA smell. It is kept anyway because:

- ~10 existing assertions in `TracerouteStrip.test.tsx` query `[role="tooltip"]`, and one
  (line 354) asserts the popup is **not** inside a `[role="group"]` — switching the role to
  `group` would both break those and make that assertion self-contradictory;
- the button is not the only route to the action (§4.4), so no AT user is required to enter the
  tooltip to reach it. The tooltip stays a pure description for anyone navigating by keyboard.

Do not change the role in this phase.

### 4.6 Edge hit targets (WP2)

The `<svg className={styles.edges}>` is restructured so the decorative parts stay hidden while the
hit targets are exposed:

```tsx
<svg className={styles.edges} width={layout.width} height={layout.height}>
  <defs>{/* unchanged marker */}</defs>

  {/* Visible geometry — decorative; every fact it encodes is also carried by
      the node aria-labels, the SNR labels, and the per-edge hit targets. */}
  <g aria-hidden="true">
    {graph.edges.map(/* …unchanged polylines… */)}
  </g>

  {/* Interactive hit targets: an invisible, widened copy of each edge path,
      drawn last so it sits above the visible stroke. `.edges` keeps
      `pointer-events: none`; a descendant re-enabling its own
      `pointer-events` is hit-tested normally, so only these lines are. */}
  <g>
    {graph.edges.map((e) => {
      const path = layout.edgePaths.get(e.id);
      if (!path) return null;
      return (
        <polyline
          key={`hit-${e.id}`}
          className={styles.edgeHit}
          points={path.map((p) => `${p.x},${p.y}`).join(' ')}
          role="img"
          tabIndex={0}
          aria-label={edgeSummary(e)}
          aria-describedby={hover?.id === e.id ? `${uid}-tip-${e.id}` : undefined}
          onMouseEnter={(ev) => showEdge(e, ev.currentTarget)}
          onMouseLeave={scheduleHide}
          onFocus={(ev) => showEdge(e, ev.currentTarget)}
          onBlur={hideNow}
          onClick={(ev) => { ev.stopPropagation(); toggleEdge(e, ev.currentTarget); }}
        />
      );
    })}
  </g>
</svg>
```

Remove `aria-hidden="true"` and `focusable="false"` from the `<svg>` root (focusable descendants
inside an `aria-hidden` subtree are an accessibility error, and `focusable="false"` is a legacy
attribute that only ever muddies this).

**Tab order** becomes: every edge, then every glyph (SVG precedes the node `<div>`s in DOM order).
That is stable, predictable, and no worse than a hand-tuned order would be. Do not add
`tabindex` values above 0 to reorder it.

**Touch.** `onClick` on a hit target toggles its tooltip (`hover?.id === e.id ? hideNow() :
showEdge(...)`). Because hover never ends on a touch device, add a dismiss listener mounted only
while a target is open — same shape as the existing scroll/resize effect:

```ts
useEffect(() => {
  if (!hover) return;
  const onDown = (ev: PointerEvent) => {
    const t = ev.target as Element | null;
    if (t?.closest?.(`.${styles.edgeHit}`)) return;      // handled by onClick
    if (popupRef.current?.contains(t as Node)) return;   // clicking inside the card
    hideNow();
  };
  document.addEventListener('pointerdown', onDown, true);
  return () => document.removeEventListener('pointerdown', onDown, true);
}, [hover, hideNow]);
```

### 4.7 Edge tooltip content (WP2)

Helpers, all inside the component (they need `meta`, `t`, and the layout):

```ts
/** StripNode.id -> StripNode, so an edge's endpoints resolve to nodeNums. */
const nodeById = useMemo(
  () => new Map(graph.nodes.map((n) => [n.id, n])),
  [graph],
);

/** Same name shape the glyph shows: "Long Name (SHRT)", or the short name
 *  alone, or the unknown placeholder + padded hex for an unresolved hop. */
const displayNameForNodeId = useCallback((stripNodeId: string): string => { … }, [nodeById, meta, t]);

/** km between two endpoints, or null when either lacks a position fix. */
const edgeDistanceKm = useCallback((e: StripEdge): number | null => {
  const from = meta.get(nodeById.get(e.fromId)?.nodeNum ?? -1)?.pos;
  const to = meta.get(nodeById.get(e.toId)?.nodeNum ?? -1)?.pos;
  if (!from || !to) return null;
  return calculateDistance(from.lat, from.lng, to.lat, to.lng);
}, [meta, nodeById]);
```

Unit coercion, once, at component scope:

```ts
// `formatDistance` accepts only 'km' | 'mi'; 'nm' falls back to metric, the
// same coercion src/utils/traceroute.tsx:248 and sections.tsx:132 already make.
const formatUnit: 'km' | 'mi' = distanceUnit === 'mi' ? 'mi' : 'km';
```

SNR text (identical formatting to the existing labels — `snrDecimals = 1`):

```ts
const edgeSnrText = (e: StripEdge): string =>
  e.snrUnknown
    ? t('messages.traceroute_snr_unknown', 'Unknown SNR (MQTT-bridged hop, decrypt failure, or old firmware)')
    : e.snr !== null
      ? t('messages.traceroute_hop_snr', '{{snr}} dB', { snr: e.snr.toFixed(1) })
      : null;
```

Rendered body, portalled through the same container:

```tsx
<div className="node-popup">
  <div className="node-popup-content">
    <div className="node-popup-grid">
      <div className="node-popup-item node-popup-item-full">
        <span className="node-popup-icon"><UiIcon name="route" /></span>
        <span className={styles.srOnly}>{t('messages.traceroute_edge_direction_label','Direction')}: </span>
        <span className="node-popup-value">{directionCaption}</span>
      </div>
      <div className="node-popup-item node-popup-item-full">
        <span className="node-popup-icon"><UiIcon name="link" /></span>
        <span className={styles.srOnly}>{t('messages.traceroute_edge_endpoints_label','Endpoints')}: </span>
        <span className="node-popup-value">
          {t('messages.traceroute_edge_endpoints', '{{from}} → {{to}}', { from, to })}
        </span>
      </div>
      {km !== null && (
        <div className="node-popup-item node-popup-item-full">
          <span className="node-popup-icon"><UiIcon name="ruler" /></span>
          <span className={styles.srOnly}>{t('messages.traceroute_edge_distance_label','Distance')}: </span>
          <span className="node-popup-value">{formatDistance(km, formatUnit, 1)}</span>
        </div>
      )}
      {snrText && (
        <div className="node-popup-item node-popup-item-full">
          <span className="node-popup-icon"><UiIcon name="radioSignal" /></span>
          <span className={styles.srOnly}>{t('messages.traceroute_edge_snr_label','Signal')}: </span>
          <span className="node-popup-value">{snrText}</span>
        </div>
      )}
    </div>
  </div>
</div>
```

- `directionCaption` = the existing `forwardLegCaption` / `returnLegCaption` bindings
  (`messages.traceroute_leg_forward` / `_return`) — already computed in the component.
- Distance and SNR rows are **omitted entirely** when absent — no empty item, matching the
  existing SNR-label convention and keeping the DOM assertable.
- `edgeSummary(e)` (the polyline's `aria-label`) is the same four fragments joined with the
  existing `messages.traceroute_node_label_separator` (`", "`), skipping absent ones — the same
  "join only present segments, no dangling comma" rule the glyph `accessibleName` already uses.

The portal container gains a modifier so only the *node* popup is interactive:

```tsx
className={cx(
  styles.hoverPopup,
  popupPos && styles.hoverPopupReady,
  hover.kind === 'edge' && styles.hoverPopupInert,
)}
```

---

## 5. `TracerouteStrip.module.css`

### 5.1 WP1

```css
.hoverPopup {
  position: fixed;
  z-index: 10002;
  /* Interactive since #TRS-phase1: the card carries a "More Details" button,
   * so the pointer must be able to travel into it. HOVER_LINGER_MS in the
   * component is what makes crossing the POPUP_GAP possible. */
  pointer-events: auto;
  opacity: 0;
  transition: opacity 0.12s ease;
}
```

(Replaces the `pointer-events: none` + "non-interactive by design" comment. Update the comment —
a stale rationale is worse than none.)

### 5.2 WP2

```css
/* Edge tooltips are descriptions, never surfaces to click into: they must not
 * steal the pointer from the hit target underneath them. */
.hoverPopupInert {
  pointer-events: auto;      /* keep the linger-cancel working on desktop */
}
```

> Implementer note: keep `pointer-events: auto` here too. The tooltip is placed with the same
> `POPUP_GAP` above the segment, so it does not overlap its own hit target, and leaving it
> hoverable means moving the pointer onto it does not flicker the tooltip away. `.hoverPopupInert`
> is therefore a **content/role** hook (no button inside, `role="tooltip"` semantics) rather than a
> pointer-events switch — name it `.hoverPopupEdge` if that reads better, but keep an assertable
> class either way.

```css
/* Invisible, widened copy of each edge path. `.edges` keeps
 * `pointer-events: none`; a descendant that sets its own `pointer-events` is
 * still hit-tested, so ONLY these lines are interactive — the visible strokes
 * and the arrowheads stay inert. */
.edgeHit {
  fill: none;
  stroke: transparent;
  stroke-width: 14;
  stroke-linecap: round;
  stroke-linejoin: round;
  pointer-events: stroke;
  cursor: help;
}

.edgeHit:focus-visible {
  stroke: var(--ctp-blue);
  stroke-width: 3;
  outline: none;
}
```

The focus style paints the *edge itself* blue rather than drawing an outline box around the
segment's bounding rect (which for a diagonal edge would be a large, misleading rectangle).

Nothing else in the file changes. `src/styles/nodes.css` is not touched.

---

## 6. i18n

**Convention, verified against the tree:** `public/locales/*.json` are **flat, dot-separated keys**
at the top level (`"messages.traceroute_leg_forward": "Forward"`), not nested objects. New keys go
into **`en.json` only** — the nine other locales are translated out of band and currently lack
every key the shipped strip added in PR #4392 (`messages.traceroute_strip_label`,
`_leg_forward`, `_leg_return`, `_hop_snr`, `_snr_unknown`, `_unknown_node`,
`_node_label_separator` are all absent from `de/es/fr/nb_NO/pl/pt_BR/ru/sv/zh_Hans`). Every `t()`
call therefore **must** pass an inline English default, which is what makes the other locales
degrade gracefully. There is no locale-parity test to satisfy.

Add to `public/locales/en.json` (WP2 — WP1 adds none, it reuses `node_popup.more_details`):

```json
"messages.traceroute_edge_endpoints": "{{from}} → {{to}}",
"messages.traceroute_edge_direction_label": "Direction",
"messages.traceroute_edge_endpoints_label": "Endpoints",
"messages.traceroute_edge_distance_label": "Distance",
"messages.traceroute_edge_snr_label": "Signal"
```

Insert them adjacent to the existing `messages.traceroute_*` block so the file stays grouped.

---

## 7. `MessagesTab.tsx` wiring (WP1)

At component scope, next to the existing `tracerouteStrip` memo (~line 745):

```ts
/** Load a hop from the traceroute strip into the Node Details panel.
 *  No `setActiveTab`: the strip only ever renders on the Messages tab, so the
 *  destination is already on screen. Mirrors NodesTab's `handlePopupDMClick`
 *  (NodesTab.tsx:1152) minus the tab switch. */
const handleStripNodeDetails = useCallback((nodeUserId: string) => {
  setSelectedDMNode(nodeUserId);
}, [setSelectedDMNode]);
```

And at the render site (~line 1967):

```tsx
<TracerouteStrip
  graph={stripGraph}
  meta={stripMeta}
  timeFormat={timeFormat}
  dateFormat={dateFormat}
  distanceUnit={distanceUnit}
  onOpenNodeDetails={handleStripNodeDetails}
/>
```

No other change. `distanceUnit` already flows (`MessagesTabProps.distanceUnit: 'mi' | 'km'`).

---

## 8. Test plan

Standard Vitest suite only (`jsdom`). Extend the existing files; add no new test file.

### 8.1 Pre-existing tests that MUST be updated (WP1 — do this first, they will fail otherwise)

In `src/components/traceroute/TracerouteStrip.test.tsx`, the linger delay breaks every
"mouse-leave then assert gone synchronously" assertion:

| Test | Line | Fix |
|---|---|---|
| `portals the hover popup to document.body…` | 356-357 | Wrap in `vi.useFakeTimers()` and `act(() => vi.advanceTimersByTime(HOVER_LINGER_MS))` before the null assertion — or switch that leg to `fireEvent.blur` where a keyboard path is equally valid. Prefer the timer version: it is the behaviour under test. |
| `removes its scroll/resize listeners when the popup hides` | ~689+ | Same treatment for whichever dismissal it uses. |
| `wires aria-describedby…` | 386-387 | Uses `fireEvent.blur` → hides immediately → **unchanged**. Confirm it still passes rather than editing it. |
| `hides when the anchor scrolls out of view…` | 665-667 | Goes through `reposition` → `hideNow()` → **unchanged**. Confirm. |

Timer hygiene: `vi.useRealTimers()` in an `afterEach`, and wrap timer advances in `act()` so React
flushes the state update.

### 8.2 New cases — `TracerouteStrip.test.tsx` (WP1)

1. **Popup survives the linger window.** `mouseEnter(glyph)` → `mouseLeave(glyph)` →
   advance `HOVER_LINGER_MS - 1` → `[role="tooltip"]` still present. Advance past → gone.
2. **Travel into the popup cancels the hide.** `mouseEnter(glyph)` → `mouseLeave(glyph)` →
   `mouseEnter(popup)` → advance well past the delay → popup still present. Then
   `mouseLeave(popup)` → advance → gone.
3. **`.hoverPopup` is not `pointer-events: none`.** Assert the class is applied and, since jsdom
   does not compute module CSS, assert via the class-name hook (`popup.className` contains the
   hashed `hoverPopup` class). Keep this cheap — the real check is (2).
4. **Button renders for a resolved node with a `userId`.** `getByRole('button', { name: /More Details/ })`
   inside the portal (the local `t` mock returns the English default).
5. **Button omitted when `onOpenNodeDetails` is not passed.** No button in the popup.
6. **Button omitted for an unknown/placeholder hop.** Use the existing "node missing from meta"
   fixture (line 521) — the fallback card renders no button.
7. **Button omitted when `meta.userId` is undefined** even though the node resolved (meta present,
   `userId` absent). Guards the exact bug the field exists to prevent.
8. **Callback fires with the right id and dismisses the popup.**
   `onOpenNodeDetails` spy → click the button → `toHaveBeenCalledWith('!00000064')` (or whatever
   the fixture's `userId` is), **and** `[role="tooltip"]` is null afterwards.
9. **Keyboard: `Enter` on a focused glyph fires the callback**; so does `Space`; and the glyph
   carries `role="button"` only when the action is available (assert `getAttribute('role')` is
   null on a placeholder glyph / when the prop is absent).
10. **No timer leak:** unmounting while a hide is pending does not throw (`unmount()` then
    `vi.advanceTimersByTime`, expect no "state update on unmounted component" warning/throw).

### 8.3 New cases — `TracerouteStrip.test.tsx` (WP2)

11. **One hit target per edge**, with the same `points` as the visible polyline for that edge, and
    the visible group is `aria-hidden`.
12. **Edge tooltip content, distance present.** Two endpoints with `pos`; hover the hit target;
    assert the portal contains the direction caption ("Forward"), `"From Node (FRM) → Target Node (TGT)"`,
    the formatted distance, and `"3.5 dB"`.
13. **Distance absent** when either endpoint lacks `pos` — assert the distance row is not rendered
    (query by the `Distance` sr-only label, expect null), while direction/endpoints/SNR still are.
14. **Unit switching.** Same fixture rendered with `distanceUnit="km"` then `"mi"`; assert the two
    formatted strings differ and match `formatDistance(km, 'km'|'mi', 1)` computed from
    `calculateDistance` on the fixture coordinates. Do **not** hardcode a magic number.
15. **`'nm'` coerces to km** — `distanceUnit="nm"` renders the same string as `"km"`.
16. **Return-leg edge shows "Return"**, forward shows "Forward".
17. **Unknown-SNR edge** shows the `traceroute_snr_unknown` text; an edge with `snr === null &&
    !snrUnknown` renders no SNR row at all.
18. **Unknown endpoint** falls back to the placeholder name + padded hex in the endpoints row.
19. **Accessibility:** each hit target has `tabIndex=0`, `role="img"`, and an `aria-label`
    containing direction, both endpoint names and the SNR, joined without a dangling separator when
    distance is absent.
20. **Focus opens the tooltip and blur closes it immediately** (no linger on the keyboard path);
    `aria-describedby` is wired only while shown.
21. **Click toggles** (touch path): `click(hit)` → tooltip shown; `click(hit)` again → hidden.
22. **`pointerdown` outside dismisses**: `click(hit)` → `document.dispatchEvent(new PointerEvent('pointerdown', …))`
    on `document.body` → tooltip gone. (jsdom needs a `PointerEvent` shim check — fall back to
    `MouseEvent`-typed dispatch on the `pointerdown` type if `PointerEvent` is unavailable.)
23. **Only one popup at a time**: hover a glyph, then a hit target → exactly one `[role="tooltip"]`
    in the document.

### 8.4 `src/utils/tracerouteStripMeta.test.ts` (WP1)

24. `userId` is `node.user.id` when present.
25. `userId` is `undefined` when the node has no `user.id`, while `nodeId` still falls back to the
    padded hex — the two fields must not be conflated.

### 8.5 `src/components/MessagesTab.tracerouteStrip.test.tsx` (WP1)

26. **`onOpenNodeDetails` reaches the strip**: render with `ROUTED_TRACE` plus a `nodes` array
    containing the hop, hover a glyph, click "More Details", assert the `setSelectedDMNode` spy was
    called with that node's `user.id`.
27. **No `setActiveTab` call** accompanies it (the prop is a `noop` spy in the harness — assert it
    was not called), locking in decision §0.3.

### 8.6 Whole-suite gates

- `npx vitest run` — full suite, 0 failures. Confirm `success: true` via the JSON reporter, not the
  summary line (rtk's `PASS (N) FAIL (0)` counts assertions, not suites).
- `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` — must be empty.
  New effects/callbacks need **complete** `react-hooks/exhaustive-deps` arrays; that rule is an
  error frozen at a per-file baseline, so one new violation in `TracerouteStrip.tsx` fails CI even
  though `npx eslint` on the file reports nothing new.
- `npx tsc --noEmit`.

---

## 9. Work packages

```
WP1 ──► WP2 ──► WP3
```

**Strictly sequential.** WP1 and WP2 both rewrite the hover-state block, the portal container and
the same test file; running them in parallel guarantees conflicts. This is also the repo's known
`rtk`-wrapped-`git commit` hazard (auto-stages the whole tree — parallel agents in one worktree
sweep up each other's files). One agent at a time in this worktree; commit with the pathspec form
(`git commit -- <files>`) and audit the per-commit file list.

### WP1 — Interactive popup + "More Details" action + MessagesTab wiring

Files: `TracerouteStrip.tsx`, `TracerouteStrip.module.css`, `TracerouteStrip.test.tsx`,
`tracerouteStripMeta.ts`, `tracerouteStripMeta.test.ts`, `MessagesTab.tsx`,
`MessagesTab.tracerouteStrip.test.tsx`.

Work: §3, §4.1-§4.5, §5.1, §7. Fix the pre-existing tests in §8.1 **before** adding new ones.

Acceptance:
- [ ] `HoverState` → `HoverTarget` union landed with the `'node'` variant only (WP2 adds `'edge'`);
      `hideNow` / `scheduleHide` / `clearHideTimer` in place; timer cleared on unmount.
- [ ] `.hoverPopup` is `pointer-events: auto` with an updated rationale comment (no stale
      "non-interactive by design").
- [ ] Pointer can travel glyph → popup and press the button (§8.2 case 2).
- [ ] `more-details` button renders via `NodeActions` — not a hand-rolled `<button>` — and is
      omitted for placeholder hops, for nodes without `userId`, and when the prop is absent.
- [ ] Clicking it calls `onOpenNodeDetails(userId)` **and** dismisses the popup.
- [ ] `Enter`/`Space` on a focused glyph does the same; `role="button"` set only when available.
- [ ] `MessagesTab` passes `onOpenNodeDetails`; no `setActiveTab`.
- [ ] §8.1 pre-existing tests updated and green; §8.2 and §8.4-§8.5 cases added; full suite green;
      `lint:ci` clean.

### WP2 — Edge tooltips

Files: `TracerouteStrip.tsx`, `TracerouteStrip.module.css`, `TracerouteStrip.test.tsx`,
`public/locales/en.json`.

Work: §4.2 (`'edge'` variant), §4.6, §4.7, §5.2, §6.

Acceptance:
- [ ] One `.edgeHit` polyline per edge, geometry from `layout.edgePaths` (no new layout math in
      `tracerouteStrip.ts`).
- [ ] `<svg>` root no longer `aria-hidden`; visible polylines wrapped in `<g aria-hidden="true">`;
      no focusable element sits inside an `aria-hidden` subtree.
- [ ] Tooltip shows direction / endpoints / distance / SNR, reusing the `.node-popup-*` classes and
      `UiIcon` (`route`, `link`, `ruler`, `radioSignal`).
- [ ] Distance rendered **only** when both endpoints have `meta.pos`; unit honours `distanceUnit`
      with `'nm' → 'km'` coercion; SNR uses the existing 1-decimal convention and the existing
      unknown-SNR key.
- [ ] Hover, focus (with immediate blur-close) and tap-toggle all work; outside `pointerdown`
      dismisses.
- [ ] 5 new keys in `en.json` only, every `t()` call carrying an inline English default.
- [ ] §8.3 cases added; full suite green; `lint:ci` clean.

### WP3 — Verification, live validation, epic bookkeeping

Files: `docs/internal/dev-notes/TRACEROUTE_STRIP_INTERACTIVITY_EPIC.md` (+ any fix-ups the
validation turns up).

Work:
- Full `npx vitest run` confirmed via the JSON reporter (`success: true`), `tsc --noEmit`,
  `lint:ci` filtered for in-repo failures.
- Deploy the branch to the dev container from **this worktree** with `--no-cache`, including
  `-f docker-compose.dev.local.yml` and the three gitignored files copied from the primary
  checkout, then verify the running bundle is this branch before testing.
- Browser-validate at `http://localhost:8080/meshmonitor` with a node that has a real traceroute:
  hover a glyph, cross into the popup, click **More Details**, confirm the details panel swaps;
  hover forward and return edges and confirm direction / endpoints / distance / SNR; confirm the
  distance row disappears for a hop pair where one end has no position; toggle the
  distance-unit setting and confirm the tooltip follows. **Use real mouse movement**
  (`page.mouse` / `elementFromPoint`), not synthetic `dispatchEvent` — synthetic events bypass hit
  testing and would not exercise the widened-stroke target at all.
- Tick the Phase 1 exit criteria in the epic plan and append to its Log.

Acceptance:
- [ ] All four automated gates green.
- [ ] Every browser check above observed and reported (with a screenshot of an open edge tooltip).
- [ ] Epic plan updated; ready for `/create-pr`.

---

## 10. Risks for the orchestrator

1. **The linger delay breaks shipped tests.** §8.1. Highest-probability CI failure in this phase.
   WP1 must fix those first, before adding anything.
2. **`aria-hidden` + focusable descendants.** If WP2 adds `tabIndex` to the hit targets without
   restructuring the `<svg>`'s `aria-hidden`, the result is an accessibility defect that no test
   will catch. §4.6 is explicit; verify it in review.
3. **Popup anchored to a detached glyph.** Clicking "More Details" re-renders the strip for a
   different node. `hideNow()` must run before the callback (§4.4). Symptom if missed: a stale card
   frozen on screen.
4. **`userId` vs `nodeId`.** Wiring `setSelectedDMNode(nodeId)` "works" for every node that has a
   user record and silently opens an empty panel for those that do not. §3 and case 7 exist solely
   for this.
5. **`pointer-events` on a descendant of a `pointer-events: none` parent.** The design depends on
   `.edgeHit` re-enabling hit-testing under `.edges { pointer-events: none }`. This is correct per
   spec and works in every current browser, but jsdom does not model it — case 11 asserts the DOM
   shape, and WP3's live check is what actually proves it.
6. **Tab-order growth.** N edges become tab stops ahead of N nodes. Acceptable and documented
   (§4.6); if a reviewer objects, the fallback is `tabIndex={-1}` on the hit targets plus keeping
   the keyboard story entirely on the glyphs — but then edge information is unreachable by
   keyboard, which is worse.
7. **`nodes.css` and the global sheets stay frozen.** Every new style belongs in the CSS module.
