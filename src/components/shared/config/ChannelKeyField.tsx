/**
 * ChannelKeyField — the channel key input shared by Meshtastic and MeshCore
 * (#5829).
 *
 * Masked by default, with Show / Hide, Copy and Generate. `format` picks how
 * the key is written (Meshtastic base64, MeshCore hex) and `generateBytes`
 * how long a generated key is. `allowedBytes` lists the lengths that count as
 * valid; anything else shows `invalidMessage` and sets `aria-invalid`.
 *
 * `readOnly` locks the field and Generate, for a key the caller derives (a
 * MeshCore hashtag channel); `hint` explains where it came from.
 */
import React, { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../../icons';
import { type ChannelKeyFormat, generateChannelKey, isValidChannelKey } from './channelKey';
import styles from './ChannelKeyField.module.css';

export interface ChannelKeyFieldProps {
  id: string;
  label: React.ReactNode;
  /** Muted text inside the label, under the title. */
  description?: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  format: ChannelKeyFormat;
  /** Length of a generated key, in bytes. */
  generateBytes: number;
  /** Valid decoded lengths. 0 means an empty field is allowed. Omit to skip the check. */
  allowedBytes?: readonly number[];
  invalidMessage?: React.ReactNode;
  readOnly?: boolean;
  /** Shown under the field, e.g. "derived from the name". */
  hint?: React.ReactNode;
  disabled?: boolean;
  placeholder?: string;
}

const COPIED_MS = 2000;

export const ChannelKeyField: React.FC<ChannelKeyFieldProps> = ({
  id,
  label,
  description,
  value,
  onChange,
  format,
  generateBytes,
  allowedBytes,
  invalidMessage,
  readOnly = false,
  hint,
  disabled = false,
  placeholder,
}) => {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const errorId = useId();
  const hintId = useId();

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const invalid = allowedBytes !== undefined && !isValidChannelKey(value, format, allowedBytes);
  const describedBy = [invalid ? errorId : '', hint ? hintId : ''].filter(Boolean).join(' ') || undefined;

  const handleCopy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
        {description && <span className="setting-description">{description}</span>}
      </label>
      <div className={styles.row}>
        <input
          id={id}
          type={shown ? 'text' : 'password'}
          className={`setting-input ${styles.input}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          readOnly={readOnly}
          disabled={disabled}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          data-format={format}
        />
        <button
          type="button"
          className={styles.button}
          onClick={() => setShown((v) => !v)}
          disabled={disabled}
          aria-pressed={shown}
          aria-controls={id}
        >
          <UiIcon name={shown ? 'visibilityOff' : 'visibility'} size={14} />
          {shown ? t('channel_key.hide', 'Hide') : t('channel_key.show', 'Show')}
        </button>
        <button
          type="button"
          className={styles.button}
          onClick={() => { void handleCopy(); }}
          disabled={disabled || !value}
        >
          <UiIcon name={copied ? 'check' : 'copy'} size={14} />
          {copied ? t('channel_key.copied', 'Copied') : t('channel_key.copy', 'Copy')}
        </button>
        <button
          type="button"
          className={styles.button}
          onClick={() => onChange(generateChannelKey(generateBytes, format))}
          disabled={disabled || readOnly}
          title={t('channel_key.generate_title', 'Generate a new random key ({{bits}}-bit)', { bits: generateBytes * 8 })}
        >
          <UiIcon name="refresh" size={14} />
          {t('channel_key.generate', 'Generate')}
        </button>
      </div>
      {invalid && (
        <p id={errorId} className={styles.error} role="alert">
          <UiIcon name="alert" size={12} /> {invalidMessage ?? t('channel_key.invalid', 'This key is not valid.')}
        </p>
      )}
      {hint && <p id={hintId} className={styles.hint}>{hint}</p>}
    </div>
  );
};

export default ChannelKeyField;
