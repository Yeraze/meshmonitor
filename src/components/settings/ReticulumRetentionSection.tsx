/**
 * ReticulumRetentionSection — the Reticulum destination retention cap, on the
 * Global Settings page (`SettingsTab mode="global"`).
 *
 * The cap (`reticulum_destinations_max`, `src/server/constants/settings.ts`)
 * is global: `ReticulumRepository.getDestinationsMax()`
 * (`src/db/repositories/reticulum.ts`) reads it with no `sourceId`, and the
 * prune it drives applies the same cap to every source's
 * `reticulum_destinations` rows. It used to sit on each Reticulum source's
 * own Settings page, which made one install-wide number look per-source
 * (#5683 follow-up). The read and the write are unchanged:
 * `GET`/`POST /api/settings` with no `?sourceId=`, the same
 * apiService + `useSaveBar` pattern as `DatabaseMaintenanceSection.tsx`.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService, { ApiError } from '../../services/api';
import { useToast } from '../ToastContainer';
import { useAuth } from '../../contexts/AuthContext';
import { useSaveBar } from '../../hooks/useSaveBar';
import { logger } from '../../utils/logger';
import { UiIcon } from '../icons';
import styles from './ReticulumRetentionSection.module.css';
import { NumberInput } from '../common/NumberInput';
import { NumberInputScope } from '../common/NumberInputScope';
import { useNumberInputScope } from '../common/numberInputScopeContext';

/** The section's id: the Global Settings nav chip and `#settings-reticulum` deep links. */
export const RETICULUM_SETTINGS_SECTION_ID = 'settings-reticulum';

const SETTING_KEY = 'reticulum_destinations_max';
/** Mirrors `DEFAULT_RETICULUM_DESTINATIONS_MAX` in
 *  `src/db/repositories/reticulum.ts` — kept as a local literal rather than
 *  a cross-layer import (frontend does not import server modules). */
const DEFAULT_DESTINATIONS_MAX = 2000;
const MIN_DESTINATIONS_MAX = 1;
const MAX_DESTINATIONS_MAX = 100000;

export const ReticulumRetentionSection: React.FC = () => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  // The key is global, so a write grant on any source saves it: the same
  // union the server applies to the unscoped `POST /api/settings`.
  const canWrite = hasPermission('settings', 'write', { anySource: true });

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

  const numberScope = useNumberInputScope();
  useSaveBar({
    numberScope,
    id: 'reticulum-settings',
    sectionName: t('reticulum.settings.title', 'Reticulum Settings'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: handleDismiss,
  });

  return (
    <NumberInputScope scope={numberScope}>
    <div
      id={RETICULUM_SETTINGS_SECTION_ID}
      className="settings-section"
      data-testid="reticulum-retention-section"
    >
      <h3 className={styles.heading}>
        <UiIcon name="database" size={16} />
        <span>{t('reticulum.settings.title', 'Reticulum Settings')}</span>
      </h3>

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
        <NumberInput
          id="reticulumDestinationsMax"
          value={value}
          min={MIN_DESTINATIONS_MAX}
          max={MAX_DESTINATIONS_MAX}
          integer
          disabled={!canWrite || !loaded}
          onChange={setValue}
          className={styles.input}
        />
      </div>
    </div>
    </NumberInputScope>
  );
};

export default ReticulumRetentionSection;
