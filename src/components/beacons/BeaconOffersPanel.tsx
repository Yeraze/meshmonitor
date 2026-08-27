/**
 * MeshBeacon invitation cards (#4723).
 *
 * Renders offers received from beaconing neighbours as actionable cards. Two
 * maintainer decisions shape this component:
 *
 * 1. **Accepting always goes through an explicit confirmation.** It is a radio
 *    write, so there is no one-click path from the list to the device — the
 *    dialog names the channel and the destination slot, and calls out an
 *    occupied slot separately. The server enforces the same thing (`confirm`,
 *    `overwrite`), so the dialog is the explanation rather than the guard.
 * 2. **Un-actionable offers are shown, with the reason, not hidden.** A user
 *    who can see "this beacon named a channel but withheld its key" learns
 *    something; an empty list where a neighbour is plainly beaconing looks
 *    broken. See `beaconOfferActionability.ts`.
 *
 * Renders nothing at all when there are no offers, so installs on pre-2.8
 * firmware (which never emits beacons) see no empty surface.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../../services/api';
import { UiIcon } from '../icons/UiIcon';
import { assessBeaconOffer, type OfferActionability } from './beaconOfferActionability';
import styles from './BeaconOffersPanel.module.css';

/** Server projection — note there is no PSK field; the key stays server-side. */
export interface PublicBeaconOffer {
  sourceId: string;
  nodeNum: number;
  message: string | null;
  offerChannelName: string | null;
  hasChannelKey: boolean;
  offerRegion: number | null;
  offerPreset: number | null;
  hasOffer: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  dismissedAt: number | null;
}

export interface BeaconOffersPanelProps {
  sourceId?: string | null;
  /** Existing channels, used to label occupied slots in the confirm dialog. */
  channels: Array<{ id: number; name: string }>;
  /** False hides the accept/dismiss actions (read-only viewer). */
  canWrite?: boolean;
  /** Resolve a node number to a display name; falls back to hex id. */
  nodeName?: (nodeNum: number) => string | undefined;
}

/** Meshtastic slots 1-7 are join targets; 0 is the primary and is never offered. */
const JOINABLE_SLOTS = [1, 2, 3, 4, 5, 6, 7];

interface PendingAccept {
  offer: PublicBeaconOffer;
  slot: number;
}

