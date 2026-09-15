/**
 * The received-beacons list (#5232).
 *
 * Replaces the stack of invitation cards that used to sit inline above the
 * channel list. The cards were fine for one invitation and unusable for three:
 * on a phone they pushed the message list down to a sliver, and because a
 * beacon re-advertises on its own interval there was no end state where they
 * stayed gone.
 *
 * So this is a table over the deduped `mesh_beacon_offers` rows — one row per
 * beaconing node, with when it was first and last heard — behind a button, with
 * search, sorting, and a filter for the ones already hidden.
 *
 * **Un-actionable offers are listed, with the reason, not hidden.** A user who
 * can see "this beacon named a channel but withheld its key" learns something;
 * an empty list where a neighbour is plainly beaconing looks broken. See
 * `beaconOfferActionability.ts`.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons/UiIcon';
import { assessBeaconOffer, type OfferActionability } from './beaconOfferActionability';
import { nodeHexId, selectOffers } from './beaconList';
import { isHidden, type BeaconFilter, type BeaconSort, type BeaconSortKey, type PublicBeaconOffer } from './types';
import styles from './Beacons.module.css';

export interface BeaconsModalProps {
  offers: PublicBeaconOffer[];
  loading: boolean;
  error: string | null;
  /** False hides every write action (read-only viewer). */
  canWrite: boolean;
  /** Resolve a node number to a display name; falls back to its hex id. */
  nodeName?: (nodeNum: number) => string | undefined;
  onClose: () => void;
  onJoin: (offer: PublicBeaconOffer) => void;
  onDismiss: (offer: PublicBeaconOffer) => void;
  onMute: (offer: PublicBeaconOffer) => void;
  onRestore: (offer: PublicBeaconOffer) => void;
  busy: boolean;
  /**
   * False while the join confirmation is layered on top, so one Escape does not
   * close the list out from under the dialog that was launched from it.
   */
  escapeCloses?: boolean;
}

