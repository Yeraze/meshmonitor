/**
 * Imported: Show / Hide / Only (#5891 P3, resolution Q4). Imported rows show by
 * default; the chip changes the `imported` query parameter, nothing else.
 */
import { useTranslation } from 'react-i18next';
import type { CoverageImportedMode } from '../../types/coverageImport';
import styles from './CoverageImport.module.css';

const MODES: Array<{ id: CoverageImportedMode; key: string; label: string }> = [
  { id: 'include', key: 'imported_show', label: 'Show' },
  { id: 'exclude', key: 'imported_hide', label: 'Hide' },
  { id: 'only', key: 'imported_only', label: 'Only' },
];

export interface CoverageImportedChipProps {
  value: CoverageImportedMode;
  onChange: (mode: CoverageImportedMode) => void;
}

export function CoverageImportedChip({ value, onChange }: CoverageImportedChipProps) {
  const { t } = useTranslation();
  return (
    <div className={`reports-controls__field ${styles.chipField}`} data-testid="coverage-imported-chip">
      <span>{t('analysis.coverage.imported_label', 'Imported')}</span>
      <div className={styles.chip} role="group" aria-label={t('analysis.coverage.imported_label', 'Imported')}>
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`reports-btn reports-btn--ghost${value === m.id ? ` ${styles.chipActive}` : ''}`}
            aria-pressed={value === m.id}
            onClick={() => onChange(m.id)}
          >
            {t(`analysis.coverage.${m.key}`, m.label)}
          </button>
        ))}
      </div>
    </div>
  );
}
