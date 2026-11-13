/**
 * "Share contact" picker for the MeshCore composer (#6370). Lists every
 * contact on the source a contact-share token can describe (Companions,
 * Repeaters, Rooms), with a search box. Picking one hands its token back to
 * the composer, which inserts it at the caret.
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../common/Modal';
import { UiIcon } from '../icons';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';
import { filterShareableContacts, listShareableContacts } from './meshcoreContactShare';
import { meshcoreRoleIconName, meshcoreRoleLabelKey, MESHCORE_DEVICE_TYPE_LABELS } from './meshcoreRole';
import styles from './MeshCoreContactToken.module.css';

export interface MeshCoreShareContactPickerProps {
  isOpen: boolean;
  contacts: readonly MeshCoreContact[];
  selfPublicKey?: string | null;
  onPick: (token: string) => void;
  onClose: () => void;
}

export const MeshCoreShareContactPicker: React.FC<MeshCoreShareContactPickerProps> = ({
  isOpen,
  contacts,
  selfPublicKey,
  onPick,
  onClose,
}) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const all = useMemo(() => listShareableContacts(contacts, selfPublicKey), [contacts, selfPublicKey]);
  const shown = useMemo(() => filterShareableContacts(all, query), [all, query]);

  if (!isOpen) return null;

  const close = () => {
    setQuery('');
    onClose();
  };

  return (
    <Modal
      isOpen
      onClose={close}
      title={t('meshcore.contact_token.share_title', 'Share contact')}
      className={styles.pickerModal}
    >
      <input
        type="search"
        className={styles.search}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('meshcore.contact_token.search_placeholder', 'Search by name or key')}
        aria-label={t('meshcore.contact_token.search_placeholder', 'Search by name or key')}
        autoFocus
      />
      {shown.length === 0 ? (
        <p className={styles.hint}>
          {all.length === 0
            ? t('meshcore.contact_token.no_contacts', 'No contacts to share yet.')
            : t('meshcore.contact_token.no_matches', 'No contacts match.')}
        </p>
      ) : (
        <ul className={styles.pickerList} aria-label={t('meshcore.contact_token.share_title', 'Share contact')}>
          {shown.map((c) => {
            const icon = meshcoreRoleIconName(c.type);
            return (
              <li key={c.publicKey}>
                <button
                  type="button"
                  className={styles.pickerItem}
                  onClick={() => {
                    setQuery('');
                    onPick(c.token);
                  }}
                  title={c.token}
                >
                  {icon && <UiIcon name={icon} size={16} />}
                  <span className={styles.pickerName}>{c.name}</span>
                  <span className={styles.pickerMeta}>
                    {t(meshcoreRoleLabelKey(c.type), MESHCORE_DEVICE_TYPE_LABELS[c.type])}
                    {' · '}
                    {c.publicKey.slice(0, 8).toUpperCase()}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
};

export default MeshCoreShareContactPicker;