export default function BeaconsModal({
  offers, loading, error, canWrite, nodeName,
  onClose, onJoin, onDismiss, onMute, onRestore, busy, escapeCloses = true,
}: BeaconsModalProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<BeaconFilter>('pending');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<BeaconSort>({ key: 'lastSeenAt', direction: 'desc' });

  const rows = useMemo(
    () => selectOffers(offers, filter, query, sort, nodeName),
    [offers, filter, query, sort, nodeName],
  );

  const hiddenCount = useMemo(() => offers.filter(isHidden).length, [offers]);

  // Escape closes the list, like every other overlay in the app. Bound to the
  // document rather than the dialog so it works before anything inside has
  // taken focus.
  useEffect(() => {
    if (!escapeCloses) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [escapeCloses, onClose]);

  /** Clicking the active column flips direction; a new column starts descending
   *  for times (newest first) and ascending for text. */
  const toggleSort = (key: BeaconSortKey) => {
    setSort((prev) => prev.key === key
      ? { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: key === 'node' || key === 'channel' ? 'asc' : 'desc' });
  };

  const sortIndicator = (key: BeaconSortKey) => sort.key !== key
    ? null
    : <UiIcon name={sort.direction === 'asc' ? 'sortAscending' : 'sortDescending'} />;

  // `aria-sort` belongs on the header cell, not on the control inside it — a
  // screen reader reads the column's sort state off the <th>.
  const header = (key: BeaconSortKey, labelKey: string, fallback: string) => (
    <th
      scope="col"
      aria-sort={sort.key === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className={styles.beaconSortButton}
        onClick={() => toggleSort(key)}
        data-testid={`beacon-sort-${key}`}
      >
        {t(labelKey, fallback)} {sortIndicator(key)}
      </button>
    </th>
  );

  return (
    <div className={styles.beaconModalOverlay} onClick={onClose}>
      <div
        className={styles.beaconModal}
        role="dialog"
        aria-modal="true"
        aria-label={t('beacons.panel_title')}
        data-testid="beacons-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.beaconModalHead}>
          <h3 className={styles.beaconModalTitle}>
            <UiIcon name="announcement" /> {t('beacons.panel_title')}
          </h3>
          <button
            type="button"
            className={styles.beaconModalClose}
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
            data-testid="beacons-modal-close"
          >
            <UiIcon name="close" />
          </button>
        </div>

        <div className={styles.beaconModalControls}>
          <label className={styles.beaconSearch}>
            <UiIcon name="search" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('beacons.search_placeholder', 'Search node, channel or message')}
              aria-label={t('beacons.search_placeholder', 'Search node, channel or message')}
              data-testid="beacons-search"
            />
          </label>

          <div className={styles.beaconFilters} role="group" aria-label={t('beacons.filter_label', 'Show')}>
            {(['pending', 'hidden', 'all'] as BeaconFilter[]).map((f) => (
              <button
                key={f}
                type="button"
                className={`${styles.beaconFilter}${filter === f ? ` ${styles.beaconFilterActive}` : ''}`}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                data-testid={`beacons-filter-${f}`}
              >
                {f === 'pending' && t('beacons.filter_pending', 'Pending')}
                {f === 'hidden' && t('beacons.filter_hidden', 'Hidden ({{count}})', { count: hiddenCount })}
                {f === 'all' && t('beacons.filter_all', 'All')}
              </button>
            ))}
          </div>
        </div>

        {error && <div className={styles.beaconOffersError} role="alert">{error}</div>}

        {loading && rows.length === 0 && (
          <p className={styles.beaconEmpty}>{t('beacons.loading', 'Loading beacons…')}</p>
        )}

        {!loading && rows.length === 0 && (
          <p className={styles.beaconEmpty} data-testid="beacons-empty">
            {query.trim()
              ? t('beacons.no_matches', 'No beacons match that search.')
              : filter === 'hidden'
                ? t('beacons.none_hidden', 'Nothing has been dismissed or muted.')
                : t('beacons.none_pending', 'No beacons have been heard on this source.')}
          </p>
        )}

        {rows.length > 0 && (
          <div className={styles.beaconTableWrap}>
            <table className={styles.beaconTable}>
              <thead>
                <tr>
                  {header('node', 'beacons.col_node', 'Node')}
                  {header('channel', 'beacons.col_channel', 'Offer')}
                  {header('firstSeenAt', 'beacons.col_first_heard', 'First heard')}
                  {header('lastSeenAt', 'beacons.col_last_heard', 'Last heard')}
                  <th scope="col">{t('beacons.col_actions', 'Actions')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((offer) => (
                  <BeaconRow
                    key={`${offer.sourceId}:${offer.nodeNum}`}
                    offer={offer}
                    who={nodeName?.(offer.nodeNum) ?? nodeHexId(offer.nodeNum)}
                    canWrite={canWrite}
                    busy={busy}
                    onJoin={onJoin}
                    onDismiss={onDismiss}
                    onMute={onMute}
                    onRestore={onRestore}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function BeaconRow({
  offer, who, canWrite, busy, onJoin, onDismiss, onMute, onRestore,
}: {
  offer: PublicBeaconOffer;
  who: string;
  canWrite: boolean;
  busy: boolean;
  onJoin: (offer: PublicBeaconOffer) => void;
  onDismiss: (offer: PublicBeaconOffer) => void;
  onMute: (offer: PublicBeaconOffer) => void;
  onRestore: (offer: PublicBeaconOffer) => void;
}) {
  const { t } = useTranslation();
  const verdict: OfferActionability = assessBeaconOffer(offer);
  const hidden = isHidden(offer);

  return (
    <tr
      className={hidden ? styles.beaconRowHidden : undefined}
      data-testid={`beacon-offer-${offer.nodeNum}`}
    >
      <td>
        <span className={styles.beaconOfferNode}>{who}</span>
        {offer.message && <p className={styles.beaconOfferMessage}>{offer.message}</p>}
        {offer.mutedAt != null && (
          <span className={styles.beaconBadge} data-testid={`beacon-muted-${offer.nodeNum}`}>
            <UiIcon name="muted" /> {t('beacons.status_muted', 'Muted')}
          </span>
        )}
        {offer.mutedAt == null && offer.dismissedAt != null && (
          <span className={styles.beaconBadge} data-testid={`beacon-dismissed-${offer.nodeNum}`}>
            {t('beacons.status_dismissed', 'Dismissed')}
          </span>
        )}
      </td>

      <td>
        {offer.offerChannelName
          ? (
            <span className={styles.beaconOfferChannel}>
              <UiIcon name="channels" /> {offer.offerChannelName}
              {offer.hasChannelKey && <UiIcon name="encryptedKey" />}
            </span>
          )
          : <span className={styles.beaconOfferMuted}>{t('beacons.no_channel', '—')}</span>}

        {/* Context, never an action — applying a region/preset would rewrite
            the radio's LoRa config, which this list does not do. */}
        {verdict.presetNote && <p className={styles.beaconOfferNote}>{verdict.presetNote}</p>}

        {/* Regulator-compliance warning for the advertised region/preset
            (#5103). Warning-only, like the amateur-band notice on the local
            LoRa config — it describes the neighbour's mesh, never the join. */}
        {verdict.complianceNote && (
          <p role="alert" className={styles.beaconOfferWarning} data-testid="beacon-offer-compliance">
            <UiIcon name="alert" /> {verdict.complianceNote}
          </p>
        )}

        {/* Say why, rather than hiding the offer. */}
        {!verdict.actionable && (
          <p className={styles.beaconOfferReason} data-testid="beacon-offer-reason">
            <UiIcon name="blocked" /> {verdict.reason}
          </p>
        )}
      </td>

      <td>
        <time className={styles.beaconOfferTime} dateTime={new Date(offer.firstSeenAt).toISOString()}>
          {new Date(offer.firstSeenAt).toLocaleString()}
        </time>
      </td>
      <td>
        <time className={styles.beaconOfferTime} dateTime={new Date(offer.lastSeenAt).toISOString()}>
          {new Date(offer.lastSeenAt).toLocaleString()}
        </time>
      </td>

      <td>
        {canWrite && (
          <div className={styles.beaconOfferActions}>
            {verdict.actionable && !hidden && (
              <button type="button" className={styles.beaconOfferJoin} disabled={busy} onClick={() => onJoin(offer)}>
                {t('beacons.join_channel')}
              </button>
            )}
            {hidden
              ? (
                <button type="button" className={styles.beaconOfferSecondary} disabled={busy} onClick={() => onRestore(offer)}>
                  {t('beacons.restore', 'Restore')}
                </button>
              )
              : (
                <>
                  <button type="button" className={styles.beaconOfferSecondary} disabled={busy} onClick={() => onDismiss(offer)}>
                    {t('beacons.dismiss')}
                  </button>
                  <button
                    type="button"
                    className={styles.beaconOfferSecondary}
                    disabled={busy}
                    onClick={() => onMute(offer)}
                    title={t('beacons.mute_title', 'Never show beacons from this node again')}
                  >
                    <UiIcon name="muted" /> {t('beacons.mute', 'Mute')}
                  </button>
                </>
              )}
          </div>
        )}
      </td>
    </tr>
  );
}
