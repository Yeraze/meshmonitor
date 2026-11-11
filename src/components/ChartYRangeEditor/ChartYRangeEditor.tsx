/**
 * Inline editor for a chart widget's fixed Y-axis range (#6348).
 *
 * Two optional number fields; blank means auto. Values are in the unit the
 * chart shows — the caller converts to and from its stored unit.
 */
import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buildYRangeInput, type ChartYRange } from '../../utils/chartYRange';
import NumberInput from '../common/NumberInput';
import styles from './ChartYRangeEditor.module.css';

interface ChartYRangeEditorProps {
  /** Current range in display units; null = auto on both ends. */
  value: ChartYRange | null;
  /** Called with the new range (display units), or null to go back to auto. */
  onApply: (range: ChartYRange | null) => void;
  onClose: () => void;
}

/** Trim float noise from a unit conversion before showing a bound. */
const tidy = (v: number | undefined): number | null =>
  v === undefined ? null : Number(v.toPrecision(10));

const ChartYRangeEditor: React.FC<ChartYRangeEditorProps> = ({ value, onApply, onClose }) => {
  const { t } = useTranslation();
  const id = useId();
  const [min, setMin] = useState<number | null>(() => tidy(value?.min));
  const [max, setMax] = useState<number | null>(() => tidy(value?.max));
  const [orderError, setOrderError] = useState(false);

  const apply = () => {
    const result = buildYRangeInput(min, max);
    if (!result.ok) {
      setOrderError(true);
      return;
    }
    setOrderError(false);
    onApply(result.range);
    onClose();
  };

  const reset = () => {
    setOrderError(false);
    onApply(null);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      apply();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className={styles.editor} role="group" aria-label={t('chart_y_range.title')}>
      <label className={styles.field} htmlFor={`${id}-min`}>
        {t('chart_y_range.min')}
        <NumberInput
          id={`${id}-min`}
          className={styles.input}
          allowEmpty
          step="any"
          value={min}
          placeholder={t('chart_y_range.auto')}
          aria-invalid={orderError}
          onChange={(v) => { setMin(v); setOrderError(false); }}
          onKeyDown={onKeyDown}
        />
      </label>
      <label className={styles.field} htmlFor={`${id}-max`}>
        {t('chart_y_range.max')}
        <NumberInput
          id={`${id}-max`}
          className={styles.input}
          allowEmpty
          step="any"
          value={max}
          placeholder={t('chart_y_range.auto')}
          aria-invalid={orderError}
          onChange={(v) => { setMax(v); setOrderError(false); }}
          onKeyDown={onKeyDown}
        />
      </label>
      <button type="button" className={`${styles.button} ${styles.primary}`} onClick={apply}>
        {t('chart_y_range.apply')}
      </button>
      <button type="button" className={styles.button} onClick={reset}>
        {t('chart_y_range.reset')}
      </button>
      {orderError ? (
        <span className={styles.error} role="alert">{t('chart_y_range.order_error')}</span>
      ) : (
        <span className={styles.hint}>{t('chart_y_range.hint')}</span>
      )}
    </div>
  );
};

export default ChartYRangeEditor;
