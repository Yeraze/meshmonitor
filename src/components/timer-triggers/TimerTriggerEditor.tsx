/**
 * Meshtastic Timer Trigger editor: the form inside an expanded TriggerCard
 * (#5812).
 *
 * It merges the old "Add New Timer" form and the TimerTriggerItem edit form.
 * Every field from both is here: name (filled from a script's metadata name
 * until you type your own), cron schedule with the crontab.guru link, response
 * type, script + arguments or message + token help, and channel (incl. "none"
 * for scripts). The enable toggle, Test and Delete live on the card.
 *
 * Each change goes straight to the section's draft through `onChange`; the
 * section validates on Done and on Save and passes the errors back in.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TimerTrigger, ScriptMetadata } from '../auto-responder/types';
import type { Channel } from '../../types/device';
import { UiIcon } from '../icons';
import {
  DEFAULT_TIMER_CRON,
  TIMER_MESSAGE_LIMIT,
  editableTimerChannels,
  isValidTimerCron,
  timerResponseType,
  type TimerTriggerErrors,
} from './timerTriggerModel';
import { SplitLongMessagesField } from '../shared/automation/SplitLongMessagesField';
import { SPLIT_TIMER_MIN_INTERVAL_MINUTES } from '../../utils/messageSplitLimits';
import layout from '../AutomationFormLayout.module.css';
import styles from './TimerTriggerEditor.module.css';

/** Tokens a timer text message expands (same as auto-announce). */
const TIMER_TOKENS = ['{VERSION}', '{DURATION}', '{FEATURES}', '{NODECOUNT}', '{DIRECTCOUNT}', '{TOTALNODES}'];

/** Script option text. Keeps script-authored emoji, adds no app glyphs. */
const formatScriptDisplay = (script: ScriptMetadata): string =>
  script.name
    ? `${script.emoji ? `${script.emoji} ` : ''}${script.name} | ${script.filename} | ${script.language}`
    : script.filename;

export interface TimerTriggerEditorProps {
  trigger: TimerTrigger;
  onChange: (patch: Partial<TimerTrigger>) => void;
  errors: TimerTriggerErrors;
  availableScripts: ScriptMetadata[];
  channels: Channel[];
}

