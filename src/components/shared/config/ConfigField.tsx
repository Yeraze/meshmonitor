/**
 * ConfigField — one labelled settings row (#5807): the shared
 * `div.setting-item > label{title + span.setting-description} + control`
 * markup from src/styles/settings.css, for new code.
 *
 * Pass `htmlFor` to tie the label to a control rendered as `children`.
 */
import React from 'react';

export interface ConfigFieldProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  /** id of the control in `children`. */
  htmlFor?: string;
  className?: string;
  children?: React.ReactNode;
}

export const ConfigField: React.FC<ConfigFieldProps> = ({
  label,
  description,
  htmlFor,
  className,
  children,
}) => (
  <div className={className ? `setting-item ${className}` : 'setting-item'}>
    <label htmlFor={htmlFor}>
      {label}
      {description && <span className="setting-description">{description}</span>}
    </label>
    {children}
  </div>
);

export default ConfigField;
