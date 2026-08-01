/**
 * SourceNav — the one navigation primitive shared by every per-source view
 * (issue #4473).
 *
 * Meshtastic sources and MeshCore sources used to ship two independently-built
 * navs — `Sidebar` (icon-only rail) and `MeshCoreSubToolbar` (bottom bar with
 * labels). They didn't share a design, so a fix to one never reached the other;
 * the phone bottom bar in particular crushed 11 items to ~35px each and
 * ellipsised every label down to a few characters.
 *
 * This component owns the *presentation* only. Each consumer keeps its own item
 * list, permission gating, state ownership and routing model — Meshtastic's nav
 * is app-level and routed, MeshCore's is view-local `useState`, and unifying
 * those is deliberately out of scope here.
 *
 * Layout hooks for tests are stable `data-*` attributes, not class names: the
 * styling lives in a CSS module whose class names are hashed at build time.
 */
import React from 'react';
import { UiIcon, type UiIconName } from '../icons';
import styles from './SourceNav.module.css';

export interface SourceNavItem {
  /** Stable id — compared against `activeId` to mark the active entry. */
  id: string;
  label: string;
  icon: UiIconName;
  onClick: () => void;
  /** Renders a red unread dot on the icon (#3891). */
  unread?: boolean;
}

export interface SourceNavSection {
  /** Rendered as a section header when expanded; omit for an unlabelled group. */
  title?: string;
  items: SourceNavItem[];
}

export interface SourceNavProps {
  sections: SourceNavSection[];
  activeId: string;
  /** Icon-only rail (desktop) / compact (mobile). */
  collapsed: boolean;
  /**
   * How the nav presents itself below the 768px breakpoint.
   * - `bottom-bar`: horizontal, bottom-docked, scrolls sideways with readable
   *   labels. Items size to their content instead of being split evenly, which
   *   is what made labels unreadable before.
   * - `rail`: stays a vertical left rail.
   *
   * Meshtastic is still `rail` because the whole app layout keys off
   * `--sidebar-width`; moving it to `bottom-bar` is follow-up work.
   */
  mobileVariant?: 'bottom-bar' | 'rail';
  /** Slot above the nav (Meshtastic's logo/app-name block). */
  header?: React.ReactNode;
  /** Slot below the nav, above the footer (pin/collapse controls). */
  controls?: React.ReactNode;
  /** Slot pinned to the bottom (SidebarFooter). */
  footer?: React.ReactNode;
  /**
   * When provided and `controls` is not, renders the built-in collapse toggle.
   * Consumers with their own control cluster pass `controls` instead.
   */
  onToggleCollapsed?: () => void;
  collapseLabel?: string;
  expandLabel?: string;
  /** Extra class on the root, for consumer-specific positioning. */
  className?: string;
  ariaLabel?: string;
}

export const SourceNav: React.FC<SourceNavProps> = ({
  sections,
  activeId,
  collapsed,
  mobileVariant = 'bottom-bar',
  header,
  controls,
  footer,
  onToggleCollapsed,
  collapseLabel = 'Collapse',
  expandLabel = 'Expand',
  className,
  ariaLabel,
}) => {
  const rootClasses = [
    styles.nav,
    collapsed ? styles.collapsed : styles.expanded,
    mobileVariant === 'bottom-bar' ? styles.mobileBottomBar : styles.mobileRail,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <aside
      className={rootClasses}
      data-source-nav=""
      data-collapsed={collapsed ? 'true' : 'false'}
      data-mobile-variant={mobileVariant}
      aria-label={ariaLabel}
    >
      {header}

      <nav className={styles.list}>
        {sections.map((section, index) => (
          <React.Fragment key={section.title ?? `section-${index}`}>
            {section.title && !collapsed && (
              <div className={styles.sectionHeader} data-source-nav-section-header="">
                {section.title}
              </div>
            )}
            <div className={styles.section} data-source-nav-section="">
              {section.items.map(item => {
                const isActive = item.id === activeId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`${styles.item} ${isActive ? styles.active : ''}`}
                    data-source-nav-item={item.id}
                    data-active={isActive ? 'true' : 'false'}
                    aria-current={isActive ? 'page' : undefined}
                    onClick={item.onClick}
                    // Collapsed rails show no text, so the tooltip is the only
                    // affordance naming the destination.
                    title={collapsed ? item.label : undefined}
                  >
                    <span className={styles.icon} data-source-nav-icon="">
                      <UiIcon name={item.icon} size={20} />
                      {item.unread && (
                        <span
                          className={styles.unreadDot}
                          data-source-nav-unread=""
                          aria-hidden="true"
                        />
                      )}
                    </span>
                    <span className={styles.label} data-source-nav-label="">
                      {item.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </React.Fragment>
        ))}
      </nav>

      {controls ?? (onToggleCollapsed && (
        <div className={styles.controls}>
          <button
            type="button"
            className={styles.toggle}
            data-source-nav-toggle=""
            onClick={onToggleCollapsed}
            title={collapsed ? expandLabel : collapseLabel}
            aria-label={collapsed ? expandLabel : collapseLabel}
          >
            <UiIcon name={collapsed ? 'forward' : 'back'} size={18} />
          </button>
        </div>
      ))}

      {footer}
    </aside>
  );
};

export default SourceNav;
