/**
 * Auto-Responder trigger syntax selector (#5924), shared by the Meshtastic
 * and MeshCore trigger editors: a select between the placeholder DSL and a
 * bare regex, with a one-line hint for the chosen mode.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ResponderSyntax } from '../../../utils/responderTrigger';
import styles from './ResponderSyntaxSelect.module.css';

export interface ResponderSyntaxSelectProps {
  id: string;
  value: ResponderSyntax;
  onChange: (value: ResponderSyntax) => void;
  disabled?: boolean;
}

export const ResponderSyntaxSelect: React.FC<ResponderSyntaxSelectProps> = ({ id, value, onChange, disabled = false }) => {
  const { t } = useTranslation();
  const hintId = `${id}-hint`;
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{t('automation.responder_syntax.label', 'Match mode')}</label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as ResponderSyntax)}
        disabled={disabled}
        aria-describedby={hintId}
        className={`setting-input ${styles.select}`}
      >
        <option value="pattern">{t('automation.responder_syntax.pattern', 'Pattern')}</option>
        <option value="regex">{t('automation.responder_syntax.regex', 'Regex')}</option>
      </select>
      <span id={hintId} className={styles.hint}>
        {value === 'regex'
          ? t(
            'automation.responder_syntax.regex_hint',
            'Regular expression, case-insensitive. Matches anywhere in the message; anchor with ^ and $. (?<name>…) captures a value.',
          )
          : t(
            'automation.responder_syntax.pattern_hint',
            'The whole message must match, case-insensitive. {name} captures a word, {name:regex} a custom value; separate alternatives with commas.',
          )}
      </span>
    </div>
  );
};

export default ResponderSyntaxSelect;
