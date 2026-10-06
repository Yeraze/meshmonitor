/**
 * SourceNavLayout — the body row of an in-flow per-source page: a
 * {@link SourceNav} beside its content pane on desktop, and above a docked
 * bottom bar on phones.
 *
 * MeshCorePage and ReticulumPage both render this, so the phone flip lives in
 * one stylesheet (`SourceNavLayout.module.css`) and a new source type cannot
 * ship without it. Reticulum did: it had its own copy of the row with no
 * mobile rule, and the bottom bar filled the screen.
 */
import React from 'react';
import styles from './SourceNavLayout.module.css';

export interface SourceNavLayoutProps {
  /** The page's SourceNav (e.g. `MeshCoreSubToolbar`). Rendered first. */
  nav: React.ReactNode;
  /** The current view. */
  children: React.ReactNode;
  /** Extra class for the row. */
  className?: string;
  /** Extra class for the content pane — how it scrolls is the page's call. */
  contentClassName?: string;
}

const join = (...names: Array<string | undefined>) => names.filter(Boolean).join(' ');

export const SourceNavLayout: React.FC<SourceNavLayoutProps> = ({
  nav,
  children,
  className,
  contentClassName,
}) => (
  <div className={join(styles.body, className)} data-source-nav-layout="">
    {nav}
    <div className={join(styles.content, contentClassName)} data-source-nav-content="">
      {children}
    </div>
  </div>
);

export default SourceNavLayout;
