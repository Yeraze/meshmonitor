/**
 * SenderNamePicker - choose the name a MeshCore channel send goes out under
 * (#6341 P4). Shared by the channel composer and the automation editors.
 *
 * `value` '' means "the node's own name" (no override). The caller hides the
 * picker when there is nothing to pick (see `useUsableSenderNames`).
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import styles from './SenderNamePicker.module.css';

export interface SenderNamePickerProps {
  /** Names the user may pick, from the usable-names GET. */
  names: string[];
  /** '' = node name. */
  value: string;
  onChange: (name: string) => void;
  /** Shown in the first option, e.g. "(node name: Base)". */
  nodeName?: string | null;
  id?: string;
  disabled?: boolean;
}

export const SenderNamePicker: React.FC<SenderNamePickerProps> = ({
  names,
  value,
  onChange,
  nodeName,
  id,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const label = t('meshcore.sender_name.picker_label', 'Send as');
  // A value no longer on the list stays visible so it is not silently swapped.
  const extra = value && !names.includes(value) ? [value] : [];
  return (
    <div className={styles.picker}>
      <label className={styles.label} htmlFor={id}>{label}</label>
      <select
        id={id}
        className={styles.select}
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
      >
        <option value="">
          {nodeName
            ? t('meshcore.sender_name.node_name_with', '(node name: {{name}})', { name: nodeName })
            : t('meshcore.sender_name.node_name', '(node name)')}
        </option>
        {[...names, ...extra].map(n => <option key={n} value={n}>{n}</option>)}
      </select>
    </div>
  );
};

export default SenderNamePicker;
