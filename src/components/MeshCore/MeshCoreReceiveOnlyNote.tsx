/**
 * MeshCoreReceiveOnlyNote — MeshCore wording over the shared paused note
 * (#4547 Phase 2 WP1; generalised in #5807).
 *
 * The receive-only-mode explanation shows up at every section whose
 * configuration inputs stay editable but whose effect is paused while
 * transmission is blocked (interview decision 5 — see
 * docs/internal/dev-notes/MESHCORE_RECEIVE_ONLY_PHASE2_SPEC.md §3.1). The
 * markup lives in `shared/config/ReceiveOnlyNote`; this wrapper only supplies
 * the MeshCore "receive-only mode" text.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ReceiveOnlyNote } from '../shared/config/ReceiveOnlyNote';
import { meshCoreReceiveOnlyText } from './meshCoreReceiveOnlyText';

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
  return (
    <ReceiveOnlyNote receiveOnly={receiveOnly} className={className}>
      {meshCoreReceiveOnlyText(t)}
    </ReceiveOnlyNote>
  );
};

export default MeshCoreReceiveOnlyNote;
