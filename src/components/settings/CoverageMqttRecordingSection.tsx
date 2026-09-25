import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import apiService from '../../services/api';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../ToastContainer';
import { UiIcon } from '../icons';
import Modal from '../common/Modal';
import { COVERAGE_MQTT_ENABLED_SETTING, isCoverageMqttFlagOn } from '../../utils/coverage';
import styles from './CoverageMqttRecordingSection.module.css';

/**
 * Splits a confirm message into paragraphs on blank lines, dropping a
 * trailing "Continue?" line. That line read naturally as the last sentence
 * of a `window.confirm()` prompt; it is redundant once a real "Turn on
 * recording" button replaces the browser dialog (#5277 P4a WP6). The two
 * message keys themselves stay unchanged so their text is shared with any
 * other surface that still quotes them verbatim.
 */
function splitConfirmParagraphs(text: string): string[] {
  const paragraphs = text
    .split('\n\n')
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  if (paragraphs.length > 0 && paragraphs[paragraphs.length - 1] === 'Continue?') {
    paragraphs.pop();
  }
  return paragraphs;
}

interface CoverageMqttRecordingSectionProps {
  /** App base URL (appBasename), as every other self-saving section takes it. */
  baseUrl: string;
  /** Source UUID — scopes GET/POST to /api/settings?sourceId=<id>. */
  sourceId: string;
  /** Whether the current user may change this setting. */
  canWrite: boolean;
  /**
   * The source's `type` — selects the copy. `meshcore_mqtt` (a MeshCore
   * Observer feed, #5277 P3 WP4) gets its own label/warning/confirm text;
   * `mqtt_broker`/`mqtt_bridge` keep the P2 MQTT-gateway copy unchanged.
   */
  sourceType: string | null | undefined;
}

/**
 * Coverage Report → per-source reception-recording toggle.
 *
 * Two callers, one flag: MQTT gateway receptions (#5277 P2 WP3, spec §2.8)
 * on `mqtt_broker`/`mqtt_bridge` sources, or MeshCore observer receptions
 * (#5277 P3 WP4, spec §2.7) on a `meshcore_mqtt` source. Both reuse the same
 * per-source `coverage_mqtt_enabled` flag, cache and invalidation — only the
 * displayed copy differs by `sourceType`.
 *
 * A self-saving section — the MeshCore receive-only pattern
 * (`MeshCoreSettingsView`/`MeshCoreNodeDisplaySection`) — rather than a
 * `SettingsDraft` field: `SettingsTab`'s save routes every non-Node-Display
 * key to the GLOBAL endpoint even in source mode (spec D6), and joining that
 * partition is out of scope here. This reads and writes
 * `/api/settings?sourceId=<id>` directly and saves on change.
 *
 * Shown only on MQTT-shaped sources — see the `isCoverageMqttSourceType`
 * gate in `configSections.ts` and the render guard in `SettingsTab.tsx`.
 */
