import { useState, type ReactNode } from 'react';
import { UiIcon } from '../icons';
import { useIsMobileViewport } from '../../hooks/useIsMobileViewport';
import './MapSidebar.css';

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
 * - Mobile (≤768px, handled in CSS): the open panel takes over the viewport as
 *   a full-screen sheet; the same toggle dismisses it back to the ☰ button.
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
  const isMobile = useIsMobileViewport();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored !== null) return stored === 'true';
    } catch {
      /* storage unavailable — fall through to the viewport default */
    }
    // No saved preference: mobile starts collapsed (the open panel is a
    // full-screen sheet over the map), desktop starts expanded (#4909).
    return isMobile;
  });

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
