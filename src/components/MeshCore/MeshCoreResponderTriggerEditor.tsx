/**
 * MeshCore Auto-Responder trigger editor: the form inside an expanded
 * TriggerCard (#5808). The fields are the ones the always-open trigger card
 * had: name, regex pattern, action (text or script), response or script and
 * args, listen on DMs, reply as DM, cooldown, pre-send delay, channels and
 * the reply scope. The enable toggle and Delete live on the card itself.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { NumberInput } from '../common/NumberInput';
import { ScopeSelectField } from './ScopeSelectField';
import type {
  MeshCoreAutoResponderTrigger,
  MeshCoreChannelRow,
  MeshCoreScriptMetadata,
} from './meshcoreResponderTypes';
import styles from './MeshCoreResponderTriggerEditor.module.css';

export interface MeshCoreResponderTriggerEditorProps {
  trigger: MeshCoreAutoResponderTrigger;
  onChange: (patch: Partial<MeshCoreAutoResponderTrigger>) => void;
  /** Regex error for the current pattern, if any. */
  patternError?: string;
  /** Shown under the name field after Done / Save. */
  nameError?: string;
  channels: MeshCoreChannelRow[];
  scripts: MeshCoreScriptMetadata[];
  baseUrl: string;
  sourceId: string;
  /** The section is turned off. */
  disabled?: boolean;
}

