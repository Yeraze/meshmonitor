# Polar Grid Overlay Plan Review

**Plan:** `docs/superpowers/plans/2026-03-21-polar-grid-overlay-plan.md`
**Spec:** `docs/superpowers/specs/2026-03-21-polar-grid-overlay-design.md`
**Reviewer:** Code Review Agent
**Date:** 2026-03-21

## Summary

The plan is well-structured and closely follows codebase conventions. It correctly mirrors the existing `showAccuracyRegions` pattern for state, persistence, and UI integration. Below are findings organized by severity.

---

## Critical Issues (must fix before execution)

### 1. Checkbox insertion location will break layout

The plan says to insert the polar grid checkbox "after the Show Accuracy Regions checkbox (~line 1746)." However, examining the actual code at lines 1745-1760, the Accuracy Regions checkbox is immediately followed by a **conditional** Packet Monitor toggle wrapped in `{canViewPacketMonitor && packetLogEnabled && (...)}`, then `</>` closing a fragment, then `)}` closing another conditional, then `</div>` tags. Inserting a new `<label>` after line 1745 would place it correctly, but the plan's line reference (~1746) points to the `</label>` closing tag. The agent must insert **before** the Packet Monitor conditional block (before line 1748), not after line 1746, or the JSX structure will break.

**Recommendation:** Change Task 5 Step 4 to say "insert before the `{canViewPacketMonitor && packetLogEnabled` block (~line 1748)" and verify the JSX nesting is preserved.

### 2. Test mocks for PolarGridOverlay are incomplete -- missing `selectedTileset` and `customOverlayScheme`

The `useSettings` mock in Task 4 Step 1 returns only `{ distanceUnit: 'km' }`. However, the component implementation (Task 4 Step 3) destructures `{ distanceUnit, selectedTileset, customOverlayScheme }` from `useSettings()`. If the mock does not provide `selectedTileset`, the call `getSchemeForTileset(selectedTileset || 'osm', customOverlayScheme)` will work due to the `|| 'osm'` fallback, so this will not cause a runtime test failure. However, for test clarity and to avoid fragile implicit behavior, the mock should include these properties.

**Recommendation:** Update the `useSettings` mock to:
```typescript
useSettings: () => ({ distanceUnit: 'km' as const, selectedTileset: 'osm', customOverlayScheme: undefined }),
```

---

## Important Issues (should fix)

### 3. Spec requires i18n; Task 5 uses hardcoded strings that Task 6 retroactively fixes

Task 5 Step 4 adds the checkbox with hardcoded `"Show Polar Grid"` and `"Requires own node position"` strings. Task 6 then retroactively replaces them with `t()` calls. This means the Task 5 commit introduces untranslated strings that violate the spec's i18n requirement.

**Recommendation:** Combine Tasks 5 and 6, or have Task 5 use `t()` calls from the start (the `t` function and `useTranslation` are already imported in NodesTab).

### 4. `ownNodePosition` scoping requires care

Task 5 Step 3 derives `ownNodePosition` from `homeNode`. The `homeNode` variable is defined at line 1366 inside a render callback (IIFE within `shouldShowData()`). The checkbox toggle (~line 1746) and MapContainer render (~line 2019) are also inside this IIFE, so scoping is technically correct. However, the plan should explicitly note this scoping constraint so the agent does not accidentally place the variable outside the IIFE.

### 5. `getSectorEndpoint` tests use a separate import statement

Task 1 Step 5 says "Append to `src/utils/polarGrid.test.ts`" with a new `import { getSectorEndpoint }` line. This creates a duplicate import from the same module. The agent should consolidate into the existing import at the top of the file.

---

## Suggestions (nice to have)

### 6. No test for zoom-change behavior

The component test mocks `useMap` with a static zoom of 13 and `map.on`/`map.off` as no-ops. There is no test verifying that the `zoomend` event handler updates rings. Consider adding a test that captures the `zoomend` callback and invokes it.

### 7. Spec testing section is empty

The spec's `## Testing` section has no content after the header. The plan compensates well with tests in Tasks 1 and 4, but the spec should be updated to document the testing strategy.

---

## Spec Coverage Assessment

| Spec Requirement | Plan Task | Status |
|-----------------|-----------|--------|
| `showPolarGrid` toggle in MapContext | Task 3 | COVERED |
| Persistence via map-preferences (not VALID_SETTINGS_KEYS) | Task 3 Step 3 | COVERED |
| Theme-aware colors in overlayColors.ts | Task 2 | COVERED |
| Auto-scale ring logic by zoom | Task 1 | COVERED |
| 4-6 range rings | Task 1 + Task 4 | COVERED |
| 12 sector lines at 30-degree intervals | Task 4 | COVERED |
| Cardinal directions use brighter color | Task 4 | COVERED |
| Distance labels along north axis | Task 4 | COVERED |
| Degree labels at outer ring | Task 4 | COVERED |
| Disabled checkbox when no position | Task 5 Step 4 | COVERED |
| Follow distanceUnit setting (km/mi) | Task 1 | COVERED |
| i18n translation keys | Task 6 | COVERED |
| Edge case: no position | Task 5 | COVERED |
| Edge case: node moves | React reactivity | COVERED |
| Performance: ~36 DOM elements max | Architecture | COVERED |

## Task Ordering Assessment

The dependency chain is correct:
- Tasks 1 (utility), 2 (colors), 3 (MapContext) have no inter-dependencies and could run in parallel.
- Task 4 (component) correctly depends on Tasks 1 and 2.
- Task 5 (integration) correctly depends on Tasks 3 and 4.
- Task 6 (i18n) depends on Task 5.
- Task 7 (verification) depends on all.

No circular or missing dependencies detected.

## Line Number Accuracy Spot-Check

| Plan Reference | Actual Code | Accurate? |
|---------------|-------------|-----------|
| MapContextType interface ~line 56 | Lines 56-57 (showAccuracyRegions) | YES |
| State declaration ~line 102 | Line 102 (showAccuracyRegions useState) | YES |
| Setter useCallback ~line 176 | Lines 174-176 (setShowAccuracyRegions) | YES |
| Preference loading ~line 273 | Lines 268-272 (showAccuracyRegions loading) | YES |
| Context value ~line 339 | Lines 338-339 | YES |
| NodesTab destructure ~line 244 | Lines 261-262 (showAccuracyRegions) | OFF by ~17 lines |
| homeNode ~line 1366 | Line 1366 | YES |
| Checkbox ~line 1746 | Line 1745 (span text) | YES, but see Critical #1 |
| MapContainer render ~line 2077 | Line 2019 (showAccuracyRegions block) | OFF by ~58 lines |

**Note:** The NodesTab line references for the destructure (~244 vs actual ~261) and MapContainer render (~2077 vs actual ~2019) are noticeably off. The agent should use pattern matching rather than line numbers.

---

## Verdict

**APPROVE WITH MINOR FIXES.** The plan is thorough, follows codebase patterns accurately, and covers all spec requirements. Address Critical #1 (checkbox insertion point) and Critical #2 (test mock completeness) before execution. The remaining items are improvements that the implementing agent can handle during execution.
