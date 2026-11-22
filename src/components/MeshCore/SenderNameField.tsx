/**
 * SenderNameField - "Send as" picker for a MeshCore automation (#6341 P4).
 *
 * Reads the names this user may pick on the source (sender-names GET, which
 * passes on automation:write) and shows the shared SenderNamePicker. Hidden
 * when the feature is off, firmware is too old, or the read fails, unless a
 * name is already stored, so an admin can still see and clear it. A stored
 * name no longer on the list gets a note: it sends under the node name.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSourceSenderNames } from './hooks/useSourceSenderNames';
import { SenderNamePicker } from './SenderNamePicker';
import styles from './SenderNameField.module.css';

export interface SenderNameFieldProps {
  baseUrl: string;
  sourceId: string;
  /** Stored name; '' or undefined = node name. */
  value?: string;
  onChange: (name: string | undefined) => void;
  /** Shown when set; helps a user tell which send this applies to. */
  idPrefix?: string;
}

export const SenderNameField: React.FC<SenderNameFieldProps> = ({
  baseUrl,
  sourceId,
  value,
  onChange,
  idPrefix = 'mc-sender-name',
}) => {
  const { t } = useTranslation();
  const names = useSourceSenderNames(baseUrl, sourceId);
  const stored = value ?? '';
  if (names.length === 0 && !stored) return null;
  const stale = stored !== '' && !names.includes(stored);
  return (
    <div className={styles.field}>
      <SenderNamePicker
        id={`${idPrefix}-select`}
        names={names}
        value={stored}
        onChange={n => onChange(n === '' ? undefined : n)}
      />
      {stale && (
        <span className={styles.stale} role="note">
          {t('meshcore.sender_name.stale', '(no longer allowed: {{name}}), sends as node name', { name: stored })}
        </span>
      )}
    </div>
  );
};

export default SenderNameField;
