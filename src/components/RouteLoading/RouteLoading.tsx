import styles from './RouteLoading.module.css';

/**
 * Full-viewport placeholder shown while a lazily loaded page chunk (or the
 * i18n bundle) is in flight. Plain text on purpose: it renders as a Suspense
 * fallback, possibly before i18n has loaded, so it must not call
 * `useTranslation()` (which would itself suspend).
 */
export default function RouteLoading() {
  return (
    <div className={styles.routeLoading} role="status">
      Loading…
    </div>
  );
}
