/**
 * Edit the walkabout hex map SNR band edges for one source (#6571).
 * Shown only to users who may write that source's settings; the server
 * validates again on save.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NumberInput } from '../common/NumberInput';
import { useSaveWalkaboutSnrBands } from '../../hooks/useWalkaboutSnrBands';
import {
  WALKABOUT_DEFAULT_SNR_BANDS,
  WALKABOUT_SNR_BAND_RANGE,
  validateWalkaboutSnrBands,
  type WalkaboutSnrBands,
  type WalkaboutSnrBandsError,
} from '../../utils/walkabout';
import styles from './WalkaboutSnrBandsEditor.module.css';

type Field = keyof WalkaboutSnrBands;
const FIELDS: Field[] = ['strong', 'medium', 'weak'];

const ALL_VALID: Record<Field, boolean> = { strong: true, medium: true, weak: true };

export interface WalkaboutSnrBandsEditorProps {
  sourceId: string;
  bands: WalkaboutSnrBands;
}

export default function WalkaboutSnrBandsEditor({ sourceId, bands }: WalkaboutSnrBandsEditorProps) {
  const { t } = useTranslation();
  const save = useSaveWalkaboutSnrBands(sourceId);
  const [draft, setDraft] = useState<WalkaboutSnrBands>(() => ({ ...bands }));
  // NumberInput emits only valid, in-range numbers; it tells us when a field's
  // text is blank or out of range so Save stays off.
  const [fieldValid, setFieldValid] = useState<Record<Field, boolean>>(ALL_VALID);
  const [saved, setSaved] = useState(false);

  // Re-seed when the stored value (or the source) changes, during render
  // rather than in an effect, so the inputs never show a stale value.
  const bandsKey = `${sourceId}|${bands.strong}|${bands.medium}|${bands.weak}`;
  const [seededKey, setSeededKey] = useState(bandsKey);
  if (seededKey !== bandsKey) {
    setSeededKey(bandsKey);
    setDraft({ ...bands });
  }

  const parsed = draft;
  const fieldsOk = FIELDS.every((f) => fieldValid[f]);
  const error: WalkaboutSnrBandsError | null = fieldsOk ? validateWalkaboutSnrBands(parsed) : 'out_of_range';
  const dirty = FIELDS.some((f) => parsed[f] !== bands[f]);
  const isDefault = FIELDS.every((f) => bands[f] === WALKABOUT_DEFAULT_SNR_BANDS[f]);

  const errorText = (e: WalkaboutSnrBandsError): string => {
    const { min, max } = WALKABOUT_SNR_BAND_RANGE;
    if (e === 'out_of_range') {
      return t('analysis.walkabout.bands.error_range', 'Each edge must be between {{min}} and {{max}} dB.', { min, max });
    }
    if (e === 'not_descending') {
      return t('analysis.walkabout.bands.error_order', 'Edges must go down: strong above medium above weak.');
    }
    return t('analysis.walkabout.bands.error_number', 'Enter a number for each edge.');
  };

  const labels: Record<Field, string> = {
    strong: t('analysis.walkabout.bands.strong', 'Strong at or above (dB)'),
    medium: t('analysis.walkabout.bands.medium', 'Medium at or above (dB)'),
    weak: t('analysis.walkabout.bands.weak', 'Weak at or above (dB)'),
  };

  const onSave = () => {
    if (error) return;
    setSaved(false);
    save.mutate(parsed, { onSuccess: () => setSaved(true) });
  };
  const onReset = () => {
    setSaved(false);
    save.mutate(null, { onSuccess: () => setSaved(true) });
  };

  return (
    <details className={styles.editor} data-testid="walkabout-snr-bands-editor">
      <summary className={styles.summary}>
        {t('analysis.walkabout.bands.title', 'SNR bands for this source')}
      </summary>
      <p className={styles.hint}>
        {t(
          'analysis.walkabout.bands.hint',
          'Slow presets (LongSlow, SF12) still work near -20 dB. If your mesh uses one, lower these edges.',
        )}
      </p>
      <div className={styles.fields}>
        {FIELDS.map((f) => (
          <label key={f} className={styles.field}>
            <span className={styles.label}>{labels[f]}</span>
            <NumberInput
              step={0.5}
              min={WALKABOUT_SNR_BAND_RANGE.min}
              max={WALKABOUT_SNR_BAND_RANGE.max}
              className={styles.input}
              value={draft[f]}
              onChange={(v) => {
                setSaved(false);
                setDraft((d) => ({ ...d, [f]: v }));
              }}
              onValidityChange={(valid) => setFieldValid((m) => (m[f] === valid ? m : { ...m, [f]: valid }))}
              data-testid={`walkabout-snr-band-${f}`}
            />
          </label>
        ))}
      </div>
      {error && (
        <div className={styles.error} role="alert" data-testid="walkabout-snr-bands-error">
          {errorText(error)}
        </div>
      )}
      {save.isError && (
        <div className={styles.error} role="alert">
          {t('analysis.walkabout.bands.save_error', 'Could not save the bands.')}
        </div>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.button}
          onClick={onSave}
          disabled={!!error || !dirty || save.isPending}
          data-testid="walkabout-snr-bands-save"
        >
          {t('analysis.walkabout.bands.save', 'Save')}
        </button>
        <button
          type="button"
          className={styles.button}
          onClick={onReset}
          disabled={isDefault || save.isPending}
          data-testid="walkabout-snr-bands-reset"
        >
          {t('analysis.walkabout.bands.reset', 'Reset to defaults')}
        </button>
        {saved && !dirty && (
          <span className={styles.saved} role="status">
            {t('analysis.walkabout.bands.saved', 'Saved')}
          </span>
        )}
      </div>
    </details>
  );
}
