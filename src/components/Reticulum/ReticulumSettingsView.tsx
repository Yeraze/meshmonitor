/**
 * ReticulumSettingsView — thin per-source Settings tab for a Reticulum
 * source (#3960 Phase 1b WP5).
 *
 * Exactly one setting in Phase 1b: the destination-retention cap
 * (`reticulum_destinations_max`, `src/server/constants/settings.ts`). Unlike
 * most per-source settings in this codebase, this key is deliberately
 * **global** — `ReticulumRepository.getDestinationsMax()`
 * (`src/db/repositories/reticulum.ts`) reads it via
 * `settingsRepo.getSetting(key)` with no `sourceId`, and the prune it drives
 * (`pruneDestinations`) applies the same cap to every source's
 * `reticulum_destinations` table. So this view reads/writes
 * `GET`/`POST /api/settings` (no `?sourceId=`) — the generic global-settings
 * endpoint every other whole-instance knob in Settings uses (see
 * `DatabaseMaintenanceSection.tsx` for the identical
 * apiService.get/post('/api/settings', …) + `useSaveBar` pattern this
 * mirrors) — rather than the per-source `?sourceId=` variant. `sourceId` is
 * still accepted as a prop for interface parity with the other Reticulum
 * views (and in case a future phase adds a genuinely per-source knob here);
 * it is not part of the read/write path for this setting.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService, { ApiError } from '../../services/api';
import { useToast } from '../ToastContainer';
import { useAuth } from '../../contexts/AuthContext';
import { useSaveBar } from '../../hooks/useSaveBar';
import { logger } from '../../utils/logger';
import { UiIcon } from '../icons';
import styles from './ReticulumSettingsView.module.css';

interface ReticulumSettingsViewProps {
  /** Source UUID. Accepted for interface parity with the other Reticulum
   *  views; the one setting this view edits is global (see module doc). */
  sourceId: string;
}

const SETTING_KEY = 'reticulum_destinations_max';
/** Mirrors `DEFAULT_RETICULUM_DESTINATIONS_MAX` in
 *  `src/db/repositories/reticulum.ts` — kept as a local literal rather than
 *  a cross-layer import (frontend does not import server modules). */
const DEFAULT_DESTINATIONS_MAX = 2000;
const MIN_DESTINATIONS_MAX = 1;
const MAX_DESTINATIONS_MAX = 100000;

export const ReticulumSettingsView: React.FC<ReticulumSettingsViewProps> = ({ sourceId: _sourceId }) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('settings', 'write');

  const [value, setValue] = useState<number>(DEFAULT_DESTINATIONS_MAX);
  const [initial, setInitial] = useState<number>(DEFAULT_DESTINATIONS_MAX);
  const [loaded, setLoaded] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await apiService.get<Record<string, string>>('/api/settings');
        if (cancelled) return;
        const raw = settings?.[SETTING_KEY];
        const parsed = raw ? parseInt(raw, 10) : NaN;
        const resolved = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DESTINATIONS_MAX;
        setValue(resolved);
        setInitial(resolved);
      } catch (error) {
        if (!(error instanceof ApiError)) {
          logger.error('Failed to load reticulum_destinations_max:', error);
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const hasChanges = loaded && value !== initial;

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await apiService.post('/api/settings', { [SETTING_KEY]: String(value) });
      setInitial(value);
      showToast(t('reticulum.settings.saved', 'Settings saved'), 'success');
    } catch (error) {
      logger.error('Failed to save reticulum_destinations_max:', error);
      showToast(t('reticulum.settings.save_failed', 'Failed to save settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [value, showToast, t]);

  const handleDismiss = useCallback(() => {
    setValue(initial);
  }, [initial]);

  useSaveBar({
    id: 'reticulum-settings',
    sectionName: t('reticulum.settings.title', 'Reticulum Settings'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: handleDismiss,
  });

  return (
    <div className={styles.view} data-testid="reticulum-settings-view">
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <UiIcon name="database" size={16} />
          <span>{t('reticulum.settings.title', 'Reticulum Settings')}</span>
        </header>

        <div className={styles.field}>
          <label htmlFor="reticulumDestinationsMax">
            {t('reticulum.settings.destinations_max_label', 'Destination retention cap')}
          </label>
          <p className={styles.description}>
            {t(
              'reticulum.settings.destinations_max_description',
              'Maximum announced destinations kept per source. Once a source exceeds this, the oldest non-favorite destinations are pruned. Favorites are never pruned. This cap applies to every Reticulum source.',
            )}
          </p>
          <input
            id="reticulumDestinationsMax"
            type="number"
            value={value}
            min={MIN_DESTINATIONS_MAX}
            max={MAX_DESTINATIONS_MAX}
            disabled={!canWrite || !loaded}
            onChange={(e) => {
              const next = parseInt(e.target.value, 10);
              setValue(Number.isFinite(next) ? Math.max(MIN_DESTINATIONS_MAX, Math.min(MAX_DESTINATIONS_MAX, next)) : MIN_DESTINATIONS_MAX);
            }}
            className={styles.input}
          />
        </div>
      </section>
    </div>
  );
};

export default ReticulumSettingsView;
