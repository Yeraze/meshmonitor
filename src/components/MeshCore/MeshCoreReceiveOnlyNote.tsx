/**
 * MeshCoreReceiveOnlyNote — shared "paused" note (#4547 Phase 2 WP1).
 *
 * The receive-only-mode explanation shows up at every section whose
 * configuration inputs stay editable but whose effect is paused while
 * transmission is blocked (interview decision 5 — see
 * docs/internal/dev-notes/MESHCORE_RECEIVE_ONLY_PHASE2_SPEC.md §3.1). Seven
 * call sites would otherwise each hand-roll the same icon + string + inline
 * style, so this renders `null` when not receive-only and a single
 * `role="status"` line otherwise, keeping every call site to one line.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import styles from './MeshCoreReceiveOnlyNote.module.css';

interface MeshCoreReceiveOnlyNoteProps {
  /** When falsy, the component renders nothing. */
  receiveOnly?: boolean;
  className?: string;
}

export const MeshCoreReceiveOnlyNote: React.FC<MeshCoreReceiveOnlyNoteProps> = ({
  receiveOnly,
  className,
}) => {
  const { t } = useTranslation();
  if (!receiveOnly) return null;

  return (
    <p role="status" className={className ? `${styles.note} ${className}` : styles.note}>
      <UiIcon name="pause" size={14} />
      {t(
        'meshcore.receive_only.paused_note',
        'Paused — receive-only mode. These settings are saved and unchanged; they take effect again when receive-only is turned off.',
      )}
    </p>
  );
};

export default MeshCoreReceiveOnlyNote;
