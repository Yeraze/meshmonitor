/**
 * ForwardingSection (#5446) — simple per-source message forwarding rules,
 * shown next to the Auto-Responder on both the Meshtastic Automation tab and
 * the MeshCore Automations view.
 *
 * Each rule copies a matching incoming message (DMs or one channel, optional
 * sender + text filters) to one channel or one node on the SAME source, and
 * has its own on/off toggle. Limits are fixed server-side (5 forwards per rule
 * per minute, 200 characters, never forward our own or already-forwarded
 * text); this panel only states them.
 *
 * When the source cannot transmit (MeshCore receive-only, Meshtastic TX
 * disabled, MQTT sources) the rules stay visible but read-only.
 *
 * The header carries the source-level master switch (#5537): off stops every
 * rule on this source whatever its own checkbox says. It saves at once.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../ToastContainer';
import { useAuth } from '../../contexts/AuthContext';
import { useSaveBar } from '../../hooks/useSaveBar';
import { UiIcon } from '../icons';
import {
  FORWARDED_MARKER,
  FORWARDING_MAX_PER_WINDOW,
  FORWARDING_MAX_PREFIX_CHARS,
  FORWARDING_MAX_RULES,
  FORWARDING_MAX_TEXT_CHARS,
  validateForwardingRules,
  type ForwardingRule,
} from '../../types/forwarding';
import styles from './ForwardingSection.module.css';

export interface ForwardingChannelOption {
  index: number;
  name: string;
}

export interface ForwardingNodeOption {
  /** Meshtastic `!abcd1234`, or a MeshCore public key. */
  id: string;
  label: string;
}

export interface ForwardingSectionProps {
  baseUrl: string;
  sourceId: string;
  channels: ForwardingChannelOption[];
  nodes: ForwardingNodeOption[];
  /** True when this source cannot transmit; rules become read-only. */
  receiveOnly?: boolean;
  /** Save-bar id suffix, so two sections on one page never collide. */
  saveBarId?: string;
  /**
   * Which shared form-control classes to use, so the fields match the
   * sections around them: `settings` = `.setting-input` (Meshtastic
   * Automation tab), `meshcore` = `.meshcore-input` / `.meshcore-select`
   * (MeshCore Automations view).
   */
  controlVariant?: 'settings' | 'meshcore';
}