export default function BeaconOffersPanel({
  sourceId,
  channels,
  canWrite = true,
  nodeName,
}: BeaconOffersPanelProps) {
  const { t } = useTranslation();
  const [offers, setOffers] = useState<PublicBeaconOffer[]>([]);
  const [pending, setPending] = useState<PendingAccept | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sourceId) { setOffers([]); return; }
    try {
      const res = await apiService.get<{ success: boolean; data: PublicBeaconOffer[] }>(
        `/api/sources/${encodeURIComponent(sourceId)}/beacon-offers`,
      );
      setOffers(res?.data ?? []);
      setError(null);
    } catch (e) {
      // A failed background poll leaves the last good list in place (beacons
      // rebroadcast, so it self-heals). But an outright failure with nothing to
      // show must NOT render as a silent empty panel — otherwise a broken fetch
      // is indistinguishable from "no offers" (#4946). Surface it so the render
      // guard below shows the error instead of returning null.
      setError(e instanceof Error ? e.message : t('beacons.load_failed', 'Failed to load beacon offers'));
    }
  }, [sourceId, t]);

  useEffect(() => { void load(); }, [load]);

  const occupiedBySlot = useMemo(() => {
    const map = new Map<number, string>();
    for (const c of channels ?? []) {
      if (c.name) map.set(c.id, c.name);
    }
    return map;
  }, [channels]);

  const dismiss = async (offer: PublicBeaconOffer) => {
    setBusy(true);
    try {
      await apiService.post(`/api/sources/${encodeURIComponent(sourceId!)}/beacon-offers/${offer.nodeNum}/dismiss`);
      setOffers((prev) => prev.filter((o) => o.nodeNum !== offer.nodeNum));
    } catch {
      setError(t('beacons.dismiss_failed'));
    } finally {
      setBusy(false);
    }
  };

  const confirmAccept = async (overwrite: boolean) => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await apiService.post(
        `/api/sources/${encodeURIComponent(sourceId!)}/beacon-offers/${pending.offer.nodeNum}/accept`,
        { slot: pending.slot, confirm: true, overwrite },
      );
      setOffers((prev) => prev.filter((o) => o.nodeNum !== pending.offer.nodeNum));
      setPending(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('beacons.accept_failed'));
    } finally {
      setBusy(false);
    }
  };

  // Nothing to show only when there are genuinely no offers AND no error.
  // A load failure must surface (below) rather than collapse to an empty panel.
  if (!sourceId) return null;
  if (offers.length === 0 && !error) return null;

  return (
    <section className={styles.beaconOffers} data-testid="beacon-offers-panel">
      <h3 className={styles.beaconOffersTitle}>
        <UiIcon name="announcement" /> {t('beacons.panel_title')}
      </h3>

      {error && <div className={styles.beaconOffersError} role="alert">{error}</div>}

      <ul className={styles.beaconOffersList}>
        {offers.map((offer) => {
          const verdict: OfferActionability = assessBeaconOffer(offer);
          const who = nodeName?.(offer.nodeNum) ?? `!${offer.nodeNum.toString(16).padStart(8, '0')}`;
          return (
            <li
              key={offer.nodeNum}
              className={`${styles.beaconOffer}${verdict.actionable ? '' : ` ${styles.beaconOfferInert}`}`}
              data-testid={`beacon-offer-${offer.nodeNum}`}
            >
              <div className={styles.beaconOfferHead}>
                <span className={styles.beaconOfferNode}>{who}</span>
                <time className={styles.beaconOfferTime} dateTime={new Date(offer.lastSeenAt).toISOString()}>
                  {new Date(offer.lastSeenAt).toLocaleString()}
                </time>
              </div>

              {offer.message && <p className={styles.beaconOfferMessage}>{offer.message}</p>}

              {offer.offerChannelName && (
                <p className={styles.beaconOfferChannel}>
                  <UiIcon name="channels" /> {offer.offerChannelName}
                  {offer.hasChannelKey && <UiIcon name="encryptedKey" />}
                </p>
              )}

              {/* Context, never an action — applying a region/preset would
                  rewrite the radio's LoRa config, which this card does not do. */}
              {verdict.presetNote && <p className={styles.beaconOfferNote}>{verdict.presetNote}</p>}

              {/* Decision 2: say why, rather than hiding the offer. */}
              {!verdict.actionable && (
                <p className={styles.beaconOfferReason} data-testid="beacon-offer-reason">
                  <UiIcon name="blocked" /> {verdict.reason}
                </p>
              )}

              {canWrite && (
                <div className={styles.beaconOfferActions}>
                  {verdict.actionable && (
                    <button
                      type="button"
                      className={styles.beaconOfferJoin}
                      disabled={busy}
                      onClick={() => {
                        const free = JOINABLE_SLOTS.find((s) => !occupiedBySlot.has(s));
                        setPending({ offer, slot: free ?? JOINABLE_SLOTS[0] });
                      }}
                    >
                      {t('beacons.join_channel')}
                    </button>
                  )}
                  <button type="button" className={styles.beaconOfferDismiss} disabled={busy} onClick={() => void dismiss(offer)}>
                    {t('beacons.dismiss')}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {pending && (
        <ConfirmJoinDialog
          pending={pending}
          occupiedBySlot={occupiedBySlot}
          busy={busy}
          onSlotChange={(slot) => setPending({ ...pending, slot })}
          onCancel={() => { setPending(null); setError(null); }}
          onConfirm={confirmAccept}
        />
      )}
    </section>
  );
}

/**
 * Decision 1: the explicit confirmation step.
 *
 * Names the channel and the destination slot, and when that slot already holds
 * a channel, requires a second, differently-worded button — replacing an
 * existing channel is a distinct choice from accepting an invitation, and one
 * the user may not have realised they were making.
 */
function ConfirmJoinDialog({
  pending, occupiedBySlot, busy, onSlotChange, onCancel, onConfirm,
}: {
  pending: PendingAccept;
  occupiedBySlot: Map<number, string>;
  busy: boolean;
  onSlotChange: (slot: number) => void;
  onCancel: () => void;
  onConfirm: (overwrite: boolean) => void;
}) {
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
                {occupiedBySlot.has(s) ? t('beacons.slot_in_use', { slot: s, name: occupiedBySlot.get(s) }) : t('beacons.slot_free', { slot: s })}
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
