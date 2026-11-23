/**
 * Open-Meteo options for Global Settings > Solar Monitoring (#6523): API key,
 * grid cell size, refresh interval, a calls/day estimate per grid size and the
 * privacy / attribution notes. Values live in SettingsTab's draft; this
 * component only renders them and reads `/api/solar/usage` (admin-only).
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../services/api';
import { logger } from '../utils/logger';
import { PasswordField } from './shared/config/PasswordField';
import {
  SOLAR_GRID_SIZES,
  SOLAR_REFRESH_HOURS,
  FREE_DAILY_BUDGET,
  callsPerDay,
  freeTierCellCap,
} from '../utils/solarGrid';
import styles from './SolarMonitoringSettings.module.css';

interface SolarUsage {
  activeNodes: number;
  freeDailyBudget: number;
  cellsByGrid: Record<string, number>;
}

/** Approximate cell width at the equator, in km, for each grid size. */
const GRID_KM: Record<string, number> = { '0.05': 5.5, '0.1': 11, '0.25': 28, '0.5': 55, '1': 111 };

interface SolarMonitoringSettingsProps {
  isAdmin: boolean;
  apiToken: string;
  gridSize: string;
  refreshHours: string;
  onApiTokenChange: (value: string) => void;
  onGridSizeChange: (value: string) => void;
  onRefreshHoursChange: (value: string) => void;
}

const SolarMonitoringSettings: React.FC<SolarMonitoringSettingsProps> = ({
  isAdmin,
  apiToken,
  gridSize,
  refreshHours,
  onApiTokenChange,
  onGridSizeChange,
  onRefreshHoursChange,
}) => {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<SolarUsage | null>(null);

  // One read when the section shows; the route is admin-only.
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    api
      .get<{ success: boolean; data?: SolarUsage }>('/api/solar/usage')
      .then((body) => {
        if (!cancelled && body?.data) setUsage(body.data);
      })
      .catch((error) => logger.warn('Failed to load solar usage estimate:', error));
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  const refresh = Number(refreshHours);
  const budget = usage?.freeDailyBudget ?? FREE_DAILY_BUDGET;
  const selectedCells = usage?.cellsByGrid[gridSize] ?? 0;
  const selectedCalls = callsPerDay(selectedCells, refresh);
  const overFreeTier = !apiToken.trim() && usage !== null && selectedCalls > budget;
  const fmt = (n: number) => n.toLocaleString();

  return (
    <>
      <div className="setting-item">
        <label htmlFor="solarOpenMeteoApiToken">
          {t('settings.solar_api_key_label')}
          <span className="setting-description">
            {t('settings.solar_api_key_description')}{' '}
            <a href="https://open-meteo.com/en/pricing" target="_blank" rel="noopener noreferrer">
              open-meteo.com/en/pricing
            </a>
          </span>
        </label>
        <PasswordField
          id="solarOpenMeteoApiToken"
          value={apiToken}
          onChange={(e) => onApiTokenChange(e.target.value)}
          className="setting-input"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="setting-item">
        <label htmlFor="solarGridSize">
          {t('settings.solar_grid_label')}
          <span className="setting-description">{t('settings.solar_grid_description')}</span>
        </label>
        <select
          id="solarGridSize"
          value={gridSize}
          onChange={(e) => onGridSizeChange(e.target.value)}
          className="setting-input"
        >
          {SOLAR_GRID_SIZES.map((g) => (
            <option key={g} value={String(g)}>
              {t('settings.solar_grid_option', { degrees: g, km: GRID_KM[String(g)] })}
            </option>
          ))}
        </select>
      </div>

      <div className="setting-item">
        <label htmlFor="solarRefreshHours">
          {t('settings.solar_refresh_label')}
          <span className="setting-description">{t('settings.solar_refresh_description')}</span>
        </label>
        <select
          id="solarRefreshHours"
          value={refreshHours}
          onChange={(e) => onRefreshHoursChange(e.target.value)}
          className="setting-input"
        >
          {SOLAR_REFRESH_HOURS.map((h) => (
            <option key={h} value={String(h)}>
              {t('settings.solar_refresh_option', { count: h })}
            </option>
          ))}
        </select>
      </div>

      {overFreeTier && (
        <div className={styles.warning} role="alert" data-testid="solar-budget-warning">
          {t('settings.solar_budget_warning', {
            calls: fmt(selectedCalls),
            budget: fmt(budget),
            cap: fmt(freeTierCellCap(refresh)),
          })}
        </div>
      )}

      {usage && (
        <div className={styles.estimate} data-testid="solar-usage-estimate">
          <p className="setting-description">
            {t('settings.solar_estimate_intro', { nodes: fmt(usage.activeNodes), hours: refresh })}
          </p>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t('settings.solar_estimate_grid')}</th>
                <th>{t('settings.solar_estimate_cells')}</th>
                <th>{t('settings.solar_estimate_calls')}</th>
              </tr>
            </thead>
            <tbody>
              {SOLAR_GRID_SIZES.map((g) => {
                const key = String(g);
                const cells = usage.cellsByGrid[key] ?? 0;
                const calls = callsPerDay(cells, refresh);
                const rowClass = [
                  key === gridSize ? styles.selected : '',
                  calls > budget ? styles.over : '',
                ].filter(Boolean).join(' ');
                return (
                  <tr key={key} className={rowClass || undefined} aria-current={key === gridSize ? 'true' : undefined}>
                    <td>{key}°</td>
                    <td>{fmt(cells)}</td>
                    <td>{t('settings.solar_estimate_up_to', { calls: fmt(calls) })}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className={styles.note}>{t('settings.solar_privacy_note')}</p>
      <p className={styles.note}>
        {t('solar.credit_prefix')}{' '}
        <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">
          Open-Meteo.com
        </a>
      </p>
    </>
  );
};

export default SolarMonitoringSettings;
