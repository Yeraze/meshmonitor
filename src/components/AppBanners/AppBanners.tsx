import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConfigIssue } from '../../hooks/useSecurityCheck';
import './AppBanners.css';

interface AppBannersProps {
  isTxDisabled: boolean;
  configIssues: ConfigIssue[];
  updateAvailable: boolean;
  latestVersion: string;
  releaseUrl: string;
  upgradeEnabled: boolean;
  upgradeInProgress: boolean;
  upgradeStatus: string;
  upgradeProgress: number;
  onUpgrade: () => void;
  onDismissUpdate: () => void;
  autoUpgradeBlocked?: boolean;
  autoUpgradeBlockedReason?: string | null;
  onClearAutoUpgradeBlock?: () => void;
}

export const AppBanners: React.FC<AppBannersProps> = ({
  isTxDisabled,
  configIssues,
  updateAvailable,
  latestVersion,
  releaseUrl,
  upgradeEnabled,
  upgradeInProgress,
  upgradeStatus,
  upgradeProgress,
  onUpgrade,
  onDismissUpdate,
  autoUpgradeBlocked = false,
  autoUpgradeBlockedReason = null,
  onClearAutoUpgradeBlock,
}) => {
  const { t } = useTranslation();

  // Use ref to avoid resetting timer when onDismissUpdate reference changes
  const onDismissUpdateRef = useRef(onDismissUpdate);
  useEffect(() => {
    onDismissUpdateRef.current = onDismissUpdate;
  }, [onDismissUpdate]);

  // Auto-dismiss update banner after 5 seconds (unless upgrade is in progress)
  useEffect(() => {
    if (updateAvailable && !upgradeInProgress) {
      const timer = setTimeout(() => {
        onDismissUpdateRef.current();
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [updateAvailable, upgradeInProgress]);

  return (
    <>
      {/* TX Disabled Warning Banner */}
      {isTxDisabled && (
        <div
          className="warning-banner"
          style={{ top: 'var(--header-height)' }}
        >
          ⚠️ {t('banners.tx_disabled')}
        </div>
      )}

      {/* Configuration Issue Warning Banners */}
      {configIssues.map((issue, index) => {
        // Calculate how many banners are above this one
        const bannersAbove = [isTxDisabled].filter(Boolean).length + index;
        const topOffset =
          bannersAbove === 0
            ? 'var(--header-height)'
            : `calc(var(--header-height) + (var(--banner-height) * ${bannersAbove}))`;

        return (
          <div key={issue.type} className="warning-banner" style={{ top: topOffset }}>
            ⚠️ {t('banners.config_error')}: {issue.message}{' '}
            <a
              href={issue.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'inherit', textDecoration: 'underline' }}
            >
              {t('banners.learn_more')} →
            </a>
          </div>
        );
      })}

      {/* Auto-Upgrade Blocked Banner (circuit breaker tripped) */}
      {autoUpgradeBlocked && (() => {
        const bannersAbove = [isTxDisabled].filter(Boolean).length + configIssues.length;
        const topOffset =
          bannersAbove === 0
            ? 'var(--header-height)'
            : `calc(var(--header-height) + (var(--banner-height) * ${bannersAbove}))`;
        return (
          <div
            className="warning-banner"
            style={{ top: topOffset, gap: '1rem' }}
          >
            <span>
              ⚠️ {t('banners.auto_upgrade_blocked', {
                defaultValue: 'Auto-upgrade halted after repeated failures.',
              })}
              {autoUpgradeBlockedReason ? ` ${autoUpgradeBlockedReason}` : ''}
            </span>
            {onClearAutoUpgradeBlock && (
              <button
                onClick={onClearAutoUpgradeBlock}
                style={{
                  marginLeft: '1rem',
                  padding: '0.25rem 0.75rem',
                  background: 'rgba(255,255,255,0.2)',
                  color: 'inherit',
                  border: '1px solid rgba(255,255,255,0.5)',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                {t('banners.acknowledge', { defaultValue: 'Acknowledge' })}
              </button>
            )}
          </div>
        );
      })()}

      {/* Update Available Banner */}
      {updateAvailable &&
        (() => {
          // Calculate total warning banners above the update banner
          const warningBannersCount = [isTxDisabled].filter(Boolean).length + configIssues.length;
          const topOffset =
            warningBannersCount === 0
              ? 'var(--header-height)'
              : `calc(var(--header-height) + (var(--banner-height) * ${warningBannersCount}))`;

          return (
            <div className="update-banner" style={{ top: topOffset }}>
              <div
                style={{
                  flex: 1,
                  textAlign: 'center',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '1rem',
                }}
              >
                {upgradeInProgress ? (
                  <>
                    <span>⚙️ {t('banners.upgrading_to', { version: latestVersion })}</span>
                    <span style={{ fontSize: '0.9em', opacity: 0.9 }}>{upgradeStatus}</span>
                    {upgradeProgress > 0 && (
                      <span style={{ fontSize: '0.9em', opacity: 0.9 }}>({upgradeProgress}%)</span>
                    )}
                  </>
                ) : (
                  <>
                    <span>🔔 {t('banners.update_available', { version: latestVersion })}</span>
                    <a
                      href={releaseUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        color: 'white',
                        textDecoration: 'underline',
                        fontWeight: '600',
                      }}
                    >
                      {t('banners.view_release_notes')} →
                    </a>
                    {upgradeEnabled && (
                      <button
                        onClick={onUpgrade}
                        disabled={upgradeInProgress}
                        style={{
                          padding: '0.4rem 1rem',
                          backgroundColor: '#10b981',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: upgradeInProgress ? 'not-allowed' : 'pointer',
                          fontWeight: '600',
                          opacity: upgradeInProgress ? 0.6 : 1,
                        }}
                      >
                        {t('banners.upgrade_now')}
                      </button>
                    )}
                  </>
                )}
              </div>
              <button
                className="banner-dismiss"
                onClick={onDismissUpdate}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'white',
                  fontSize: '1.5rem',
                  cursor: 'pointer',
                  padding: '0 0.5rem',
                }}
              >
                ×
              </button>
            </div>
          );
        })()}
    </>
  );
};
