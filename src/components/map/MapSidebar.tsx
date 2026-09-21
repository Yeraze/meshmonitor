import { useEffect, useState, type ReactNode } from 'react';
import { UiIcon } from '../icons';
import { useIsMobileLayoutViewport } from '../../hooks/useIsMobileViewport';
import './MapSidebar.css';

/**
 * Root-element marker set while any map-controls panel is expanded (#5291).
 *
 * The panel cannot hide the collapsed node-list arrow by z-index: that arrow
 * lives outside `.map-container`, which is a stacking context at `z-index: 1`,
 * so the panel's own 1001 is trapped below it however high it goes. The marker
 * lets a rule on a shared ancestor hide the arrow instead, and CSS keeps
 * ownership of *when* — only the full-sheet breakpoint hides it, not the
 * landscape half-sheet, which does not cover that corner.
 */
export const MAP_SHEET_OPEN_CLASS = 'mm-map-sheet-open';

/**
 * Counted, not a boolean: the Dashboard renders its own MapSidebar, so two can
 * be mounted at once and the first to close would otherwise clear the marker
 * out from under the other.
 */
let openSheetCount = 0;

/**
 * Unified, collapsible map controls sidebar (#4909).
 *
 * Replaces the independently-floating map panels (Hops legend, Features
 * checklist, Tileset picker) that overlapped each other and the map. Consumers
 * pass those panels as children; this shell stacks them in a single scrollable,
 * right-edge column with one collapse toggle.
 *
 * - Desktop: a right-edge panel; the toggle collapses it to a small ☰ button,
 *   with the collapsed state persisted per `storageKey`.
 * - Mobile portrait (≤768px wide, handled in CSS): the open panel takes over
 *   the map pane as a full sheet; the same toggle dismisses it to the ☰ button.
 * - Mobile landscape (≤500px tall, handled in CSS): a full-height right-edge
 *   sheet capped at 60% of the pane, so the map the controls act on stays
 *   visible. Both orientations start collapsed (#5060).
 *
 * Presentational only — it owns layout/collapse, not the controls' content.
 */
export interface MapSidebarProps {
  children: ReactNode;
  /** localStorage key for the collapsed state (per surface, so views are independent). */
  storageKey?: string;
  /** Accessible label / header text. */
  title?: string;
}

export function MapSidebar({
  children,
  storageKey = 'mm-map-sidebar-collapsed',
  title = 'Map controls',
}: MapSidebarProps) {
  // The shell's mobile definition, not the width-only one: a landscape phone is
  // 844px wide, so the width test alone left the panel open over the map on
  // every rotated phone — the JS half of #5060.
  const isMobile = useIsMobileLayoutViewport();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored !== null) return stored === 'true';
    } catch {
      /* storage unavailable — fall through to the viewport default */
    }
    // No saved preference: mobile starts collapsed (the open panel covers most
    // of the map), desktop starts expanded (#4909).
    return isMobile;
  });

  useEffect(() => {
    if (collapsed) return;
    const root = document.documentElement;
    openSheetCount += 1;
    root.classList.add(MAP_SHEET_OPEN_CLASS);
    return () => {
      openSheetCount -= 1;
      if (openSheetCount <= 0) {
        openSheetCount = 0;
        root.classList.remove(MAP_SHEET_OPEN_CLASS);
      }
    };
  }, [collapsed]);

  const toggle = () =>
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(storageKey, String(next));
      } catch {
        /* storage unavailable (private mode) — collapse still works in-memory */
      }
      return next;
    });

  if (collapsed) {
    return (
      <button
        type="button"
        className="map-sidebar-toggle"
        onClick={toggle}
        title={`Show ${title}`}
        aria-label={`Show ${title}`}
        aria-expanded={false}
      >
        <UiIcon name="menu" size={18} />
      </button>
    );
  }

  return (
    <aside className="map-sidebar" role="region" aria-label={title}>
      <div className="map-sidebar-header">
        <span className="map-sidebar-title">{title}</span>
        <button
          type="button"
          className="map-sidebar-collapse-btn"
          onClick={toggle}
          title={`Hide ${title}`}
          aria-label={`Hide ${title}`}
          aria-expanded={true}
        >
          <UiIcon name="close" size={16} />
        </button>
      </div>
      <div className="map-sidebar-body">{children}</div>
    </aside>
  );
}

export default MapSidebar;
