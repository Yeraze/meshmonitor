import { useTranslation } from 'react-i18next';
import { describeError } from './describeError';
import styles from './AppErrorScreen.module.css';

export interface AppErrorScreenProps {
  /** Whatever reached the top of the tree. */
  error: unknown;
  /** Re-render the app without a page load. */
  onRetry: () => void;
}

/**
 * Last-resort page for an error no inner boundary caught.
 *
 * React removes the whole tree when a throw has no boundary above it, which
 * leaves `#root` empty: a blank page with no way back but a manual reload.
 * The per-tab boundaries in `App.tsx` do not cover every case. A throw from an
 * effect cleanup while a route unmounts is reported ABOVE the subtree being
 * removed, so it skips every boundary inside that route (this is how a map
 * teardown error once blanked the app).
 */
export function AppErrorScreen({ error, onRetry }: AppErrorScreenProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.screen} role="alert" data-testid="app-error-screen">
      <div className={styles.content}>
        <h1 className={styles.title}>{t('app_error.title', 'Something went wrong')}</h1>
        <p className={styles.body}>
          {t('app_error.body', 'MeshMonitor hit an error it could not recover from. Try again, or reload the page.')}
        </p>
        {error != null && (
          <details className={styles.details}>
            <summary>{t('app_error.details', 'Error details')}</summary>
            <pre>{describeError(error)}</pre>
          </details>
        )}
        <div className={styles.actions}>
          <button type="button" className={styles.primary} onClick={onRetry}>
            {t('app_error.retry', 'Try again')}
          </button>
          <button type="button" className={styles.secondary} onClick={() => window.location.reload()}>
            {t('app_error.reload', 'Reload page')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default AppErrorScreen;
