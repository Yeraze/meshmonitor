import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ScannerStatus } from './securityTypes';
import { useSecurityFormat } from './useSecurityFormat';

interface ScannerStatusCardProps {
  status: ScannerStatus | null;
  canWrite: boolean;
  scanning: boolean;
  onScan: () => void;
}

/** Scanner state and the "Run scan now" button. Same markup and classes for both protocols. */
export const ScannerStatusCard: React.FC<ScannerStatusCardProps> = ({ status, canWrite, scanning, onScan }) => {
  const { t } = useTranslation();
  const { formatDate, formatRelativeTime } = useSecurityFormat();
  return (
    <div className="scanner-status">
      <div className="status-card">
        <h3>{t('security.scanner_status')}</h3>
        <div className="status-details">
          <div className="status-row">
            <span className="label">{t('security.status')}:</span>
            <span className={`value ${status?.running ? 'running' : 'stopped'}`}>
              {status?.scanningNow ? t('security.scanning_now') : status?.running ? t('security.active') : t('security.stopped')}
            </span>
          </div>
          <div className="status-row">
            <span className="label">{t('security.scan_interval')}:</span>
            <span className="value">{t('security.every_hours', { hours: status?.intervalHours })}</span>
          </div>
          <div className="status-row">
            <span className="label">{t('security.last_scan')}:</span>
            <span className="value">
              {formatRelativeTime(status?.lastScanTime || null)}
              {status?.lastScanTime && (
                <span className="timestamp"> ({formatDate(status.lastScanTime)})</span>
              )}
            </span>
          </div>
        </div>
        {canWrite && (
          <button
            onClick={onScan}
            disabled={scanning || status?.scanningNow}
            className="scan-button"
          >
            {scanning || status?.scanningNow ? t('security.scanning') : t('security.run_scan_now')}
          </button>
        )}
      </div>
    </div>
  );
};
