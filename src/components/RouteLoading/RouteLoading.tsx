import styles from './RouteLoading.module.css';

interface RouteLoadingProps {
  /**
   * `page` (default) fills the viewport, for a whole page in flight. `pane`
   * fills only the content area, for a lazy tab inside a page already drawn.
   */
  variant?: 'page' | 'pane';
}

/**
 * Placeholder shown while a lazily loaded page or tab chunk (or the i18n
 * bundle) is in flight. Plain text on purpose: it renders as a Suspense
 * fallback, possibly before i18n has loaded, so it must not call
 * `useTranslation()` (which would itself suspend).
 */
export default function RouteLoading({ variant = 'page' }: RouteLoadingProps = {}) {
  const className = variant === 'pane' ? `${styles.routeLoading} ${styles.pane}` : styles.routeLoading;
  return (
    <div className={className} role="status">
      Loading…
    </div>
  );
}