export const CoverageMqttRecordingSection: React.FC<CoverageMqttRecordingSectionProps> = ({
  baseUrl,
  sourceId,
  canWrite,
  sourceType,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  // MeshCore Observer feeds (#5277 P3 WP4) get their own copy — the row
  // volume there is unmeasured, so the warning must never quote the P2
  // MQTT-gateway numbers.
  const isObserver = sourceType === 'meshcore_mqtt';

  // null = not yet loaded. Fail closed on a read error: recording nothing is
  // the safe side, matching the server-side cache (coverageMqttSettings.ts).
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  // Enabling is the direction that grows the database (spec U1), so it is
  // gated behind a styled confirm dialog quoting the same warning text as
  // below. Disabling is always safe and needs no confirm.
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setEnabled(null);
    void (async () => {
      try {
        const data = await apiService.get<Record<string, string>>(
          `/api/settings?sourceId=${encodeURIComponent(sourceId)}`,
        );
        if (!cancelled) setEnabled(isCoverageMqttFlagOn(data[COVERAGE_MQTT_ENABLED_SETTING]));
      } catch {
        if (!cancelled) setEnabled(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sourceId]);

  const confirmMessage = isObserver
    ? t(
      'settings.coverage_observer_enable_confirm',
      'Record MeshCore observer receptions for the Coverage Report?\n\n' +
      'Each observer that hears a MeshCore advert with a position adds one row, and many ' +
      'observers can hear one advert over several paths. We have not measured how many rows a ' +
      'MeshCore region feed produces; watch your database size after turning this on. Rows are ' +
      'kept for the Coverage retention period, a global setting under Settings → Coverage Report.\n\n' +
      'Continue?',
    )
    : t(
      'settings.coverage_mqtt_enable_confirm',
      'Record MQTT gateway receptions for the Coverage Report?\n\n' +
      'Each gateway that hears a position packet adds one row. A regional feed adds about ' +
      '12,000–14,000 rows a day: about 90,000–100,000 rows (35–50 MB) over a 7-day retention. ' +
      'A world-wide msh/# feed can reach about 1 million rows a day and several GB a week. ' +
      'Rows are kept for the Coverage retention period, a global setting under Settings → Coverage Report.\n\n' +
      'Continue?',
    );

  const performSave = useCallback(async (next: boolean) => {
    setSaving(true);
    try {
      const res = await csrfFetch(
        `${baseUrl}/api/settings?sourceId=${encodeURIComponent(sourceId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [COVERAGE_MQTT_ENABLED_SETTING]: next ? '1' : '0' }),
        },
      );
      if (!res.ok) {
        showToast(
          t(
            isObserver ? 'settings.coverage_observer_save_failed' : 'settings.coverage_mqtt_save_failed',
            isObserver ? 'Failed to change MeshCore observer recording' : 'Failed to change MQTT gateway recording',
          ),
          'error',
        );
        return;
      }
      setEnabled(next);
      // Lets an open Coverage Report refresh its receivers/mqttSources
      // status without waiting for the next mount or manual Refresh click.
      await queryClient.invalidateQueries({ queryKey: ['analysis', 'coverageReport', 'receivers'] });
      showToast(
        isObserver
          ? t(
            next ? 'settings.coverage_observer_saved_on' : 'settings.coverage_observer_saved_off',
            next
              ? 'MeshCore observer recording enabled for the Coverage Report'
              : 'MeshCore observer recording disabled',
          )
          : t(
            next ? 'settings.coverage_mqtt_saved_on' : 'settings.coverage_mqtt_saved_off',
            next
              ? 'MQTT gateway recording enabled for the Coverage Report'
              : 'MQTT gateway recording disabled',
          ),
        'success',
      );
    } catch {
      showToast(
        t(
          isObserver ? 'settings.coverage_observer_save_failed' : 'settings.coverage_mqtt_save_failed',
          isObserver ? 'Failed to change MeshCore observer recording' : 'Failed to change MQTT gateway recording',
        ),
        'error',
      );
    } finally {
      setSaving(false);
    }
  }, [baseUrl, sourceId, csrfFetch, queryClient, showToast, t, isObserver]);

  const handleToggle = useCallback((next: boolean) => {
    if (next) {
      // Enabling opens the styled confirm dialog instead of saving right
      // away; the checkbox stays reflecting `enabled` (still off) until the
      // user confirms.
      setConfirmOpen(true);
      return;
    }
    void performSave(false);
  }, [performSave]);

  const handleCancelEnable = useCallback(() => {
    setConfirmOpen(false);
  }, []);

  const handleConfirmEnable = useCallback(() => {
    setConfirmOpen(false);
    void performSave(true);
  }, [performSave]);

  return (
    <div id="settings-coverage-mqtt" className="settings-section">
      <h3>{t('settings.coverage_mqtt_section', 'Coverage recording')}</h3>

      <div className={`setting-item ${styles.toggleRow}`}>
        <label className={styles.toggleLabel}>
          <input
            type="checkbox"
            checked={enabled ?? false}
            disabled={!canWrite || saving || enabled === null}
            onChange={(e) => handleToggle(e.target.checked)}
          />
          <span>
            {isObserver
              ? t('settings.coverage_observer_toggle_label', 'Record MeshCore observer receptions for the Coverage Report')
              : t('settings.coverage_mqtt_toggle_label', 'Record MQTT gateway receptions for the Coverage Report')}
          </span>
        </label>

        <p className={styles.warning}>
          <UiIcon name="alert" size={14} className={styles.warningIcon} />
          <span>
            <Trans
              i18nKey={isObserver ? 'settings.coverage_observer_warning' : 'settings.coverage_mqtt_warning'}
              components={{ link: <Link to="/settings#settings-coverage" className={styles.link} /> }}
            />
          </span>
        </p>

        <p className="setting-description">
          {isObserver
            ? t(
              'settings.coverage_observer_note',
              'Only adverts that carry a position and a valid signature are recorded. Rows start from when you turn this on.',
            )
            : t(
              'settings.coverage_mqtt_note',
              'Nodes that turn off "OK to MQTT" are not uplinked by gateways on public brokers, so they won\'t appear. Rows only start from when you turn this on.',
            )}
        </p>
      </div>

      <Modal
        isOpen={confirmOpen}
        onClose={handleCancelEnable}
        title={t('settings.coverage_enable_confirm_title', 'Turn on coverage recording?')}
        className={styles.confirmDialog}
      >
        {splitConfirmParagraphs(confirmMessage).map((paragraph, idx) => (
          <p key={idx} className={styles.confirmParagraph}>{paragraph}</p>
        ))}
        <div className={styles.actions}>
          <button type="button" className={styles.secondaryButton} onClick={handleCancelEnable}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={handleConfirmEnable}
            disabled={saving}
          >
            {t('settings.coverage_enable_confirm_ok', 'Turn on recording')}
          </button>
        </div>
      </Modal>
    </div>
  );
};

export default CoverageMqttRecordingSection;
