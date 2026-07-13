import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConfigIssue } from '../../hooks/useSecurityCheck';
import './AppBanners.css';

/** Matches the server's `detectDeploymentMethod()` (src/server/utils/deployment.ts). */
export type DeploymentMethod = 'docker' | 'lxc' | 'kubernetes' | 'manual';

const UPDATING_DOCS_URL = 'https://yeraze.github.io/meshmonitor/configuration/updating';

/** localStorage key for the per-version dismissal of the update banner. */
export const DISMISSED_UPDATE_VERSION_KEY = 'meshmonitor_dismissed_update_version';

interface AppBannersProps {
  isTxDisabled: boolean;
  configIssues: ConfigIssue[];
  updateAvailable: boolean;
  latestVersion: string;
  releaseUrl: string;
  deploymentMethod: DeploymentMethod;
}

function readDismissedVersion(): string | null {
  try {
    return localStorage.getItem(DISMISSED_UPDATE_VERSION_KEY);
  } catch {
    return null;
  }
}

export const AppBanners: React.FC<AppBannersProps> = ({
  isTxDisabled,
  configIssues,
  updateAvailable,
  latestVersion,
  releaseUrl,
  deploymentMethod,
}) => {
  const { t } = useTranslation();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(readDismissedVersion);
  const [detailsExpanded, setDetailsExpanded] = useState(false);

  // Re-sync from storage if another tab dismissed/cleared it.
  useEffect(() => {
    setDismissedVersion(readDismissedVersion());
  }, [latestVersion]);

  const showUpdateBanner = updateAvailable && !!latestVersion && latestVersion !== dismissedVersion;

  const handleDismissUpdate = () => {
    try {
      localStorage.setItem(DISMISSED_UPDATE_VERSION_KEY, latestVersion);
    } catch {
      // localStorage unavailable (private browsing, quota, etc.) — dismissal
      // just won't persist across reloads, which is a harmless degradation.
    }
    setDismissedVersion(latestVersion);
  };

  const renderUpdateInstructions = () => {
    switch (deploymentMethod) {
      case 'docker':
        return (
          <>
            <code className="update-banner-command">
              docker compose pull && docker compose up -d
            </code>
            <span>
              {t('banners.update_docker_watchtower')}{' '}
              <a href={UPDATING_DOCS_URL} target="_blank" rel="noopener noreferrer">
                {t('banners.update_guide_link')}
              </a>
            </span>
          </>
        );
      case 'lxc':
        return <span>{t('banners.update_lxc')}</span>;
      case 'kubernetes':
        return <span>{t('banners.update_kubernetes')}</span>;
      case 'manual':
      default:
        return (
          <span>
            {t('banners.update_manual')}{' '}
            <a href={UPDATING_DOCS_URL} target="_blank" rel="noopener noreferrer">
              {t('banners.update_guide_link')}
            </a>
          </span>
        );
    }
  };

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

      {/* Update Available Banner */}
      {showUpdateBanner &&
        (() => {
          // Calculate total warning banners above the update banner
          const warningBannersCount = [isTxDisabled].filter(Boolean).length + configIssues.length;
          const topOffset =
            warningBannersCount === 0
              ? 'var(--header-height)'
              : `calc(var(--header-height) + (var(--banner-height) * ${warningBannersCount}))`;

          return (
            <div className="update-banner" style={{ top: topOffset }}>
              <div className="update-banner-row">
                <span>🔔 {t('banners.update_available', { version: latestVersion })}</span>
                <a
                  href={releaseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="update-banner-link"
                >
                  {t('banners.view_release_notes')} →
                </a>
                <button
                  className="update-banner-toggle"
                  onClick={() => setDetailsExpanded(prev => !prev)}
                  aria-expanded={detailsExpanded}
                >
                  {detailsExpanded ? t('banners.update_hide_details') : t('banners.update_show_details')}
                </button>
                <button
                  className="banner-dismiss"
                  onClick={handleDismissUpdate}
                  aria-label={t('banners.update_dismiss')}
                >
                  ×
                </button>
              </div>
              {detailsExpanded && (
                <div className="update-banner-details">{renderUpdateInstructions()}</div>
              )}
            </div>
          );
        })()}
    </>
  );
};
