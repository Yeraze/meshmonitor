import React from 'react';
import { useTranslation } from 'react-i18next';
import './AppBanners.css';

interface ConfigIssue {
  type: 'cookie_secure' | 'allowed_origins';
  severity: 'error' | 'warning';
  message: string;
  docsUrl: string;
}

interface AppBannersProps {
  isDefaultPassword: boolean;
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
}

export const AppBanners: React.FC<AppBannersProps> = ({
  isDefaultPassword,
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
}) => {
  const { t } = useTranslation();

  return (
    <>
      {/* Default Password Warning Banner */}
      {isDefaultPassword && (
        <div className="warning-banner">
          ⚠️ {t('banners.default_password_warning')}
        </div>
      )}

      {/* TX Disabled Warning Banner */}
      {isTxDisabled && (
        <div
          className="warning-banner"
          style={{
            top: isDefaultPassword ? 'calc(var(--header-height) + var(--banner-height))' : 'var(--header-height)',
          }}
        >
          ⚠️ {t('banners.tx_disabled')}
        </div>
      )}

      {/* Configuration Issue Warning Banners */}
      {configIssues.map((issue, index) => {
        // Calculate how many banners are above this one
        const bannersAbove = [isDefaultPassword, isTxDisabled].filter(Boolean).length + index;
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

      {/* Update Available Banner */}
      {updateAvailable &&
        (() => {
          // Calculate total warning banners above the update banner
          const warningBannersCount = [isDefaultPassword, isTxDisabled].filter(Boolean).length + configIssues.length;
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