const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `fw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const newRule = (): ForwardingRule => ({
  id: newId(),
  name: '',
  // New rules start OFF: forwarding sends packets, so the user arms a rule
  // deliberately with its checkbox once it is filled in.
  enabled: false,
  match: { isDM: true },
  forwardTo: { destinationNodeId: '' },
  prefix: '{from}: ',
});

const DM_VALUE = 'dm';

export const ForwardingSection: React.FC<ForwardingSectionProps> = ({
  baseUrl,
  sourceId,
  channels,
  nodes,
  receiveOnly = false,
  saveBarId = 'forwarding',
  controlVariant = 'settings',
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('automation', 'write', { sourceId });
  const readOnly = receiveOnly || !canWrite;

  const [rules, setRules] = useState<ForwardingRule[]>([]);
  const [initialRules, setInitialRules] = useState<ForwardingRule[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  // Source-level master switch (#5537). Absent on the server = on.
  const [masterEnabled, setMasterEnabled] = useState(true);
  const [masterBusy, setMasterBusy] = useState(false);

  const endpoint = `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/forwarding`;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await csrfFetch(endpoint);
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled || !json?.success) return;
        const list: ForwardingRule[] = Array.isArray(json.data?.rules) ? json.data.rules : [];
        setRules(list);
        setInitialRules(list);
        setMasterEnabled(json.data?.enabled !== false);
      } catch { /* keep empty */ }
    })();
    return () => { cancelled = true; };
  }, [endpoint, csrfFetch]);

  const hasChanges = useMemo(
    () => JSON.stringify(rules) !== JSON.stringify(initialRules),
    [rules, initialRules],
  );

  const handleSave = useCallback(async () => {
    const v = validateForwardingRules(rules);
    if (!v.ok) {
      showToast(v.error, 'error');
      return;
    }
    setIsSaving(true);
    try {
      const res = await csrfFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: v.rules }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        if (res.status === 403) {
          showToast(t('automation.insufficient_permissions', 'Insufficient permissions'), 'error');
          return;
        }
        showToast(json?.error || t('automation.settings_save_failed', 'Failed to save settings'), 'error');
        return;
      }
      const saved: ForwardingRule[] = Array.isArray(json.data?.rules) ? json.data.rules : v.rules;
      setRules(saved);
      setInitialRules(saved);
      showToast(t('automation.settings_saved', 'Settings saved'), 'success');
    } catch {
      showToast(t('automation.settings_save_failed', 'Failed to save settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [rules, csrfFetch, endpoint, showToast, t]);

  const handleDismiss = useCallback(() => setRules(initialRules), [initialRules]);

  // The master switch saves at once, apart from the save bar: it is one bit,
  // it sends nothing, and the server leaves the rate limiter alone.
  const handleMasterToggle = useCallback(async (next: boolean) => {
    setMasterBusy(true);
    try {
      const res = await csrfFetch(`${endpoint}/enabled`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        showToast(
          res.status === 403
            ? t('automation.insufficient_permissions', 'Insufficient permissions')
            : json?.error || t('forwarding.toggle_failed', 'Failed to change forwarding'),
          'error',
        );
        return;
      }
      setMasterEnabled(json.data?.enabled !== false);
      showToast(
        next
          ? t('forwarding.master_turned_on', 'Forwarding turned on')
          : t('forwarding.master_turned_off', 'Forwarding turned off'),
        'success',
      );
    } catch {
      showToast(t('forwarding.toggle_failed', 'Failed to change forwarding'), 'error');
    } finally {
      setMasterBusy(false);
    }
  }, [csrfFetch, endpoint, showToast, t]);

  useSaveBar({
    id: saveBarId,
    sectionName: t('forwarding.title', 'Forwarding'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: handleDismiss,
  });

  const update = (id: string, patch: Partial<ForwardingRule>) =>
    setRules(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)));

  const inputClass = controlVariant === 'meshcore'
    ? `meshcore-input ${styles.control} ${styles.meshcoreControl}`
    : `setting-input ${styles.control}`;
  const selectClass = controlVariant === 'meshcore'
    ? `meshcore-select ${styles.control} ${styles.meshcoreControl}`
    : `setting-input ${styles.control}`;

  const channelLabel = (c: ForwardingChannelOption) =>
    c.name ? `${c.index}: ${c.name}` : t('forwarding.channel_n', 'Channel {{index}}', { index: c.index });

  return (
    <>
      <div className={styles.header}>
        <h2>
          <UiIcon name="forward" size={20} />
          {t('forwarding.title', 'Forwarding')}
        </h2>
        <span className={styles.count}>
          {t('forwarding.count', { count: rules.length })}
        </span>
        <label className={styles.masterSwitch}>
          <input
            type="checkbox"
            checked={masterEnabled}
            disabled={!canWrite || masterBusy}
            onChange={e => void handleMasterToggle(e.target.checked)}
            data-testid="forwarding-master-switch"
          />
          {t('forwarding.master_label', 'Forwarding on for this source')}
        </label>
      </div>

      <div className={`settings-section ${styles.body}`}>
        <p className={styles.description}>
          {t(
            'forwarding.description',
            'Copy matching incoming messages to another channel or to one node on this source, for example your DMs to your phone while you are away. Turn each rule on or off with its checkbox.',
          )}
        </p>
        <p className={styles.limits}>
          {t(
            'forwarding.limits',
            'Fixed limits: each rule forwards at most {{max}} messages per minute (extra matches are dropped), forwarded text is cut to {{chars}} characters and starts with "{{marker}}", and MeshMonitor never forwards its own messages or a message that was already forwarded.',
            { max: FORWARDING_MAX_PER_WINDOW, chars: FORWARDING_MAX_TEXT_CHARS, marker: FORWARDED_MARKER.trim() },
          )}
        </p>

        {receiveOnly && (
          <p role="status" className={styles.paused}>
            <UiIcon name="pause" size={14} />
            {t(
              'forwarding.paused',
              'Paused: this source cannot transmit (receive-only or TX disabled). Rules are shown read-only and nothing is forwarded.',
            )}
          </p>
        )}

        {!masterEnabled && (
          <p role="status" className={styles.paused}>
            <UiIcon name="pause" size={14} />
            {t(
              'forwarding.master_off_note',
              'Forwarding is off for this source. No rule forwards anything until you turn it back on.',
            )}
          </p>
        )}

        {rules.length === 0 && (
          <p className={styles.empty}>{t('forwarding.empty', 'No forwarding rules yet.')}</p>
        )}

        {rules.map(rule => {
          const matchValue = rule.match.isDM ? DM_VALUE : String(rule.match.channel ?? '');
          // `channel: null` = channel target chosen but no channel picked yet.
          const targetKind = rule.forwardTo.destinationNodeId === undefined && 'channel' in rule.forwardTo
            ? 'channel'
            : 'node';
          return (
            <div
              key={rule.id}
              className={`${styles.card} ${rule.enabled ? '' : styles.cardDisabled}`}
              data-testid="forwarding-rule"
            >
              <div className={styles.cardHeader}>
                <input
                  type="checkbox"
                  className={styles.toggle}
                  checked={rule.enabled}
                  disabled={readOnly}
                  onChange={e => update(rule.id, { enabled: e.target.checked })}
                  aria-label={t('forwarding.enable_rule', 'Enable {{name}}', { name: rule.name || t('forwarding.rule', 'rule') })}
                />
                <input
                  type="text"
                  className={inputClass}
                  value={rule.name}
                  disabled={readOnly}
                  maxLength={60}
                  placeholder={t('forwarding.name_placeholder', 'Rule name')}
                  aria-label={t('forwarding.name', 'Name')}
                  onChange={e => update(rule.id, { name: e.target.value })}
                />
                <button
                  type="button"
                  className={`${styles.iconButton} ${styles.danger}`}
                  disabled={readOnly}
                  onClick={() => setRules(prev => prev.filter(r => r.id !== rule.id))}
                  aria-label={t('forwarding.delete', 'Delete rule')}
                >
                  <UiIcon name="delete" size={16} />
                </button>
              </div>

              <div className={styles.grid}>
                <div className="setting-item">
                  <label>
                    {t('forwarding.match', 'Forward messages from')}
                    <select
                      className={selectClass}
                      value={matchValue}
                      disabled={readOnly}
                      onChange={e => {
                        const v = e.target.value;
                        update(rule.id, {
                          match: {
                            ...rule.match,
                            isDM: v === DM_VALUE ? true : undefined,
                            channel: v === DM_VALUE ? undefined : Number(v),
                          },
                        });
                      }}
                    >
                      <option value={DM_VALUE}>{t('forwarding.match_dm', 'Direct messages')}</option>
                      {channels.map(c => (
                        <option key={c.index} value={String(c.index)}>{channelLabel(c)}</option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="setting-item">
                  <label>
                    {t('forwarding.from_node', 'Only from sender')}
                    <select
                      className={selectClass}
                      value={rule.match.fromNodeId ?? ''}
                      disabled={readOnly}
                      onChange={e => update(rule.id, { match: { ...rule.match, fromNodeId: e.target.value || undefined } })}
                    >
                      <option value="">{t('forwarding.any_sender', 'Any sender')}</option>
                      {rule.match.fromNodeId && !nodes.some(n => n.id === rule.match.fromNodeId) && (
                        <option value={rule.match.fromNodeId}>{rule.match.fromNodeId}</option>
                      )}
                      {nodes.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}
                    </select>
                  </label>
                </div>

                <div className="setting-item">
                  <label>
                    {t('forwarding.text_regex', 'Only if text matches (regex, optional)')}
                    <input
                      type="text"
                      className={inputClass}
                      value={rule.match.textRegex ?? ''}
                      disabled={readOnly}
                      maxLength={100}
                      placeholder="^alert"
                      onChange={e => update(rule.id, { match: { ...rule.match, textRegex: e.target.value || undefined } })}
                    />
                  </label>
                </div>

                <div className="setting-item">
                  <label>
                    {t('forwarding.target', 'Forward to')}
                    <span className={styles.targetRow}>
                      <select
                        className={`${selectClass} ${styles.targetKind}`}
                        value={targetKind}
                        disabled={readOnly}
                        aria-label={t('forwarding.target_kind', 'Target type')}
                        onChange={e => update(rule.id, {
                          forwardTo: e.target.value === 'channel'
                            // Pre-select nothing: a channel target costs shared airtime,
                            // so the user must pick one on purpose.
                            ? { channel: null }
                            : { destinationNodeId: '' },
                        })}
                      >
                        <option value="node">{t('forwarding.target_node', 'Node (DM)')}</option>
                        <option value="channel">{t('forwarding.target_channel', 'Channel')}</option>
                      </select>
                      {targetKind === 'channel' ? (
                        <select
                          className={selectClass}
                          value={rule.forwardTo.channel == null ? '' : String(rule.forwardTo.channel)}
                          disabled={readOnly}
                          aria-label={t('forwarding.target_channel', 'Channel')}
                          onChange={e => update(rule.id, {
                            forwardTo: { channel: e.target.value === '' ? null : Number(e.target.value) },
                          })}
                        >
                          <option value="" disabled>{t('forwarding.pick_channel', 'Choose a channel...')}</option>
                          {channels.map(c => (
                            <option key={c.index} value={String(c.index)}>{channelLabel(c)}</option>
                          ))}
                        </select>
                      ) : (
                        <select
                          className={selectClass}
                          value={rule.forwardTo.destinationNodeId ?? ''}
                          disabled={readOnly}
                          aria-label={t('forwarding.target_node', 'Node (DM)')}
                          onChange={e => update(rule.id, { forwardTo: { destinationNodeId: e.target.value } })}
                        >
                          <option value="">{t('forwarding.pick_node', 'Pick a node...')}</option>
                          {rule.forwardTo.destinationNodeId && !nodes.some(n => n.id === rule.forwardTo.destinationNodeId) && (
                            <option value={rule.forwardTo.destinationNodeId}>{rule.forwardTo.destinationNodeId}</option>
                          )}
                          {nodes.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}
                        </select>
                      )}
                    </span>
                  </label>
                </div>

                <div className="setting-item">
                  <label>
                    {t('forwarding.prefix', 'Prefix (optional)')}
                    <span className="setting-description">
                      {t('forwarding.prefix_hint', 'Tokens: {from} = sender, {channel} = channel name or DM.')}
                    </span>
                    <input
                      type="text"
                      className={inputClass}
                      value={rule.prefix ?? ''}
                      disabled={readOnly}
                      maxLength={FORWARDING_MAX_PREFIX_CHARS}
                      placeholder="{from}: "
                      onChange={e => update(rule.id, { prefix: e.target.value })}
                    />
                  </label>
                </div>
              </div>

              {targetKind === 'channel' && (
                <p className={styles.warning} role="note">
                  <UiIcon name="alert" size={16} />
                  <span>
                    {t(
                      'forwarding.channel_airtime_warning',
                      'Forwarding to a channel broadcasts to everyone on it and uses shared airtime for the whole mesh. Prefer a DM target where you can.',
                    )}
                  </span>
                </p>
              )}
            </div>
          );
        })}

        <div className={styles.addRow}>
          <button
            type="button"
            className={styles.iconButton}
            disabled={readOnly || rules.length >= FORWARDING_MAX_RULES}
            onClick={() => setRules(prev => [...prev, newRule()])}
          >
            <UiIcon name="plus" size={16} />
            {t('forwarding.add', 'Add forwarding rule')}
          </button>
        </div>
      </div>
    </>
  );
};

export default ForwardingSection;