export const MeshCoreResponderTriggerEditor: React.FC<MeshCoreResponderTriggerEditorProps> = ({
  trigger: tr,
  onChange,
  patternError,
  nameError,
  channels,
  scripts,
  baseUrl,
  sourceId,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const idBase = `mc-responder-${tr.id}`;
  const isText = (tr.responseType || 'text') === 'text';

  return (
    <div className={styles.editor}>
      <label className={styles.field}>
        {t('meshcore.automation.responder.name', 'Name')}
        <input
          type="text"
          value={tr.name}
          onChange={(e) => onChange({ name: e.target.value })}
          disabled={disabled}
          placeholder={t('meshcore.automation.responder.name_placeholder', 'Trigger name')}
          aria-invalid={nameError ? true : undefined}
          className="meshcore-input"
        />
        {nameError && <span className={styles.error} role="alert">{nameError}</span>}
      </label>

      <label className={styles.field}>
        {t('meshcore.automation.responder.pattern', 'Pattern (regex, case-insensitive)')}
        <input
          type="text"
          value={tr.pattern}
          onChange={(e) => onChange({ pattern: e.target.value })}
          disabled={disabled}
          placeholder="^(test|ping)"
          aria-invalid={patternError ? true : undefined}
          className={`meshcore-input ${styles.mono}`}
        />
        {patternError && <span className={styles.error} role="alert">{patternError}</span>}
      </label>

      <div className={styles.actionRow}>
        <label className={styles.field}>
          {t('meshcore.automation.responder.response_type', 'Action')}
          <select
            value={tr.responseType || 'text'}
            onChange={(e) => onChange({ responseType: e.target.value as 'text' | 'script' })}
            disabled={disabled}
            className="meshcore-select"
          >
            <option value="text">{t('meshcore.automation.responder.response_text', 'Send text')}</option>
            <option value="script">{t('meshcore.automation.responder.response_script', 'Run script')}</option>
          </select>
        </label>
        {isText ? (
          <label className={`${styles.field} ${styles.grow}`}>
            {t('meshcore.automation.responder.response', 'Response (token expansion supported)')}
            <textarea
              value={tr.response}
              onChange={(e) => onChange({ response: e.target.value })}
              disabled={disabled}
              rows={2}
              placeholder={t('meshcore.automation.responder.response_placeholder', 'Response text (supports {VERSION}, {DURATION}, …)')}
              className={`meshcore-input ${styles.mono}`}
            />
          </label>
        ) : (
          <>
            <label className={`${styles.field} ${styles.grow}`}>
              {t('meshcore.automation.responder.script', 'Script')}
              <select
                value={tr.scriptPath || ''}
                onChange={(e) => onChange({ scriptPath: e.target.value })}
                disabled={disabled}
                className="meshcore-select"
              >
                <option value="">{scripts.length === 0 ? t('meshcore.automation.responder.no_scripts', '(no scripts available)') : t('meshcore.automation.responder.select_script', '(select script)')}</option>
                {scripts.map(s => (
                  <option key={s.path} value={s.path}>
                    {s.emoji ? `${s.emoji} ` : ''}{s.name || s.filename} ({s.language || '?'})
                  </option>
                ))}
              </select>
            </label>
            <label className={`${styles.field} ${styles.grow}`}>
              {t('meshcore.automation.responder.script_args', 'Script args (token expansion)')}
              <input
                type="text"
                value={tr.scriptArgs || ''}
                onChange={(e) => onChange({ scriptArgs: e.target.value })}
                disabled={disabled}
                className={`meshcore-input ${styles.mono}`}
              />
            </label>
          </>
        )}
      </div>

      <div className={styles.optionsRow}>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={tr.listenDMs}
            onChange={(e) => onChange({ listenDMs: e.target.checked })}
            disabled={disabled}
          />
          {t('meshcore.automation.responder.listen_dms', 'Listen on DMs')}
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={tr.replyAsDM}
            onChange={(e) => onChange({ replyAsDM: e.target.checked })}
            disabled={disabled}
          />
          {t('meshcore.automation.responder.reply_dm', 'Reply as DM')}
        </label>
        <label className={styles.inline}>
          {t('meshcore.automation.responder.cooldown', 'Cooldown (s)')}
          <NumberInput
            min={0}
            max={3600}
            integer
            value={tr.cooldownSeconds}
            onChange={(v) => onChange({ cooldownSeconds: v })}
            disabled={disabled}
            className={`meshcore-input ${styles.number}`}
          />
        </label>
        <label
          className={styles.inline}
          title={t(
            'meshcore.automation.responder.presend_delay_help',
            'Wait this long after a match before replying, so a relaying repeater can finish its own transmission first (0 = send immediately, max 120).',
          )}
        >
          {t('meshcore.automation.responder.presend_delay', 'Pre-Send Delay (s)')}
          <NumberInput
            min={0}
            max={120}
            integer
            value={tr.preSendDelaySeconds ?? 0}
            onChange={(v) => onChange({ preSendDelaySeconds: v })}
            disabled={disabled}
            className={`meshcore-input ${styles.number}`}
          />
        </label>
      </div>

      <fieldset className={styles.channels}>
        <legend className={styles.legend}>
          {t('meshcore.automation.responder.channels', 'Listen on channels')}
        </legend>
        {channels.length === 0 && (
          <span className={styles.muted}>
            {t('meshcore.automation.responder.no_channels', 'No channels loaded')}
          </span>
        )}
        <div className={styles.channelList}>
          {channels.map(ch => (
            <label key={ch.id} className={styles.check}>
              <input
                type="checkbox"
                checked={tr.channels.includes(ch.id)}
                onChange={(e) => onChange({
                  channels: e.target.checked ? [...tr.channels, ch.id] : tr.channels.filter(c => c !== ch.id),
                })}
                disabled={disabled}
              />
              {ch.name || `Channel ${ch.id}`}
            </label>
          ))}
        </div>
      </fieldset>

      {/* MeshCore scope/region for the reply (#3833) */}
      <ScopeSelectField
        baseUrl={baseUrl}
        sourceId={sourceId}
        allowTrigger
        idPrefix={idBase}
        value={{ scopeMode: tr.scopeMode, scopeName: tr.scopeName }}
        onChange={(v) => onChange({ scopeMode: v.scopeMode, scopeName: v.scopeName })}
      />
    </div>
  );
};

export default MeshCoreResponderTriggerEditor;
