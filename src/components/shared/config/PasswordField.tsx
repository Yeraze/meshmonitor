/**
 * PasswordField — a password input with a show/hide toggle (#5828, part of #5797).
 *
 * A controlled `<input>` that renders `type="password"` until the user presses
 * the eye button beside it, which flips it to `type="text"`. The toggle is a
 * plain `type="button"`, so it never submits the surrounding form, and it is
 * disabled along with the input. The field drops back to hidden whenever it is
 * disabled; the visible state is local, so it also resets on unmount.
 *
 * Every other input prop (id, name, placeholder, aria-*, disabled, className,
 * …) passes straight to the `<input>`, so callers keep their own "leave blank
 * to keep the stored value" placeholders and help text unchanged. The field
 * never logs or stores the value.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../../icons';
import styles from './PasswordField.module.css';

export interface PasswordFieldProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> {
  value: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  /** Class for the wrapper that holds the input and the toggle. */
  wrapperClassName?: string;
}

export const PasswordField: React.FC<PasswordFieldProps> = ({
  value,
  onChange,
  disabled,
  autoComplete = 'new-password',
  className,
  wrapperClassName,
  ...inputProps
}) => {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (disabled) setVisible(false);
  }, [disabled]);

  const shown = visible && !disabled;
  const label = shown
    ? t('common.hide_password', 'Hide password')
    : t('common.show_password', 'Show password');

  return (
    <span className={wrapperClassName ? `${styles.wrapper} ${wrapperClassName}` : styles.wrapper}>
      <input
        {...inputProps}
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        disabled={disabled}
        autoComplete={autoComplete}
        className={className ? `${styles.input} ${className}` : styles.input}
      />
      <button
        type="button"
        className={styles.toggle}
        onClick={() => setVisible((v) => !v)}
        disabled={disabled}
        aria-label={label}
        aria-pressed={shown}
        title={label}
      >
        <UiIcon name={shown ? 'visibilityOff' : 'visibility'} size={16} />
      </button>
    </span>
  );
};

export default PasswordField;
