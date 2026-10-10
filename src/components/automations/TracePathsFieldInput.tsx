/**
 * TracePathsFieldInput — the path list of `action.tracePathSchedule` (#5723).
 *
 * One row per MeshCore contact to trace to, each with its own hop-hash width
 * and its own interval. The interval floor and path count come from the shared
 * limits the server enforces.
 */
import { useTranslation } from 'react-i18next';
import { NumberInput } from '../common/NumberInput';
import { UiIcon } from '../icons';
import {
  TRACE_SCHEDULE_MAX_INTERVAL_MINUTES,
  TRACE_SCHEDULE_MAX_PATHS,
  TRACE_SCHEDULE_MIN_INTERVAL_MINUTES,
  type TraceHashBytes,
} from '../../types/tracePathSchedule';
import styles from './TracePathsFieldInput.module.css';

/** A row as edited: fields may be half-typed, so they are looser than the stored shape. */
export interface TracePathDraft {
  publicKey: string;
  hashBytes: TraceHashBytes;
  intervalMinutes: number | '';
  label?: string;
}

const KEY_RE = /^[0-9a-f]{64}$/i;

function toDrafts(value: unknown): TracePathDraft[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const hb = Number(r.hashBytes);
    const interval = Number(r.intervalMinutes);
    return {
      publicKey: typeof r.publicKey === 'string' ? r.publicKey : '',
      hashBytes: hb === 1 ? 1 : hb === 2 ? 2 : 'auto',
      intervalMinutes: r.intervalMinutes === '' || r.intervalMinutes == null || !Number.isFinite(interval) ? '' : interval,
      ...(typeof r.label === 'string' && r.label ? { label: r.label } : {}),
    };
  });
}

export default function TracePathsFieldInput({ value, onChange }: {
  value: unknown;
  onChange: (v: TracePathDraft[]) => void;
}) {
  const { t } = useTranslation();
  const rows = toDrafts(value);
  const patch = (i: number, changes: Partial<TracePathDraft>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...changes } : r)));
  const remove = (i: number) => onChange(rows.filter((_, idx) => idx !== i));
  const add = () => onChange([...rows, { publicKey: '', hashBytes: 'auto', intervalMinutes: 60 }]);

  return (
    <div className={styles.list}>
      {rows.length === 0 && (
        <div className="ae-help-text">{t('automation.tracePaths.empty', 'No paths yet. Add the contacts you want to trace to.')}</div>
      )}
      {rows.map((row, i) => {
        const key = row.publicKey.trim();
        const keyBad = key !== '' && !KEY_RE.test(key);
        const duplicate = key !== '' && rows.some((r, idx) => idx !== i && r.publicKey.trim().toLowerCase() === key.toLowerCase());
        return (
          <div className={styles.row} key={i} data-testid="trace-path-row">
            <label className={styles.cell}>
              <span className={styles.cellLabel}>{t('automation.tracePaths.name', 'Name (optional)')}</span>
              <input className="ae-input" value={row.label ?? ''} maxLength={64}
                placeholder={t('automation.tracePaths.name_placeholder', 'e.g. Hilltop repeater')}
                onChange={(e) => patch(i, { label: e.target.value })} />
            </label>
            <label className={`${styles.cell} ${styles.keyCell}`}>
              <span className={styles.cellLabel}>{t('automation.tracePaths.public_key', 'Contact public key')}</span>
              <input className="ae-input" value={row.publicKey} spellCheck={false}
                aria-invalid={keyBad || duplicate || undefined}
                placeholder={t('automation.tracePaths.public_key_placeholder', '64 hex characters')}
                onChange={(e) => patch(i, { publicKey: e.target.value.trim() })} />
              {keyBad && <span className="ae-field-error">{t('automation.tracePaths.public_key_bad', 'A contact key is 64 hex characters.')}</span>}
              {duplicate && <span className="ae-field-error">{t('automation.tracePaths.duplicate', 'This contact is already in the list.')}</span>}
            </label>
            <label className={styles.cell}>
              <span className={styles.cellLabel}>{t('automation.tracePaths.hash_bytes', 'Hop hash width')}</span>
              <select className="ae-select" value={String(row.hashBytes)}
                onChange={(e) => patch(i, { hashBytes: e.target.value === '1' ? 1 : e.target.value === '2' ? 2 : 'auto' })}>
                <option value="auto">{t('automation.tracePaths.hash_auto', "As the contact's path")}</option>
                <option value="1">{t('automation.tracePaths.hash_1', '1 byte')}</option>
                <option value="2">{t('automation.tracePaths.hash_2', '2 bytes')}</option>
              </select>
            </label>
            <label className={styles.cell}>
              <span className={styles.cellLabel}>{t('automation.tracePaths.interval', 'Every (minutes)')}</span>
              <NumberInput className="ae-input" allowEmpty integer
                min={TRACE_SCHEDULE_MIN_INTERVAL_MINUTES} max={TRACE_SCHEDULE_MAX_INTERVAL_MINUTES}
                value={row.intervalMinutes === '' ? null : row.intervalMinutes}
                onChange={(v) => patch(i, { intervalMinutes: v === null ? '' : v })} />
            </label>
            <button type="button" className={styles.remove} onClick={() => remove(i)}
              aria-label={t('automation.tracePaths.remove', 'Remove path {{n}}', { n: i + 1 })}>
              <UiIcon name="delete" size={15} />
            </button>
          </div>
        );
      })}
      <button type="button" className="ae-suggest-btn" onClick={add} disabled={rows.length >= TRACE_SCHEDULE_MAX_PATHS}>
        <UiIcon name="plus" size={13} /> {t('automation.tracePaths.add', 'Add path')}
      </button>
    </div>
  );
}
