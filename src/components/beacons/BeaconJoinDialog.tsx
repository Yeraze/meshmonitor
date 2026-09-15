/**
 * The confirmation step for accepting a beacon offer (#4723).
 *
 * Accepting always goes through this dialog: it is a radio write, so there is
 * no one-click path from the list to the device. The dialog names the channel
 * and the destination slot, and when that slot already holds a channel it
 * requires a second, differently-worded button — replacing an existing channel
 * is a distinct choice from accepting an invitation, and one the user may not
 * have realised they were making.
 *
 * The server enforces the same two things (`confirm`, `overwrite`), so this is
 * the explanation rather than the guard.
 *
 * Extracted from the old inline invitation panel in #5232 so the beacons modal
 * and anything else that can start a join share one dialog.
 */
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons/UiIcon';
import type { PublicBeaconOffer } from './types';
import styles from './Beacons.module.css';

/** Meshtastic slots 1-7 are join targets; 0 is the primary and is never offered. */
export const JOINABLE_SLOTS = [1, 2, 3, 4, 5, 6, 7];

export interface PendingAccept {
  offer: PublicBeaconOffer;
  slot: number;
}

export interface BeaconJoinDialogProps {
  pending: PendingAccept;
  /** Slot number → the name of the channel already in it. */
  occupiedBySlot: Map<number, string>;
  busy: boolean;
  onSlotChange: (slot: number) => void;
  onCancel: () => void;
  onConfirm: (overwrite: boolean) => void;
}

export default function BeaconJoinDialog({
  pending, occupiedBySlot, busy, onSlotChange, onCancel, onConfirm,
}: BeaconJoinDialogProps) {
  const { t } = useTranslation();
  const occupant = occupiedBySlot.get(pending.slot);

  return (
    <div className={styles.beaconConfirmOverlay} onClick={onCancel}>
      <div
        className={styles.beaconConfirmDialog}
        role="dialog"
        aria-modal="true"
        aria-label={t('beacons.confirm_title')}
        data-testid="beacon-confirm-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <h4>{t('beacons.confirm_title')}</h4>
        <p>
          {t('beacons.confirm_body', {
            channel: pending.offer.offerChannelName ?? '',
            slot: pending.slot,
          })}
        </p>

        <label className={styles.beaconConfirmSlot}>
          {t('beacons.slot_label')}
          <select
            value={pending.slot}
            disabled={busy}
            onChange={(e) => onSlotChange(Number(e.target.value))}
          >
            {JOINABLE_SLOTS.map((s) => (
              <option key={s} value={s}>
                {occupiedBySlot.has(s)
                  ? t('beacons.slot_in_use', { slot: s, name: occupiedBySlot.get(s) })
                  : t('beacons.slot_free', { slot: s })}
              </option>
            ))}
          </select>
        </label>

        {occupant && (
          <p className={styles.beaconConfirmWarning} role="alert" data-testid="beacon-confirm-overwrite-warning">
            <UiIcon name="alert" /> {t('beacons.confirm_overwrite', { name: occupant, slot: pending.slot })}
          </p>
        )}

        <div className={styles.beaconConfirmActions}>
          <button type="button" onClick={onCancel} disabled={busy}>{t('common.cancel')}</button>
          <button
            type="button"
            className={`${styles.beaconConfirmGo}${occupant ? ` ${styles.beaconConfirmDanger}` : ''}`}
            data-testid="beacon-confirm-go"
            disabled={busy}
            onClick={() => onConfirm(Boolean(occupant))}
          >
            {occupant ? t('beacons.confirm_replace') : t('beacons.confirm_join')}
          </button>
        </div>
      </div>
    </div>
  );
}
