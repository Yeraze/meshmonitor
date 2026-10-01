/**
 * MeshCoreContactSyncSection (#5502).
 *
 * A MeshCore companion keeps its OWN contact list, separate from the nodes
 * MeshMonitor tracks. The radio can only log in to, poll, or message nodes in
 * that list. Two things put them out of step: auto-add turned off on the radio
 * (it then stores no node it hears), and eviction when the list fills up.
 *
 * This section shows the radio's auto-add state with a toggle, warns when
 * MeshMonitor favourites are missing from the radio, and offers "Push to
 * radio": fill the radio's free slots with MeshMonitor's nodes, favourites
 * first. Both are local writes over the serial/TCP link; nothing is sent over
 * the air. The push never replaces a contact already on the radio.
 *
 * Lives in MeshCore Settings, next to the other device settings. The per-node
 * "Not in the radio's contact list" notice points here.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { parseJsonResponse } from '../../utils/parseJsonResponse';
import { UiIcon } from '../icons';
import styles from './MeshCoreContactSyncSection.module.css';

interface SyncStatus {
  available: boolean;
  manualAddContacts: number | null;
  autoAddEnabled: boolean | null;
  missingFavorites: Array<{ publicKey: string; name: string | null }>;
  deviceContactCount: number;
  deviceContactsKnown?: boolean;
}

interface PushResult {
  added: Array<{ publicKey: string; name: string | null }>;
  alreadyOnDevice: number;
  skipped: Array<{ publicKey: string; name: string | null; reason: 'ignored' | 'unknown_type' | 'failed' }>;
  notAddedNoRoom: number;
  evicted: string[];
  capacityKnown: boolean;
  maxContacts: number | null;
  freeSlotsBefore: number | null;
  freeSlotsAfter: number | null;
  error?: string;
}

interface MeshCoreContactSyncSectionProps {
  baseUrl: string;
  sourceId: string;
  connected: boolean;
  /** configuration:write — may change the auto-add device setting. */
  canEditConfig: boolean;
  /** nodes:write — may push contacts to the radio. */
  canEditNodes: boolean;
}

