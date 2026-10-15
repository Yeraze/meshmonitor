/**
 * Meshtastic Auto Responder trigger editor: the form inside an expanded
 * TriggerCard (#5808).
 *
 * It merges the old inline "Add Trigger" form and the TriggerItem edit form.
 * Every field from both is here: pattern(s), response type (text, HTTP,
 * script, traceroute, mailbox), response / URL / script, script args,
 * cooldown, channels (incl. "none" for scripts), multiline and verify.
 *
 * Each change goes straight to the section's draft through `onChange`; the
 * section validates on Done and on Save and passes the errors back in.
 */
import React, { useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import type { Channel } from '../../types/device';
import type { AutoResponderTrigger, ResponseType, ScriptMetadata } from './types';
import { splitTriggerPatterns, extractParameters } from './utils';
import { patternText, renderSampleResponse, editableChannels, type TriggerErrors } from './triggerModel';
import { COOLDOWN_SECONDS_MAX } from '../automationInputLimits';
import { NumberInput } from '../common/NumberInput';
import { UiIcon } from '../icons';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import ScriptTestModal from '../ScriptTestModal';
import layout from '../AutomationFormLayout.module.css';
import styles from './TriggerEditor.module.css';

/**
 * Right padding the trigger input reserves for its "N patterns" badge: the
 * badge's 0.5rem inset plus "12 patterns" at 0.7rem (~74px measured), with
 * a little room so the caret never touches it.
 */
const PATTERN_BADGE_RESERVE = '6rem';

const formatScriptDisplay = (script: ScriptMetadata): string =>
  script.name
    ? `${script.emoji ? `${script.emoji} ` : ''}${script.name} | ${script.filename} | ${script.language}`
    : script.filename;

export interface TriggerEditorProps {
  trigger: AutoResponderTrigger;
  onChange: (patch: Partial<AutoResponderTrigger>) => void;
  errors: TriggerErrors;
  availableScripts: ScriptMetadata[];
  channels: Channel[];
  baseUrl: string;
  /** The section is turned off. */
  disabled?: boolean;
}

const TriggerEditor: React.FC<TriggerEditorProps> = ({
  trigger,
  onChange,
  errors,
  availableScripts,
  channels,
  baseUrl,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const [showScriptTest, setShowScriptTest] = useState(false);
  const [httpTest, setHttpTest] = useState<{ loading: boolean; result?: string; error?: string } | null>(null);

  const newTrigger = patternText(trigger.trigger);
  const responseType = trigger.responseType;
  const response = trigger.response ?? '';
  const selected = editableChannels(trigger);
  const hasDm = selected.includes('dm');
  const hasNone = selected.includes('none');
  const patterns = splitTriggerPatterns(newTrigger);
  const allParams = patterns.flatMap((p) => extractParameters(p));
  const uniqueParams = Array.from(new Set(allParams.map((p) => p.name)));
  const idBase = `ar-${trigger.id}`;

  const setChannels = (next: Array<number | 'dm' | 'none'>) => {
    // Dropping DM also drops verify, as the old forms did.
    const patch: Partial<AutoResponderTrigger> = { channels: next, channel: undefined };
    if (!next.includes('dm') && trigger.verifyResponse) patch.verifyResponse = false;
    onChange(patch);
  };

  const runHttpTest = async () => {
    setHttpTest({ loading: true });
    try {
      const res = await csrfFetch(`${baseUrl}/api/http/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: renderSampleResponse(trigger) }),
      });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const data = await res.json();
          message = data.error || message;
        } catch { /* keep the status text */ }
        throw new Error(message);
      }
      const data = await res.json();
      setHttpTest({ loading: false, result: data.result || t('auto_responder.no_output') });
    } catch (err) {
      let message = (err as Error)?.message || String(err);
      if (message.includes('NetworkError') || message.includes('Failed to fetch')) message = t('auto_responder.network_error');
      setHttpTest({ loading: false, error: message });
    }
  };

  return (
    <div className={styles.editor}>
      {/* Pattern, type and response */}
      <div className={`${layout.wrapRow} ${layout.patternRow}`} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
        <div className={`${layout.growField} ${layout.patternField}`} style={{ position: 'relative' }}>
          <input
            type="text"
            id={`${idBase}-pattern`}
            value={newTrigger}
            onChange={(e) => onChange({ trigger: e.target.value })}
            placeholder={t('auto_responder.trigger_placeholder')}
            disabled={disabled}
            aria-label={t('auto_responder.trigger_label')}
            aria-invalid={errors.trigger ? true : undefined}
            className={`setting-input ${layout.scrollTarget}${errors.trigger ? ` ${styles.invalidInput}` : ''}`}
            style={{
              width: '100%',
              fontFamily: 'monospace',
              // Keep typed text clear of the "N patterns" badge drawn
              // over the right edge. Only while the badge shows, so the
              // empty field keeps its full width for the placeholder.
              paddingRight: newTrigger.trim() ? PATTERN_BADGE_RESERVE : undefined
            }}
            title={t('auto_responder.trigger_pattern_title')}
          />
          {newTrigger.trim() && (
            <div style={{
              position: 'absolute',
              right: '0.5rem',
              top: '50%',
              transform: 'translateY(-50%)',
              fontSize: '0.7rem',
              color: 'var(--color-text-subtle)',
              pointerEvents: 'none',
              whiteSpace: 'nowrap'
            }}>
              {t('auto_responder.pattern_count', { count: splitTriggerPatterns(newTrigger).length })}
            </div>
          )}
        </div>
        <select
          value={responseType}
          onChange={(e) => onChange({ responseType: e.target.value as ResponseType })}
          disabled={disabled}
          aria-label={t('auto_responder.type_label')}
          className="setting-input"
          style={{ width: '120px', minWidth: '120px' }}
          title={t('auto_responder.response_type_title')}
        >
          <option value="text">{t('auto_responder.type_text')}</option>
          <option value="http">{t('auto_responder.type_http')}</option>
          <option value="script">{t('auto_responder.type_script')}</option>
          <option value="traceroute">{t('auto_responder.type_traceroute')}</option>
          <option value="mailbox">{t('auto_responder.type_mailbox')}</option>
        </select>
        <div className={`${layout.growField} ${layout.responseField}`}>
          {responseType === 'mailbox' ? (
            <span className={styles.hint}>
              {t('auto_responder.mailbox_description')}{' '}
              {t('auto_responder.mailbox_commands')}{' '}
              <code>msg &lt;name&gt; &lt;text&gt;</code>, <code>inbox</code>,
              {' '}<code>inbox play</code>, <code>inbox delete &lt;id&gt;</code>, <code>inbox clear</code>.
              {' '}{t('auto_responder.mailbox_pattern_hint')}{' '}
              <code>msg &#123;recipient&#125; &#123;body:.+&#125;,inbox,inbox play &#123;sender&#125;,inbox play,inbox delete &#123;id&#125;,inbox clear</code>
            </span>
          ) : responseType === 'text' ? (
            <textarea
              value={response}
              onChange={(e) => onChange({ response: e.target.value })}
              placeholder={t('auto_responder.response_text_placeholder')}
              disabled={disabled}
              aria-label={t('auto_responder.response_label')}
              aria-invalid={errors.response ? true : undefined}
              className={`setting-input${errors.response ? ` ${styles.invalidInput}` : ''}`}
              style={{ width: '100%', fontFamily: 'monospace', minHeight: '60px', resize: 'vertical' }}
              rows={3}
              title={t('auto_responder.text_response_title')}
            />
          ) : responseType === 'script' ? (
            <select
              value={response}
              onChange={(e) => onChange({ response: e.target.value })}
              disabled={disabled || availableScripts.length === 0}
              aria-label={t('auto_responder.response_label')}
              aria-invalid={errors.response ? true : undefined}
              className={`setting-input${errors.response ? ` ${styles.invalidInput}` : ''}`}
              style={{ width: '100%', minWidth: 'min(100%, 200px)', fontFamily: 'monospace' }}
              title={t('auto_responder.script_select_title')}
            >
              <option value="">
                {availableScripts.length === 0 ? t('auto_responder.no_scripts_found') : t('auto_responder.select_script')}
              </option>
              {availableScripts.map((script) => (
                <option key={script.path} value={script.path}>{formatScriptDisplay(script)}</option>
              ))}
            </select>
          ) : responseType === 'traceroute' ? (
            <div className={styles.stack}>
              <input
                type="text"
                value={response}
                onChange={(e) => onChange({ response: e.target.value })}
                disabled={disabled}
                aria-label={t('auto_responder.response_label')}
                aria-invalid={errors.response ? true : undefined}
                className={`setting-input${errors.response ? ` ${styles.invalidInput}` : ''}`}
                style={{ width: '100%', fontFamily: 'monospace' }}
                placeholder={t('auto_responder.traceroute_placeholder')}
              />
              <span className={styles.hint}>
                <Trans i18nKey="auto_responder.traceroute_help" components={{ code: <code /> }} />
              </span>
            </div>
          ) : (
            <input
              type="text"
              value={response}
              onChange={(e) => onChange({ response: e.target.value })}
              placeholder={t('auto_responder.http_url_placeholder')}
              disabled={disabled}
              aria-label={t('auto_responder.response_label')}
              aria-invalid={errors.response ? true : undefined}
              className={`setting-input${errors.response ? ` ${styles.invalidInput}` : ''}`}
              style={{ width: '100%', fontFamily: 'monospace' }}
              title={t('auto_responder.http_url_title')}
            />
          )}
        </div>
      </div>

      {errors.trigger && (
        <div className={styles.error} role="alert"><UiIcon name="alert" size={14} /> {errors.trigger}</div>
      )}
      {errors.response && (
        <div className={styles.error} role="alert"><UiIcon name="alert" size={14} /> {errors.response}</div>
      )}

      {/* Pattern summary: count and detected parameters */}
      {!errors.trigger && newTrigger.trim() && (
        <div className={styles.patternInfo}>
          <span className={styles.valid}><UiIcon name="check" size={14} /> {t('auto_responder.valid')}</span>
          <span className={styles.muted}>
            {t('auto_responder.pattern_count', { count: patterns.length })}
            {uniqueParams.length > 0 && ` • ${t('auto_responder.parameter_count', { count: uniqueParams.length })}`}
          </span>
          {uniqueParams.length > 0 && (
            <span className={styles.params} aria-label={t('auto_responder.detected_parameters')}>
              {uniqueParams.map((name) => {
                const param = allParams.find((p) => p.name === name);
                return (
                  <code
                    key={name}
                    className={styles.param}
                    title={param?.pattern ? t('auto_responder.pattern_title', { pattern: param.pattern }) : t('auto_responder.default_pattern_title')}
                  >
                    {`{${name}${param?.pattern ? `:${param.pattern}` : ''}}`}
                  </code>
                );
              })}
            </span>
          )}
        </div>
      )}

      {/* Script args */}
      {responseType === 'script' && (
        <div className={`${layout.wrapRow} ${styles.row}`}>
          <label htmlFor={`${idBase}-args`} className={styles.label}>{t('auto_responder.script_args')}</label>
          <div className={styles.stack} style={{ flex: '1 1 14rem', minWidth: 0 }}>
            <input
              id={`${idBase}-args`}
              type="text"
              value={trigger.scriptArgs ?? ''}
              onChange={(e) => onChange({ scriptArgs: e.target.value })}
              disabled={disabled}
              className="setting-input"
              style={{ width: '100%', fontFamily: 'monospace' }}
              placeholder="--ip {IP} --dest {NODE_ID} --flag"
            />
            <span className={styles.hint}>{t('auto_responder.script_args_help')}</span>
          </div>
        </div>
      )}

      {/* Cooldown */}
      <div className={`${layout.wrapRow} ${layout.cooldownGroup} ${styles.row}`} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <label htmlFor={`${idBase}-cooldown`} className={styles.label}>{t('auto_responder.cooldown_label')}</label>
        <NumberInput
          id={`${idBase}-cooldown`}
          value={trigger.cooldownSeconds || 0}
          onChange={(v) => onChange({ cooldownSeconds: v })}
          min={0}
          max={COOLDOWN_SECONDS_MAX}
          integer
          disabled={disabled}
          className="setting-input"
          style={{ width: '80px' }}
        />
        <span className={`${layout.cooldownHint} ${styles.hint}`}>{t('auto_responder.cooldown_help')}</span>
      </div>
      <div className={styles.subHint}>{t('auto_responder.cooldown_description')}</div>

      {/* Channels */}
      <fieldset className={styles.channels}>
        <legend className={styles.label}>{t('auto_responder.channels_label')}</legend>
        <div className="channel-checkbox-list">
          {responseType === 'script' && (
            <div className="channel-checkbox-row">
              <input
                type="checkbox"
                id={`${idBase}-channel-none`}
                checked={hasNone}
                disabled={disabled}
                // 'none' is exclusive; unchecking it falls back to DM.
                onChange={(e) => setChannels(e.target.checked ? ['none'] : ['dm'])}
              />
              <label htmlFor={`${idBase}-channel-none`} className={styles.muted}>
                {t('auto_responder.channel_none')}
              </label>
            </div>
          )}
          <div className="channel-checkbox-row">
            <input
              type="checkbox"
              id={`${idBase}-channel-dm`}
              checked={hasDm}
              disabled={disabled || hasNone}
              onChange={(e) => setChannels(e.target.checked
                ? [...selected.filter((c) => c !== 'none'), 'dm']
                : selected.filter((c) => c !== 'dm'))}
            />
            <label htmlFor={`${idBase}-channel-dm`} className="dm-channel">
              {t('auto_responder.direct_messages')}
            </label>
          </div>
          {channels.map((channel) => (
            <div key={channel.id} className="channel-checkbox-row">
              <input
                type="checkbox"
                id={`${idBase}-channel-${channel.id}`}
                checked={selected.includes(channel.id)}
                disabled={disabled || hasNone}
                onChange={(e) => setChannels(e.target.checked
                  ? [...selected.filter((c) => c !== 'none'), channel.id]
                  : selected.filter((c) => c !== channel.id))}
              />
              <label
                htmlFor={`${idBase}-channel-${channel.id}`}
                className={channel.id === 0 ? 'primary-channel' : undefined}
              >
                {t('auto_responder.channel_option', { id: channel.id, name: channel.name })}
              </label>
            </div>
          ))}
        </div>
        {errors.channels && (
          <div className={styles.error} role="alert"><UiIcon name="alert" size={14} /> {errors.channels}</div>
        )}
      </fieldset>

      {/* Options */}
      {responseType !== 'script' && responseType !== 'traceroute' && responseType !== 'mailbox' && (
        <label className={styles.option}>
          <input
            type="checkbox"
            checked={!!trigger.multiline}
            onChange={(e) => onChange({ multiline: e.target.checked })}
            disabled={disabled}
          />
          <span>{t('auto_responder.multiline_label')}</span>
        </label>
      )}
      <label className={hasDm ? styles.option : `${styles.option} ${styles.optionOff}`}>
        <input
          type="checkbox"
          checked={!!trigger.verifyResponse && hasDm}
          onChange={(e) => onChange({ verifyResponse: e.target.checked })}
          disabled={disabled || !hasDm}
        />
        <span>{t('auto_responder.verify_response_label')}</span>
      </label>

      {/* Preview with example values, and the explicit server-side tests */}
      {(responseType === 'text' || responseType === 'http') && response.trim() && newTrigger.trim() && (
        <div className={styles.preview}>
          <div className={styles.previewLabel}>{t('auto_responder.response_preview')}</div>
          <div className={trigger.multiline ? `${styles.previewBody} ${styles.multiline}` : styles.previewBody}>
            {renderSampleResponse(trigger)}
          </div>
        </div>
      )}

      {responseType === 'http' && response.trim() && !errors.response && (
        <div className={styles.liveTest}>
          <button
            type="button"
            className={styles.testButton}
            onClick={() => void runHttpTest()}
            disabled={httpTest?.loading}
            title={t('auto_responder.live_test_title')}
          >
            <UiIcon name="test" size={14} /> {httpTest?.loading ? t('auto_responder.testing') : t('common.test')}
          </button>
          {httpTest && !httpTest.loading && (
            httpTest.error
              ? <div className={styles.error}>{t('auto_responder.error_label')} {httpTest.error}</div>
              : <pre className={styles.testResult} aria-label={t('auto_responder.test_result')}>{httpTest.result}</pre>
          )}
        </div>
      )}

      {responseType === 'script' && response && (
        <div className={styles.liveTest}>
          <button
            type="button"
            className={styles.testButton}
            onClick={() => setShowScriptTest(true)}
            title={t('auto_responder.live_test_title')}
          >
            <UiIcon name="test" size={14} /> {t('common.test')}
          </button>
          <ScriptTestModal
            isOpen={showScriptTest}
            onClose={() => setShowScriptTest(false)}
            triggerType="auto-responder"
            scriptPath={response}
            scriptArgs={trigger.scriptArgs}
            trigger={trigger.trigger}
            baseUrl={baseUrl}
          />
        </div>
      )}
    </div>
  );
};

export default TriggerEditor;
