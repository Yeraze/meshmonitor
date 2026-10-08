import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { useVectorFallbackNotice } from './vectorSupport';
import styles from './VectorFallbackNotice.module.css';

export interface VectorFallbackNoticeProps {
  /** True while this map draws a raster tileset in place of a vector one. */
  active: boolean;
  /** `unsupported`: the browser has no WebGL2. `context-lost`: this map had a
   *  working vector layer and the browser took its context away for good. */
  reason: 'unsupported' | 'context-lost';
}

/**
 * Small note in the map's bottom-left corner: "vector maps need WebGL, a
 * standard map is shown". Rendered by `BaseMap` inside the Leaflet container.
 *
 * Shown on one map at a time and never again once closed (see
 * `useVectorFallbackNotice`). The tileset picker carries the lasting
 * explanation next to the choice it applies to.
 */
export function VectorFallbackNotice({ active, reason }: VectorFallbackNoticeProps) {
  const { t } = useTranslation();
  const { show, dismiss } = useVectorFallbackNotice(active);
  const ref = useRef<HTMLDivElement | null>(null);

  // Keep a click or scroll on the note from panning or zooming the map under it.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);
  }, [show]);

  if (!show) return null;

  const text =
    reason === 'context-lost'
      ? t('map.vector_context_lost_notice', 'The vector map lost its graphics context. A standard map is shown.')
      : t('map.vector_unsupported_notice', 'Vector maps need WebGL, which this browser does not provide. A standard map is shown.');
  const dismissLabel = t('map.vector_notice_dismiss', 'Dismiss');

  return (
    <div ref={ref} className={styles.notice} role="status" aria-live="polite" data-testid="vector-fallback-notice">
      <span className={styles.icon} aria-hidden="true">
        <UiIcon name="alert" size={15} />
      </span>
      <span className={styles.text}>{text}</span>
      <button type="button" className={styles.dismiss} onClick={dismiss} title={dismissLabel} aria-label={dismissLabel}>
        <UiIcon name="close" size={14} />
      </button>
    </div>
  );
}

export default VectorFallbackNotice;
