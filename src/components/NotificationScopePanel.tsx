/**
 * Mesh-wide notification default and per-source override controls (#5729).
 *
 * One notification config covers the whole mesh: the mesh-wide default
 * applies to every source the user can read that has no settings of its own.
 * Settings saved on a source (the form below this panel) override the default
 * for that source; "Use mesh-wide default" drops them again.
 *
 * Kept small on purpose: the switches every source shares, Apprise URLs, and
 * the Web Push source list. Channel choices and channel mutes stay per source
 * (channel numbers mean a different channel on every source).
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../services/api';
import { logger } from '../utils/logger';
import { useToast } from './ToastContainer';
import { UiIcon } from './icons';
import styles from './NotificationScopePanel.module.css';

/** The mesh-wide switches this panel edits, in display order. */
const MESH_TOGGLES = [
  ['enableWebPush', 'notifications.webpush_title'],
  ['enableApprise', 'notifications.apprise_title'],
  ['enableDirectMessages', 'notifications.direct_messages'],
  ['notifyOnEmoji', 'notifications.emoji_reactions'],
  ['notifyOnMqtt', 'notifications.mqtt_messages'],
  ['notifyOnNewNode', 'notifications.new_nodes'],
  ['notifyOnTraceroute', 'notifications.traceroutes'],
  ['notifyOnAutoTrace', 'notifications.notify_on_auto_trace'],
  ['notifyOnInactiveNode', 'notifications.notify_on_inactive_node'],
  ['notifyOnLowBattery', 'notifications.notify_on_low_battery'],
  ['notifyOnServerEvents', 'notifications.notify_on_server_events'],
  ['notifyOnWaypoint', 'notifications.notify_on_waypoint'],
  ['notifyOnMention', 'notifications.notify_on_mention'],
  ['prefixWithNodeName', 'notifications.prefix_with_node_name'],
] as const;

type MeshToggle = (typeof MESH_TOGGLES)[number][0];

interface MeshPreferencesResponse extends Record<MeshToggle, boolean> {
  appriseUrls: string[];
  usingDefaults: boolean;
  pushSourceIds: string[] | null;
  sources: Array<{ id: string; name: string }>;
  overrides: string[];
}

export interface NotificationScopePanelProps {
  /** The source the page is showing; null in the unsourced view. */
  sourceId: string | null;
  /** This source has its own settings (they override the mesh-wide default). */
  isOverride: boolean;
  /** Called after the override is dropped or the default saved, to reload the form. */
  onChanged: () => void;
}

