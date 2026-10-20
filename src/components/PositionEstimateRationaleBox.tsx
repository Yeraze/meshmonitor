/**
 * Explains an ESTIMATED position on the Node Details block (#5900).
 *
 * Reads GET /api/nodes/:nodeNum/position-estimate (#4609) and says, in plain
 * words, how the pin was placed: one anchor and a radio-range guess, or a fit
 * from several anchors; how wide the circle is; how many observations and
 * distinct anchors fed it; when it was computed; and which anchors they were.
 *
 * The parent renders this only when the displayed position is an estimate.
 * The server filters the anchor list to what the caller may see, so a partial
 * list is normal and is labelled as such.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService, { type PositionEstimateRationale } from '../services/api';
import { formatDistance, formatUncertaintyRadius } from '../utils/distance';
import { formatRelativeTime } from '../utils/datetime';
import type { TimeFormat, DateFormat } from '../contexts/SettingsContext';
import { UiIcon } from './icons';
import styles from './PositionEstimateRationaleBox.module.css';

interface Props {
  nodeNum: number;
  distanceUnit: 'km' | 'mi';
  timeFormat?: TimeFormat;
  dateFormat?: DateFormat;
}

/** Lists longer than this start collapsed. */
const COLLAPSE_ABOVE = 3;

const PositionEstimateRationaleBox: React.FC<Props> = ({ nodeNum, distanceUnit, timeFormat = '24', dateFormat = 'MM/DD/YYYY' }) => {
  const { t } = useTranslation();
  const [rationale, setRationale] = useState<PositionEstimateRationale | null>(null);
  const [showAnchors, setShowAnchors] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRationale(null);
    apiService.getPositionEstimate(nodeNum)
      .then((r) => {
        if (cancelled) return;
        setRationale(r);
        setShowAnchors(r.anchors.length <= COLLAPSE_ABOVE);
      })
      // No estimate (404) or no access: the box simply does not render.
      .catch(() => { if (!cancelled) setRationale(null); });
    return () => { cancelled = true; };
  }, [nodeNum]);

  if (!rationale) return null;

  const uniqueLabel = rationale.uniqueAnchorsIsLowerBound
    ? `${rationale.uniqueAnchors}+`
    : String(rationale.uniqueAnchors);

  let method: string;
  switch (rationale.radiusMethod) {
    case 'single_anchor':
      method = t(
        'node_details.estimate_method_single',
        'Single anchor: radio-range default. Only one anchor location heard this node, so it can only be placed within radio range of it ({{km}} km).',
        { km: rationale.singleAnchorDefaultKm },
      );
      break;
    case 'blended':
      method = t(
        'node_details.estimate_method_blended',
        'Partly converged from {{anchors}} anchors. The anchors are uneven, so the radius is part radio-range default, part measured spread.',
        { anchors: uniqueLabel },
      );
      break;
    case 'convergence':
      method = t(
        'node_details.estimate_method_convergence',
        'Converged from {{anchors}} anchors. The radius comes from how far apart the anchors sit.',
        { anchors: uniqueLabel },
      );
      break;
    default:
      method = t(
        'node_details.estimate_method_unknown',
        'Method unknown. This estimate was written by an older version and will be refreshed on the next run.',
      );
  }

  const radius = rationale.uncertaintyKm != null
    ? formatUncertaintyRadius(rationale.uncertaintyKm * 1000, distanceUnit)
    : null;

  return (
    <section className={styles.box} aria-labelledby={`estimate-rationale-${nodeNum}`}>
      <h4 className={styles.title} id={`estimate-rationale-${nodeNum}`}>
        <UiIcon name="target" /> {t('node_details.estimate_title', 'How this position was estimated')}
      </h4>
      <p className={styles.method}>{method}</p>
      <dl className={styles.facts}>
        <div>
          <dt>{t('node_details.estimate_radius', 'Uncertainty')}</dt>
          <dd>{radius ?? t('node_details.estimate_unknown', 'Unknown')}</dd>
        </div>
        <div>
          <dt>{t('node_details.estimate_observations', 'Observations')}</dt>
          <dd>{rationale.observationCount}</dd>
        </div>
        <div>
          <dt>{t('node_details.estimate_unique_anchors', 'Unique anchors')}</dt>
          <dd>{uniqueLabel}</dd>
        </div>
        <div>
          <dt>{t('node_details.estimate_computed', 'Computed')}</dt>
          <dd>{formatRelativeTime(rationale.updatedAt, timeFormat, dateFormat, false)}</dd>
        </div>
      </dl>

      {rationale.anchors.length > 0 && (
        <>
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={showAnchors}
            onClick={() => setShowAnchors((v) => !v)}
          >
            <UiIcon name={showAnchors ? 'chevronDown' : 'chevronRight'} />
            {t('node_details.estimate_anchor_list', 'Anchors ({{count}})', { count: rationale.anchors.length })}
          </button>
          {showAnchors && (
            <ul className={styles.anchors}>
              {rationale.anchors.map((a, i) => (
                <li key={`${a.anchorNodeNum}-${a.observedAt}-${i}`} className={styles.anchor}>
                  <span className={styles.anchorName}>
                    {a.anchorLongName || a.anchorShortName || a.anchorNodeId}
                    {(a.anchorLongName || a.anchorShortName) && (
                      <span className={styles.anchorId}> {a.anchorNodeId}</span>
                    )}
                  </span>
                  <span className={styles.anchorMeta}>
                    {a.kind === 'neighbor'
                      ? t('node_details.estimate_kind_neighbor', 'Neighbor')
                      : t('node_details.estimate_kind_traceroute', 'Traceroute')}
                    {' · '}
                    {a.snrDb != null
                      ? t('node_details.estimate_snr', 'SNR {{snr}} dB', { snr: a.snrDb.toFixed(2) })
                      : t('node_details.estimate_snr_unknown', 'SNR unknown')}
                    {' · '}
                    {t('node_details.estimate_weight', 'weight {{weight}}', { weight: a.weight.toPrecision(3) })}
                    {' · '}
                    {t('node_details.estimate_distance', '{{distance}} from estimate', {
                      distance: formatDistance(a.distanceKm, distanceUnit, 2),
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {rationale.anchorsTruncated && (
        <p className={styles.note}>
          {t('node_details.estimate_partial', 'Showing {{shown}} of {{total}} observations.', {
            shown: rationale.anchors.length,
            total: rationale.observationCount,
          })}
        </p>
      )}
    </section>
  );
};

export default PositionEstimateRationaleBox;