const TimerTriggerEditor: React.FC<TimerTriggerEditorProps> = ({
  trigger: tr,
  onChange,
  errors,
  availableScripts,
  channels,
}) => {
  const { t } = useTranslation();
  const type = timerResponseType(tr);
  const message = tr.response ?? '';
  // Multi-channel selection (#6230). 'none' (scripts only) is exclusive.
  const selectedChannels = editableTimerChannels(tr);
  const hasNone = selectedChannels.includes('none');

  const setChannels = (next: Array<number | 'none'>) => {
    onChange({ channels: next, channel: undefined });
  };
  // Live cron check, as the old forms had; a blank one waits for Done.
  const cronError = errors.cronExpression
    ?? (tr.cronExpression.trim() && !isValidTimerCron(tr.cronExpression)
      ? t('automation.timer_triggers.invalid_cron', 'Invalid cron expression')
      : undefined);

  // Picking a script fills the name from its metadata, unless the user typed
  // their own (a blank name, or the previous script's name, is replaced).
  const selectScript = (path: string) => {
    const patch: Partial<TimerTrigger> = { scriptPath: path };
    const next = availableScripts.find((s) => s.path === path);
    const prevName = availableScripts.find((s) => s.path === tr.scriptPath)?.name;
    if (next?.name && (!tr.name.trim() || tr.name === prevName)) patch.name = next.name;
    onChange(patch);
  };

  const counterClass = message.length > TIMER_MESSAGE_LIMIT
    ? styles.counterOver
    : message.length > 150 ? styles.counterNear : styles.counter;

  return (
    <div className={styles.editor}>
      <div className={layout.wrapRow} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <label style={{ minWidth: '120px', fontSize: '0.9rem' }} htmlFor={`timer-name-${tr.id}`}>
          {t('automation.timer_triggers.name', 'Name:')}
        </label>
        <div className={layout.labeledField} style={{ flex: 1 }}>
          <input
            id={`timer-name-${tr.id}`}
            type="text"
            value={tr.name}
            onChange={(e) => onChange({ name: e.target.value })}
            aria-invalid={errors.name ? true : undefined}
            className={`setting-input ${layout.labeledField}`}
            style={{ width: '100%' }}
            placeholder={t('automation.timer_triggers.name_placeholder', 'e.g., Daily Report')}
          />
          {errors.name && <div className={styles.error} role="alert">{errors.name}</div>}
        </div>
      </div>

      <div className={layout.wrapRow} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <label style={{ minWidth: '120px', fontSize: '0.9rem' }} htmlFor={`timer-cron-${tr.id}`}>
          {t('automation.timer_triggers.schedule', 'Schedule:')}
        </label>
        <div className={layout.labeledField} style={{ flex: 1 }}>
          <input
            id={`timer-cron-${tr.id}`}
            type="text"
            value={tr.cronExpression}
            onChange={(e) => onChange({ cronExpression: e.target.value })}
            aria-invalid={cronError ? true : undefined}
            className={`setting-input ${styles.mono}`}
            style={{ width: '100%' }}
            placeholder={DEFAULT_TIMER_CRON}
          />
          {cronError && <div className={styles.error} role="alert">{cronError}</div>}
          <div className={styles.hint}>
            {t('automation.timer_triggers.cron_help', 'Format: minute hour day month weekday')}
            {' '}
            <a href="https://crontab.guru/" target="_blank" rel="noopener noreferrer" className={styles.link}>
              crontab.guru
            </a>
          </div>
        </div>
      </div>

      <div className={layout.wrapRow} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <label style={{ minWidth: '120px', fontSize: '0.9rem' }}>
          {t('automation.timer_triggers.response_type', 'Type:')}
        </label>
        <div className={styles.radios} role="radiogroup" aria-label={t('automation.timer_triggers.response_type', 'Type:')}>
          <label className={styles.radio}>
            <input
              type="radio"
              name={`timerResponseType-${tr.id}`}
              value="script"
              checked={type === 'script'}
              onChange={() => onChange({ responseType: 'script' })}
            />
            {t('automation.timer_triggers.type_script', 'Script')}
          </label>
          <label className={styles.radio}>
            <input
              type="radio"
              name={`timerResponseType-${tr.id}`}
              value="text"
              checked={type === 'text'}
              // "None" is a script-only channel; a text timer needs a real one.
              onChange={() => {
                const real = selectedChannels.filter((c): c is number => c !== 'none');
                onChange({ responseType: 'text', channels: real.length > 0 ? real : [0], channel: undefined });
              }}
            />
            {t('automation.timer_triggers.type_text', 'Text Message')}
          </label>
        </div>
      </div>

      {type === 'script' && (
        <div className={layout.wrapRow} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <label style={{ minWidth: '120px', fontSize: '0.9rem' }} htmlFor={`timer-script-${tr.id}`}>
            {t('automation.timer_triggers.script', 'Script:')}
          </label>
          <div className={layout.labeledField} style={{ flex: 1 }}>
            <select
              id={`timer-script-${tr.id}`}
              value={tr.scriptPath ?? ''}
              onChange={(e) => selectScript(e.target.value)}
              aria-invalid={errors.scriptPath ? true : undefined}
              className={`setting-input ${layout.labeledField}`}
              style={{ width: '100%' }}
            >
              <option value="">
                {availableScripts.length === 0
                  ? t('automation.timer_triggers.no_scripts', 'No scripts found in /data/scripts/')
                  : t('automation.timer_triggers.select_script', 'Select a script...')}
              </option>
              {/* A saved path the script list no longer has stays selectable. */}
              {tr.scriptPath && !availableScripts.some((s) => s.path === tr.scriptPath) && (
                <option value={tr.scriptPath}>{tr.scriptPath.split('/').pop() || tr.scriptPath}</option>
              )}
              {availableScripts.map((script) => (
                <option key={script.path} value={script.path}>
                  {formatScriptDisplay(script)}
                </option>
              ))}
            </select>
            {errors.scriptPath && <div className={styles.error} role="alert">{errors.scriptPath}</div>}
          </div>
        </div>
      )}

      {type === 'script' && (
        <div className={layout.wrapRow} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <label style={{ minWidth: '120px', fontSize: '0.9rem' }} htmlFor={`timer-args-${tr.id}`}>
            {t('automation.timer_triggers.script_args', 'Arguments:')}
          </label>
          <div className={`${layout.labeledField} ${styles.stack}`} style={{ flex: 1 }}>
            <input
              id={`timer-args-${tr.id}`}
              type="text"
              value={tr.scriptArgs ?? ''}
              onChange={(e) => onChange({ scriptArgs: e.target.value })}
              className={`setting-input ${styles.mono}`}
              style={{ width: '100%' }}
              placeholder="--ip {IP} --count {NODECOUNT}"
            />
            <span className={styles.hint}>
              {t('automation.timer_triggers.script_args_help', 'Optional CLI arguments. Tokens: {IP}, {PORT}, {VERSION}, {NODECOUNT}, etc.')}
            </span>
          </div>
        </div>
      )}

      {type === 'text' && (
        <div className={layout.wrapRow} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
          <label style={{ minWidth: '120px', fontSize: '0.9rem', paddingTop: '0.5rem' }} htmlFor={`timer-message-${tr.id}`}>
            {t('automation.timer_triggers.message', 'Message:')}
          </label>
          <div className={layout.labeledField} style={{ flex: 1 }}>
            <textarea
              id={`timer-message-${tr.id}`}
              value={message}
              onChange={(e) => onChange({ response: e.target.value })}
              aria-invalid={errors.response ? true : undefined}
              className={`setting-input ${styles.message}`}
              placeholder={t('automation.timer_triggers.message_placeholder', 'e.g., MeshMonitor {VERSION} - {NODECOUNT} nodes online')}
            />
            {errors.response && <div className={styles.error} role="alert">{errors.response}</div>}
            <div className={styles.messageFooter}>
              <div className={styles.hint}>
                {t('automation.timer_triggers.tokens_help', 'Available tokens:')}
                {' '}
                {TIMER_TOKENS.map((tok, i) => (
                  <span key={tok}>
                    <code className={styles.token}>{tok}</code>
                    {i < TIMER_TOKENS.length - 1 && ', '}
                  </span>
                ))}
              </div>
              <div className={counterClass}>
                {message.length}/{TIMER_MESSAGE_LIMIT}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className={layout.wrapRow} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
        <label style={{ minWidth: '120px', fontSize: '0.9rem', paddingTop: '0.4rem' }}>
          {t('automation.timer_triggers.channels_label', 'Channels:')}
        </label>
        <div className={layout.labeledField} style={{ flex: 1 }}>
          <div className={styles.channels} role="group" aria-label={t('automation.timer_triggers.channels_label', 'Channels:')}>
            <div className="channel-checkbox-list">
              {type === 'script' && (
                <div className="channel-checkbox-row">
                  <input
                    type="checkbox"
                    id={`timer-channel-none-${tr.id}`}
                    checked={hasNone}
                    // 'none' is exclusive; unchecking it falls back to channel 0.
                    onChange={(e) => setChannels(e.target.checked ? ['none'] : [0])}
                  />
                  <label htmlFor={`timer-channel-none-${tr.id}`} className={styles.hint}>
                    {t('automation.timer_triggers.channel_none', 'None (no mesh output)')}
                  </label>
                </div>
              )}
              {channels.map((ch) => (
                <div key={ch.id} className="channel-checkbox-row">
                  <input
                    type="checkbox"
                    id={`timer-channel-${ch.id}-${tr.id}`}
                    checked={selectedChannels.includes(ch.id)}
                    disabled={hasNone}
                    onChange={(e) => setChannels(e.target.checked
                      ? [...selectedChannels.filter((c) => c !== 'none'), ch.id]
                      : selectedChannels.filter((c) => c !== ch.id))}
                  />
                  <label
                    htmlFor={`timer-channel-${ch.id}-${tr.id}`}
                    className={ch.id === 0 ? 'primary-channel' : undefined}
                  >
                    {t('auto_responder.channel_option', { id: ch.id, name: ch.name })}
                  </label>
                </div>
              ))}
            </div>
          </div>
          {errors.channels && <div className={styles.error} role="alert">{errors.channels}</div>}
          <div className={styles.hint}>
            {type === 'script' && hasNone ? (
              t('automation.timer_triggers.channel_none_help', 'Script handles its own output (e.g., external integrations)')
            ) : (
              <><UiIcon name="forward" size={12} /> {t('automation.timer_triggers.channels_help_generic', 'Output is sent to each selected channel, spaced by the normal send gap')}</>
            )}
          </div>
        </div>
      </div>

      {/* Split long messages (#6330): opt-in, needs a 5-minute floor. */}
      {!hasNone && (
        <SplitLongMessagesField
          id={`timer-split-${tr.id}`}
          protocol="meshtastic"
          checked={tr.multiline === true}
          onChange={(v) => onChange({ multiline: v })}
          perTargetCount={selectedChannels.length}
          extraWarning={t(
            'automation.split_long.timer_min_interval',
            'A timer that splits long messages needs an interval of at least {{minutes}} minutes.',
            { minutes: SPLIT_TIMER_MIN_INTERVAL_MINUTES },
          )}
        />
      )}
    </div>
  );
};

export default TimerTriggerEditor;
