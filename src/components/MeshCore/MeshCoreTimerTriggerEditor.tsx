/**
 * MeshCore Timer Trigger editor: the form inside an expanded TriggerCard
 * (#5812). The fields are the ones the always-open trigger card had: name,
 * schedule type (cron or interval), cron or interval, action (text, advert or
 * script), message / advert reach / script and args, destination (channel or
 * DM), channel or contact, and the scope. The enable toggle, "Run now" and
 * Delete live on the card itself; the last run shows on the collapsed card.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { NumberInput } from '../common/NumberInput';
import { ScopeSelectField } from './ScopeSelectField';
import { SplitLongMessagesField } from '../shared/automation/SplitLongMessagesField';
import { MESHCORE_SPLIT_TIMER_MIN_INTERVAL_MINUTES } from '../../utils/meshcoreMessageLimits';
import { MeshCoreAdvertModeField } from './MeshCoreAdvertModeField';
import {
  DEFAULT_MESHCORE_ADVERT_MODE,
  LEGACY_MESHCORE_ADVERT_MODE,
  resolveMeshCoreAdvertMode,
} from '../../types/meshcoreAdvert';
import type { MeshCoreChannelRow, MeshCoreScriptMetadata } from './meshcoreResponderTypes';
import {
  DEFAULT_MESHCORE_TIMER_CRON,
  meshCoreTimerChannelIndexes,
  type MeshCoreContactRow,
  type MeshCoreTimerErrors,
  type MeshCoreTimerTrigger,
} from './meshcoreTimerModel';
import styles from './MeshCoreTimerTriggerEditor.module.css';

export interface MeshCoreTimerTriggerEditorProps {
  trigger: MeshCoreTimerTrigger;
  onChange: (patch: Partial<MeshCoreTimerTrigger>) => void;
  errors: MeshCoreTimerErrors;
  channels: MeshCoreChannelRow[];
  contacts: MeshCoreContactRow[];
  scripts: MeshCoreScriptMetadata[];
  baseUrl: string;
  sourceId: string;
}

export const MeshCoreTimerTriggerEditor: React.FC<MeshCoreTimerTriggerEditorProps> = ({
  trigger: tr,
  onChange,
  errors,
  channels,
  contacts,
  scripts,
  baseUrl,
  sourceId,
}) => {
  const { t } = useTranslation();
  const sends = tr.responseType === 'text' || tr.responseType === 'script';
  // Multi-channel selection (#6230). Reads the new array, coercing an old
  // single-channel timer into a one-item array.
  const selectedChannels = meshCoreTimerChannelIndexes(tr);
  const toggleChannel = (id: number, on: boolean) => {
    onChange({
      channelIndexes: on
        ? [...selectedChannels, id]
        : selectedChannels.filter((c) => c !== id),
      channelIndex: undefined,
    });
  };

  return (
    <div className={styles.editor}>
      <label className={styles.field}>
        {t('meshcore.automation.timers.name', 'Name')}
        <input
          type="text"
          value={tr.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder={t('meshcore.automation.timers.name_placeholder', 'Trigger name')}
          aria-invalid={errors.name ? true : undefined}
          className="meshcore-input"
        />
        {errors.name && <span className={styles.error} role="alert">{errors.name}</span>}
      </label>

      <div className={styles.row}>
        <label className={styles.field}>
          {t('meshcore.automation.timers.schedule_type', 'Schedule')}
          <select
            value={tr.scheduleType}
            onChange={(e) => onChange({ scheduleType: e.target.value as 'cron' | 'interval' })}
            className="meshcore-select"
          >
            <option value="cron">{t('meshcore.automation.timers.cron', 'Cron')}</option>
            <option value="interval">{t('meshcore.automation.timers.interval', 'Interval (minutes)')}</option>
          </select>
        </label>
        {tr.scheduleType === 'cron' ? (
          <label className={`${styles.field} ${styles.grow}`}>
            {t('meshcore.automation.timers.cron_expr', 'Cron expression')}
            <input
              type="text"
              value={tr.cronExpression || ''}
              onChange={(e) => onChange({ cronExpression: e.target.value })}
              placeholder={DEFAULT_MESHCORE_TIMER_CRON}
              aria-invalid={errors.cronExpression ? true : undefined}
              className={`meshcore-input ${styles.mono}`}
            />
            {errors.cronExpression && <span className={styles.error} role="alert">{errors.cronExpression}</span>}
          </label>
        ) : (
          <label className={`${styles.field} ${styles.grow}`}>
            {t('meshcore.automation.timers.interval_minutes', 'Interval (minutes)')}
            <NumberInput
              min={1}
              max={10080}
              integer
              value={tr.intervalMinutes ?? 60}
              onChange={(v) => onChange({ intervalMinutes: v })}
              className="meshcore-input"
            />
            {errors.intervalMinutes && <span className={styles.error} role="alert">{errors.intervalMinutes}</span>}
          </label>
        )}
      </div>

      <div className={styles.row}>
        <label className={styles.field}>
          {t('meshcore.automation.timers.response_type', 'Action')}
          <select
            value={tr.responseType}
            onChange={(e) => {
              const responseType = e.target.value as 'text' | 'advert' | 'script';
              // Turning an older trigger into an advert is a new advert
              // config: give it the zero-hop default rather than the
              // legacy flood an absent mode would mean.
              onChange(responseType === 'advert' && tr.advertMode === undefined
                ? { responseType, advertMode: DEFAULT_MESHCORE_ADVERT_MODE }
                : { responseType });
            }}
            className="meshcore-select"
          >
            <option value="text">{t('meshcore.automation.timers.response_text', 'Send text')}</option>
            <option value="advert">{t('meshcore.automation.timers.response_advert', 'Send advert')}</option>
            <option value="script">{t('meshcore.automation.timers.response_script', 'Run script')}</option>
          </select>
        </label>
        {tr.responseType === 'advert' && (
          <div className={styles.grow}>
            <MeshCoreAdvertModeField
              value={resolveMeshCoreAdvertMode(tr.advertMode, LEGACY_MESHCORE_ADVERT_MODE)}
              onChange={(mode) => onChange({ advertMode: mode })}
            />
          </div>
        )}
        {tr.responseType === 'text' && (
          <label className={`${styles.field} ${styles.grow}`}>
            {t('meshcore.automation.timers.response_message', 'Message (token expansion supported)')}
            <textarea
              value={tr.response || ''}
              onChange={(e) => onChange({ response: e.target.value })}
              rows={2}
              className={`meshcore-input ${styles.mono}`}
            />
          </label>
        )}
        {tr.responseType === 'script' && (
          <>
            <label className={`${styles.field} ${styles.grow}`}>
              {t('meshcore.automation.timers.script', 'Script')}
              <select
                value={tr.scriptPath || ''}
                onChange={(e) => onChange({ scriptPath: e.target.value })}
                className="meshcore-select"
              >
                <option value="">{scripts.length === 0 ? t('meshcore.automation.timers.no_scripts', '(no scripts available)') : t('meshcore.automation.timers.select_script', '(select script)')}</option>
                {scripts.map(s => (
                  <option key={s.path} value={s.path}>
                    {s.emoji ? `${s.emoji} ` : ''}{s.name || s.filename} ({s.language || '?'})
                  </option>
                ))}
              </select>
            </label>
            <label className={`${styles.field} ${styles.grow}`}>
              {t('meshcore.automation.timers.script_args', 'Script args (token expansion)')}
              <input
                type="text"
                value={tr.scriptArgs || ''}
                onChange={(e) => onChange({ scriptArgs: e.target.value })}
                className={`meshcore-input ${styles.mono}`}
              />
            </label>
          </>
        )}
      </div>

      {sends && (
        <div className={styles.row}>
          <label className={styles.field}>
            {t('meshcore.automation.timers.destination', 'Destination')}
            <select
              value={tr.destination || 'channel'}
              onChange={(e) => onChange({ destination: e.target.value as 'channel' | 'dm' })}
              className="meshcore-select"
            >
              <option value="channel">{t('meshcore.automation.timers.dest_channel', 'Channel')}</option>
              <option value="dm">{t('meshcore.automation.timers.dest_dm', 'Direct Message')}</option>
            </select>
          </label>
          {(tr.destination || 'channel') === 'channel' ? (
            <fieldset className={`${styles.channels} ${styles.grow}`}>
              <legend className={styles.legend}>
                {t('meshcore.automation.timers.channels', 'Channels')}
              </legend>
              {channels.length === 0 && (
                <span className={styles.muted}>
                  {t('meshcore.automation.timers.no_channels', '(no channels loaded)')}
                </span>
              )}
              <div className={styles.channelList}>
                {channels.map(c => (
                  <label key={c.id} className={styles.check}>
                    <input
                      type="checkbox"
                      checked={selectedChannels.includes(c.id)}
                      onChange={(e) => toggleChannel(c.id, e.target.checked)}
                    />
                    {c.name || `Channel ${c.id}`}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : (
            <label className={`${styles.field} ${styles.grow}`}>
              {t('meshcore.automation.timers.contact', 'Contact')}
              <select
                value={tr.contactPublicKey || ''}
                onChange={(e) => onChange({ contactPublicKey: e.target.value })}
                className="meshcore-select"
              >
                <option value="">{t('meshcore.automation.timers.select_contact', '(select contact)')}</option>
                {contacts.map(c => (
                  <option key={c.publicKey} value={c.publicKey}>{c.name}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {sends && (
        <SplitLongMessagesField
          id={`timer-split-${tr.id}`}
          checked={tr.multiline === true}
          onChange={(v) => onChange({ multiline: v })}
          perTargetCount={(tr.destination || 'channel') === 'channel' ? selectedChannels.length : 1}
          extraWarning={t(
            'automation.split_long.timer_min_interval',
            'A timer that splits long messages needs an interval of at least {{minutes}} minutes.',
            { minutes: MESHCORE_SPLIT_TIMER_MIN_INTERVAL_MINUTES },
          )}
        />
      )}

      {sends && (
        // MeshCore scope/region for the sent message (#3833). No trigger
        // message here, so the "respond on trigger scope" option is omitted.
        <ScopeSelectField
          baseUrl={baseUrl}
          sourceId={sourceId}
          idPrefix={`timer-${tr.id}`}
          value={{ scopeMode: tr.scopeMode, scopeName: tr.scopeName }}
          onChange={(v) => onChange({ scopeMode: v.scopeMode, scopeName: v.scopeName })}
        />
      )}
    </div>
  );
};

export default MeshCoreTimerTriggerEditor;