const NotificationScopePanel: React.FC<NotificationScopePanelProps> = ({ sourceId, isOverride, onChanged }) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [mesh, setMesh] = useState<MeshPreferencesResponse | null>(null);
  const [appriseText, setAppriseText] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  const loadMesh = async () => {
    setLoading(true);
    try {
      const response = await api.get<MeshPreferencesResponse>('/api/push/preferences/mesh');
      setMesh(response);
      setAppriseText((response.appriseUrls || []).join('\n'));
    } catch (error) {
      logger.error('Failed to load mesh-wide notification preferences:', error);
    } finally {
      setLoading(false);
    }
  };

  const onToggleOpen = (event: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (event.currentTarget.open && !mesh && !loading) void loadMesh();
  };

  const resetOverride = async () => {
    if (!sourceId) return;
    if (!window.confirm(t('notifications.mesh_reset_confirm'))) return;
    setResetting(true);
    try {
      await api.delete(`/api/push/preferences/override?sourceId=${encodeURIComponent(sourceId)}`);
      showToast(t('notifications.mesh_reset_done'), 'success');
      if (mesh) setMesh({ ...mesh, overrides: mesh.overrides.filter(id => id !== sourceId) });
      onChanged();
    } catch (error) {
      logger.error('Failed to drop per-source notification settings:', error);
      showToast(t('notifications.alert_save_failed'), 'error');
    } finally {
      setResetting(false);
    }
  };

  const saveMesh = async () => {
    if (!mesh) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        appriseUrls: appriseText.split('\n').map(url => url.trim()).filter(url => url.length > 0),
        pushSourceIds: mesh.pushSourceIds,
      };
      for (const [field] of MESH_TOGGLES) body[field] = mesh[field];
      await api.post('/api/push/preferences/mesh', body);
      setMesh({ ...mesh, usingDefaults: false });
      showToast(t('notifications.preferences_saved'), 'success');
      onChanged();
    } catch (error) {
      logger.error('Failed to save mesh-wide notification preferences:', error);
      showToast(t('notifications.alert_save_failed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const setPushSource = (id: string, on: boolean) => {
    if (!mesh) return;
    const current = mesh.pushSourceIds ?? mesh.sources.map(src => src.id);
    const next = on ? [...new Set([...current, id])] : current.filter(x => x !== id);
    setMesh({ ...mesh, pushSourceIds: next });
  };

  const overrideNames = mesh
    ? mesh.sources.filter(src => mesh.overrides.includes(src.id)).map(src => src.name)
    : [];

  return (
    <div className={styles.panel} id="notif-scope">
      {sourceId && (
        <div className={styles.status} role="status">
          <UiIcon name="info" size={16} />
          <span className={styles.statusText}>
            {t(isOverride ? 'notifications.mesh_status_override' : 'notifications.mesh_status_default')}
          </span>
          {isOverride && (
            <button type="button" className="button button-secondary" onClick={() => void resetOverride()} disabled={resetting}>
              {t('notifications.mesh_reset_button')}
            </button>
          )}
        </div>
      )}

      <details className={styles.details} onToggle={onToggleOpen}>
        <summary className={styles.summary}>
          <UiIcon name="settings" size={16} /> {t('notifications.mesh_title')}
        </summary>
        <p className={styles.muted}>{t('notifications.mesh_description')}</p>

        {loading && <p className={styles.muted}>{t('common.loading', 'Loading...')}</p>}

        {mesh && (
          <>
            {mesh.usingDefaults && <p className={styles.muted}>{t('notifications.mesh_not_saved')}</p>}

            <div className={styles.toggleGrid}>
              {MESH_TOGGLES.map(([field, labelKey]) => (
                <label key={field} className={styles.toggle}>
                  <input
                    type="checkbox"
                    checked={mesh[field]}
                    onChange={e => setMesh({ ...mesh, [field]: e.target.checked })}
                  />
                  <span>{t(labelKey)}</span>
                </label>
              ))}
            </div>

            {mesh.enableApprise && (
              <label className={styles.field}>
                <span>{t('notifications.apprise_urls_label')}</span>
                <textarea
                  className={styles.textarea}
                  rows={3}
                  value={appriseText}
                  onChange={e => setAppriseText(e.target.value)}
                />
              </label>
            )}

            {mesh.enableWebPush && mesh.sources.length > 1 && (
              <fieldset className={styles.fieldset}>
                <legend>{t('notifications.mesh_push_sources_title')}</legend>
                <label className={styles.toggle}>
                  <input
                    type="radio"
                    name="mesh-push-sources"
                    checked={mesh.pushSourceIds === null}
                    onChange={() => setMesh({ ...mesh, pushSourceIds: null })}
                  />
                  <span>{t('notifications.mesh_push_sources_all')}</span>
                </label>
                <label className={styles.toggle}>
                  <input
                    type="radio"
                    name="mesh-push-sources"
                    checked={mesh.pushSourceIds !== null}
                    onChange={() => setMesh({ ...mesh, pushSourceIds: mesh.pushSourceIds ?? mesh.sources.map(src => src.id) })}
                  />
                  <span>{t('notifications.mesh_push_sources_some')}</span>
                </label>
                {mesh.pushSourceIds !== null && (
                  <div className={styles.sourceList}>
                    {mesh.sources.map(src => (
                      <label key={src.id} className={styles.toggle}>
                        <input
                          type="checkbox"
                          checked={mesh.pushSourceIds?.includes(src.id) ?? true}
                          onChange={e => setPushSource(src.id, e.target.checked)}
                        />
                        <span>{src.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>
            )}

            {overrideNames.length > 0 && (
              <p className={styles.muted}>
                {t('notifications.mesh_overrides_list', { sources: overrideNames.join(', ') })}
              </p>
            )}

            <button type="button" className="button button-primary" onClick={() => void saveMesh()} disabled={saving}>
              {t('notifications.mesh_save_button')}
            </button>
          </>
        )}
      </details>
    </div>
  );
};

export default NotificationScopePanel;
