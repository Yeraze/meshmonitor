/**
 * The "Beacons" button and its count (#4723, #5232).
 *
 * Replaces the inline stack of invitation cards that used to render above the
 * channel list. Beacons re-advertise on their own interval, so the cards had no
 * end state: two nearby meshes squeezed the message list to a sliver on a phone
 * and came back after every dismissal. A button with a count takes one line
 * whatever the mesh is doing, and the list lives in a modal
 * (`BeaconsModal`) with search, sorting and a filter for hidden rows.
 *
 * Renders nothing when the source has never heard a beacon, so installs on
 * pre-2.8 firmware (which never emits them) see no empty surface. The count is
 * of *pending* offers, but the button stays once anything has been heard — a
 * user who muted every beacon still needs a way back to un-mute one.
 */
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons/UiIcon';
import BeaconJoinDialog from './BeaconJoinDialog';
import BeaconsModal from './BeaconsModal';
import { useBeaconOffers } from './useBeaconOffers';
import { JOINABLE_SLOTS, type PendingAccept, type PublicBeaconOffer } from './types';
import styles from './Beacons.module.css';

export interface BeaconsPanelProps {
  sourceId?: string | null;
  /** Existing channels, used to label occupied slots in the confirm dialog. */
  channels: Array<{ id: number; name: string }>;
  /** False hides the join/dismiss/mute actions (read-only viewer). */
  canWrite?: boolean;
  /** Resolve a node number to a display name; falls back to hex id. */
  nodeName?: (nodeNum: number) => string | undefined;
}

export default function BeaconsPanel({
  sourceId,
  channels,
  canWrite = true,
  nodeName,
}: BeaconsPanelProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<PendingAccept | null>(null);
  const [busy, setBusy] = useState(false);

  const beacons = useBeaconOffers(sourceId);
  const { setListOpen, pendingCount, totalCount, offers } = beacons;

  const occupiedBySlot = useMemo(() => {
    const map = new Map<number, string>();
    for (const c of channels ?? []) {
      if (c.name) map.set(c.id, c.name);
    }
    return map;
  }, [channels]);

  const openList = useCallback(() => { setListOpen(true); setOpen(true); }, [setListOpen]);
  const closeList = useCallback(() => { setOpen(false); setListOpen(false); }, [setListOpen]);

  /** Wrap a write so a failure cannot leave the row's buttons permanently disabled. */
  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      // The hook has already surfaced the message on `beacons.error`.
    } finally {
      setBusy(false);
    }
  }, []);

  const startJoin = useCallback((offer: PublicBeaconOffer) => {
    const free = JOINABLE_SLOTS.find((s) => !occupiedBySlot.has(s));
    setPending({ offer, slot: free ?? JOINABLE_SLOTS[0] });
  }, [occupiedBySlot]);

  const confirmAccept = useCallback(async (overwrite: boolean) => {
    if (!pending) return;
    await run(async () => {
      await beacons.accept(pending.offer.nodeNum, pending.slot, overwrite);
      setPending(null);
    });
  }, [beacons, pending, run]);

  // The button appears the moment anything has been heard, and disappears only
  // when the table is genuinely empty for this source. `pendingCount` alone
  // would hide the only route back to a muted beacon.
  if (!sourceId) return null;
  if (totalCount === 0 && !open) return null;

  return (
    <>
      <button
        type="button"
        className={styles.beaconsButton}
        onClick={openList}
        data-testid="beacons-button"
        aria-haspopup="dialog"
        title={t('beacons.button_title', 'Mesh invitations heard on this source')}
      >
        <UiIcon name="announcement" />
        {t('beacons.button', 'Beacons')}
        {pendingCount > 0 && (
          <span className={styles.beaconsBadge} data-testid="beacons-badge">{pendingCount}</span>
        )}
      </button>

      {open && (
        <BeaconsModal
          offers={offers}
          loading={beacons.loading}
          error={beacons.error}
          canWrite={canWrite}
          nodeName={nodeName}
          busy={busy}
          escapeCloses={!pending}
          onClose={closeList}
          onJoin={startJoin}
          onDismiss={(o) => void run(() => beacons.dismiss(o.nodeNum))}
          onMute={(o) => void run(() => beacons.mute(o.nodeNum))}
          onRestore={(o) => void run(() => beacons.restore(o.nodeNum))}
        />
      )}

      {pending && (
        <BeaconJoinDialog
          pending={pending}
          occupiedBySlot={occupiedBySlot}
          busy={busy}
          onSlotChange={(slot) => setPending({ ...pending, slot })}
          onCancel={() => { setPending(null); beacons.clearError(); }}
          onConfirm={(overwrite) => void confirmAccept(overwrite)}
        />
      )}
    </>
  );
}