export const MeshCoreContactSyncSection: React.FC<MeshCoreContactSyncSectionProps> = ({
  baseUrl,
  sourceId,
  connected,
  canEditConfig,
  canEditNodes,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const prefix = `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/meshcore`;
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [savingAutoAdd, setSavingAutoAdd] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState<PushResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await csrfFetch(`${prefix}/contacts/device-sync`);
      const body = await parseJsonResponse(res);
      if (body?.success && body.data) setStatus(body.data as SyncStatus);
    } catch {
      // Leave the last known status; the section stays usable.
    }
  }, [csrfFetch, prefix]);

  useEffect(() => {
    if (connected) void loadStatus();
  }, [connected, loadStatus]);

  const handleToggleAutoAdd = async (enabled: boolean) => {
    setSavingAutoAdd(true);
    setError(null);
    try {
      const res = await csrfFetch(`${prefix}/config/auto-add-contacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const body = await parseJsonResponse(res);
      if (!body?.success) {
        setError(body?.error || t('meshcore.contact_sync.auto_add_failed', 'Could not change the auto-add setting.'));
        return;
      }
      await loadStatus();
    } catch {
      setError(t('meshcore.contact_sync.auto_add_failed', 'Could not change the auto-add setting.'));
    } finally {
      setSavingAutoAdd(false);
    }
  };

  const handlePush = async () => {
    setPushing(true);
    setError(null);
    setPushResult(null);
    try {
      const res = await csrfFetch(`${prefix}/contacts/push-to-device`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await parseJsonResponse(res);
      if (!body?.success) {
        setError(body?.error || t('meshcore.contact_sync.push_failed', 'Could not push contacts to the radio.'));
        return;
      }
      setPushResult(body.data as PushResult);
      await loadStatus();
    } catch {
      setError(t('meshcore.contact_sync.push_failed', 'Could not push contacts to the radio.'));
    } finally {
      setPushing(false);
    }
  };

  const autoAdd = status?.autoAddEnabled ?? null;
  const missing = status?.missingFavorites.length ?? 0;
  const skippedBy = (reason: PushResult['skipped'][number]['reason']) =>
    pushResult?.skipped.filter((s) => s.reason === reason).length ?? 0;

  return (
    <div className="form-section" data-testid="meshcore-contact-sync">
      <h3>{t('meshcore.contact_sync.title', 'Radio contact list')}</h3>
      <p className="hint">
        {t(
          'meshcore.contact_sync.hint',
          'The radio keeps its own contact list, separate from the nodes MeshMonitor tracks. It can only log in to, poll, or message nodes in that list.',
        )}
      </p>

      <div className={styles.row}>
        <span className={styles.label}>{t('meshcore.contact_sync.auto_add_label', 'Auto-add contacts')}:</span>
        <span className={styles.value} data-testid="meshcore-auto-add-state">
          {autoAdd === null
            ? t('meshcore.contact_sync.unknown', 'Unknown')
            : autoAdd
              ? t('meshcore.contact_sync.on', 'On')
              : t('meshcore.contact_sync.off', 'Off')}
        </span>
        {canEditConfig && autoAdd !== null && (
          <button
            type="button"
            onClick={() => void handleToggleAutoAdd(!autoAdd)}
            disabled={!connected || savingAutoAdd}
          >
            {savingAutoAdd
              ? t('common.saving', 'Saving…')
              : autoAdd
                ? t('meshcore.contact_sync.turn_off', 'Turn off')
                : t('meshcore.contact_sync.turn_on', 'Turn on')}
          </button>
        )}
      </div>
      <p className="hint">
        {t(
          'meshcore.contact_sync.auto_add_hint',
          'On: the radio saves every node it hears advertising. Off: it keeps only contacts added by hand, and MeshMonitor cannot log in to or poll nodes missing from the radio. Changing this writes a setting to the radio; nothing is transmitted.',
        )}
      </p>

      {status && status.deviceContactsKnown === false && (
        <p className="hint" data-testid="meshcore-device-contacts-unknown">
          {t(
            'meshcore.contact_sync.device_list_unknown',
            "The radio's contact list hasn't been read since it connected, so MeshMonitor can't tell yet which nodes it holds. Push to radio still checks the radio first.",
          )}
        </p>
      )}

      {missing > 0 && (
        <div className={styles.banner} role="status" data-testid="meshcore-missing-favorites">
          <div className={styles.bannerHeading}>
            <UiIcon name="alert" size={16} />
            {t('meshcore.contact_sync.missing_favorites', {
              count: missing,
              defaultValue: "{{count}} favourite(s) are not in the radio's contact list",
            })}
          </div>
          {autoAdd === false && (
            <p className={styles.bannerBody}>
              {t(
                'meshcore.contact_sync.auto_add_off_explain',
                'Auto-add contacts is off on this radio, so nodes heard via advert are not saved to it. MeshMonitor cannot log in to or poll contacts the radio does not hold. Turn auto-add on, or push MeshMonitor contacts to the radio.',
              )}
            </p>
          )}
        </div>
      )}

      {canEditNodes && (
        <div className={styles.actions}>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void handlePush()}
            disabled={!connected || pushing}
            title={t('meshcore.contact_sync.push_tooltip', 'Store MeshMonitor nodes in the radio (no radio transmission)')}
          >
            <UiIcon name="uploadData" size={14} />{' '}
            {pushing
              ? t('meshcore.contact_sync.pushing', 'Pushing…')
              : t('meshcore.contact_sync.push_button', 'Push to radio')}
          </button>
          <span className={styles.subtle}>
            {t(
              'meshcore.contact_sync.push_hint',
              'Adds favourites first, then the most recently heard nodes, into free slots only. Nothing on the radio is replaced.',
            )}
          </span>
        </div>
      )}

      {error && <p className={styles.error} role="alert">{error}</p>}

      {pushResult && (
        <ul className={styles.result} data-testid="meshcore-push-result">
          <li>{t('meshcore.contact_sync.result_added', { count: pushResult.added.length, defaultValue: 'Added: {{count}}' })}</li>
          <li>{t('meshcore.contact_sync.result_already', { count: pushResult.alreadyOnDevice, defaultValue: 'Already on the radio: {{count}}' })}</li>
          {pushResult.notAddedNoRoom > 0 && (
            <li>{t('meshcore.contact_sync.result_no_room', { count: pushResult.notAddedNoRoom, defaultValue: 'Not added, no free slot: {{count}}' })}</li>
          )}
          {skippedBy('unknown_type') > 0 && (
            <li>{t('meshcore.contact_sync.result_unknown_type', { count: skippedBy('unknown_type'), defaultValue: 'Skipped, type not known yet: {{count}}' })}</li>
          )}
          {skippedBy('ignored') > 0 && (
            <li>{t('meshcore.contact_sync.result_ignored', { count: skippedBy('ignored'), defaultValue: 'Skipped, ignored or blocked: {{count}}' })}</li>
          )}
          {skippedBy('failed') > 0 && (
            <li>{t('meshcore.contact_sync.result_failed', { count: skippedBy('failed'), defaultValue: 'Failed: {{count}}' })}</li>
          )}
          {pushResult.capacityKnown ? (
            <li>
              {t('meshcore.contact_sync.result_slots', {
                before: pushResult.freeSlotsBefore,
                after: pushResult.freeSlotsAfter,
                max: pushResult.maxContacts,
                defaultValue: 'Free slots: {{before}} before, {{after}} after (of {{max}})',
              })}
            </li>
          ) : (
            <li>
              {t(
                'meshcore.contact_sync.result_capacity_unknown',
                "Could not read how many contacts the radio holds, so only favourites were pushed.",
              )}
            </li>
          )}
          {pushResult.error && <li className={styles.error}>{pushResult.error}</li>}
        </ul>
      )}
      {pushResult && pushResult.notAddedNoRoom > 0 && pushResult.freeSlotsAfter === 0 && (
        <p className="hint" data-testid="meshcore-push-full-hint">
          {t(
            'meshcore.contact_sync.full_hint',
            "The radio's contact list is full, so nothing more could be added. To add a specific node, open it in Node Details and use \"Add to radio\": after you confirm, the radio replaces its oldest contact that isn't a favourite. Or remove contacts you no longer need.",
          )}
        </p>
      )}
    </div>
  );
};
