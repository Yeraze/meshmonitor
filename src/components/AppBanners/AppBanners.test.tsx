/**
 * @vitest-environment jsdom
 *
 * AppBanners — TX/config-issue warning banners plus the update-available
 * banner. Auto-upgrade execution UI (upgrade progress, circuit-breaker
 * banner) was retired in v4.13; only detection/notification remains.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AppBanners, DISMISSED_UPDATE_VERSION_KEY, type DeploymentMethod } from './AppBanners';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: string | Record<string, unknown>) => {
      if (typeof opts === 'string') return opts;
      if (opts && typeof opts === 'object' && 'version' in opts) {
        return `${key}:${(opts as { version: string }).version}`;
      }
      return key;
    },
  }),
}));

const baseProps = {
  isTxDisabled: false,
  configIssues: [],
  updateAvailable: true,
  latestVersion: '5.0.0',
  releaseUrl: 'https://github.com/Yeraze/meshmonitor/releases/tag/v5.0.0',
};

function renderBanners(deploymentMethod: DeploymentMethod, overrides: Partial<typeof baseProps> = {}) {
  return render(
    <AppBanners {...baseProps} {...overrides} deploymentMethod={deploymentMethod} />
  );
}

describe('AppBanners — update banner', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('is hidden when updateAvailable is false', () => {
    renderBanners('docker', { updateAvailable: false });
    expect(screen.queryByText(/banners\.update_available/)).not.toBeInTheDocument();
  });

  it('renders the update banner with the release link when updateAvailable is true', () => {
    renderBanners('docker');
    expect(screen.getByText(/banners\.update_available:5\.0\.0/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /banners\.view_release_notes/ });
    expect(link).toHaveAttribute('href', baseProps.releaseUrl);
  });

  it('shows docker-specific instructions when expanded', () => {
    renderBanners('docker');
    fireEvent.click(screen.getByText('banners.update_show_details'));
    expect(screen.getByText('docker compose pull && docker compose up -d')).toBeInTheDocument();
    expect(screen.getByText(/banners\.update_docker_watchtower/)).toBeInTheDocument();
  });

  it('shows lxc-specific instructions when expanded', () => {
    renderBanners('lxc');
    fireEvent.click(screen.getByText('banners.update_show_details'));
    expect(screen.getByText('banners.update_lxc')).toBeInTheDocument();
  });

  it('shows kubernetes-specific instructions when expanded', () => {
    renderBanners('kubernetes');
    fireEvent.click(screen.getByText('banners.update_show_details'));
    expect(screen.getByText('banners.update_kubernetes')).toBeInTheDocument();
  });

  it('shows manual instructions with a docs link when expanded', () => {
    renderBanners('manual');
    fireEvent.click(screen.getByText('banners.update_show_details'));
    expect(screen.getByText(/banners\.update_manual/)).toBeInTheDocument();
    const guideLink = screen.getByRole('link', { name: 'banners.update_guide_link' });
    expect(guideLink).toHaveAttribute('href', 'https://yeraze.github.io/meshmonitor/configuration/updating');
  });

  it('details are collapsed by default', () => {
    renderBanners('docker');
    expect(screen.queryByText('docker compose pull && docker compose up -d')).not.toBeInTheDocument();
  });

  it('dismissing the banner persists the version in localStorage and hides it', () => {
    renderBanners('docker');
    expect(screen.getByText(/banners\.update_available:5\.0\.0/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'banners.update_dismiss' }));

    expect(localStorage.getItem(DISMISSED_UPDATE_VERSION_KEY)).toBe('5.0.0');
    expect(screen.queryByText('banners.update_available:5.0.0')).not.toBeInTheDocument();
  });

  it('does not show the banner on mount if the current version was already dismissed', () => {
    localStorage.setItem(DISMISSED_UPDATE_VERSION_KEY, '5.0.0');
    renderBanners('docker');
    expect(screen.queryByText('banners.update_available:5.0.0')).not.toBeInTheDocument();
  });

  it('re-shows the banner when a newer version is available after a previous dismissal', () => {
    localStorage.setItem(DISMISSED_UPDATE_VERSION_KEY, '5.0.0');
    renderBanners('docker', { latestVersion: '5.1.0' });
    expect(screen.getByText(/banners\.update_available:5\.1\.0/)).toBeInTheDocument();
  });
});

describe('AppBanners — warning banners', () => {
  it('renders the TX disabled banner', () => {
    render(<AppBanners {...baseProps} updateAvailable={false} isTxDisabled deploymentMethod="docker" />);
    expect(screen.getByText(/banners\.tx_disabled/)).toBeInTheDocument();
  });

  it('renders a config issue banner with a docs link', () => {
    render(
      <AppBanners
        {...baseProps}
        updateAvailable={false}
        deploymentMethod="docker"
        configIssues={[
          { type: 'cookie_secure', severity: 'error', message: 'Cookie is insecure', docsUrl: 'https://example.com/docs' },
        ]}
      />
    );
    expect(screen.getByText(/Cookie is insecure/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /banners\.learn_more/ });
    expect(link).toHaveAttribute('href', 'https://example.com/docs');
  });
});
