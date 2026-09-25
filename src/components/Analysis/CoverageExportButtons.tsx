/**
 * CoverageExportButtons — CSV / GeoJSON export for the Coverage Report
 * (#5277 Phase 4a WP3, spec §2a.4 / §2a.6). Thin UI over WP1's pure builders
 * (`src/utils/coverageExport.ts`): this component owns no export logic of
 * its own, only the click -> build -> `downloadTextFile` wiring and the
 * disabled/tooltip states.
 *
 * Export is client-side over whatever `items` the caller already loaded
 * (decision A4) — same rows the map/summary show, same privacy filtering,
 * same 10k cap. When that load was truncated, the button gets a tooltip
 * saying so; it still exports what is loaded rather than blocking.
 */
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { downloadTextFile } from '../../utils/nodeExport';
import { buildCoverageCsv, buildCoverageGeoJson, coverageExportFilename } from '../../utils/coverageExport';
import type { CoverageReceptionDto } from '../../types/coverage';
import type { CoverageGap, CoverageExportContext } from '../../types/coverageAnalysis';
import styles from './CoverageSummaryPanel.module.css';

export interface CoverageExportButtonsProps {
  items: CoverageReceptionDto[];
  gaps: CoverageGap[];
  ctx: CoverageExportContext;
  senderId: string | null;
  sinceMs: number;
  untilMs: number;
  disabled: boolean;
}

export const CoverageExportButtons: React.FC<CoverageExportButtonsProps> = ({
  items,
  gaps,
  ctx,
  senderId,
  sinceMs,
  untilMs,
  disabled,
}) => {
  const { t } = useTranslation();

  const isDisabled = disabled || items.length === 0;
  const tooltip = ctx.truncated
    ? t('analysis.coverage.export_truncated', 'Exports the first {{count}} receptions loaded.', {
        count: items.length,
      })
    : undefined;

  const handleExportCsv = useCallback(() => {
    const csv = buildCoverageCsv(items, ctx);
    downloadTextFile(coverageExportFilename('csv', senderId, sinceMs, untilMs), csv, 'text/csv');
  }, [items, ctx, senderId, sinceMs, untilMs]);

  const handleExportGeoJson = useCallback(() => {
    const geoJson = buildCoverageGeoJson(items, { ...ctx, gaps });
    downloadTextFile(
      coverageExportFilename('geojson', senderId, sinceMs, untilMs),
      geoJson,
      'application/geo+json',
    );
  }, [items, ctx, gaps, senderId, sinceMs, untilMs]);

  return (
    <div className={styles.exportRow} data-testid="coverage-export-buttons">
      <span className={styles.tileLabel}>{t('analysis.coverage.export', 'Export')}</span>
      <button
        type="button"
        className="reports-btn reports-btn--ghost"
        disabled={isDisabled}
        title={tooltip}
        onClick={handleExportCsv}
      >
        <UiIcon name="download" size={14} />
        {t('analysis.coverage.export_csv', 'CSV')}
      </button>
      <button
        type="button"
        className="reports-btn reports-btn--ghost"
        disabled={isDisabled}
        title={tooltip}
        onClick={handleExportGeoJson}
      >
        <UiIcon name="download" size={14} />
        {t('analysis.coverage.export_geojson', 'GeoJSON')}
      </button>
    </div>
  );
};

export default CoverageExportButtons;
