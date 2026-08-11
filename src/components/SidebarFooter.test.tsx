/**
 * @vitest-environment jsdom
 *
 * SidebarFooter (issue #4436) — the shared footer used by both the unified
 * dashboard sidebar and the per-source sidebar. Covers the full link set,
 * the Discord invite URL, and the permission gates (Users behind isAdmin,
 * Settings behind settings:read).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SidebarFooter, {
  MESHMONITOR_DISCORD_URL,
  MESHMONITOR_GITHUB_URL,
  MESHMONITOR_KOFI_URL,
  MESHMONITOR_WEBSITE_URL,
} from './SidebarFooter';
import packageJson from '../../package.json';

const baseProps = {
  isAdmin: true,
  canReadSettings: true,
  onUsersClick: vi.fn(),
  onSettingsClick: vi.fn(),
  onNewsClick: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SidebarFooter', () => {
  it('renders the full link set: Users, Settings, News, GitHub, Discord, Support, Website', () => {
    render(<SidebarFooter {...baseProps} />);
    expect(screen.getByTitle('source.sidebar.users')).toBeInTheDocument();
    expect(screen.getByTitle('source.sidebar.settings')).toBeInTheDocument();
    expect(screen.getByTitle('source.sidebar.news')).toBeInTheDocument();
    expect(screen.getByTitle('source.sidebar.github')).toBeInTheDocument();
    expect(screen.getByTitle('source.sidebar.discord')).toBeInTheDocument();
    expect(screen.getByTitle('source.sidebar.support')).toBeInTheDocument();
    expect(screen.getByTitle('source.sidebar.website')).toBeInTheDocument();
  });

  it('renders the version line', () => {
    render(<SidebarFooter {...baseProps} />);
    expect(screen.getByText(`v${packageJson.version}`)).toBeInTheDocument();
  });

  it('hides the version line when hideVersion is set', () => {
    render(<SidebarFooter {...baseProps} hideVersion />);
    expect(screen.queryByText(`v${packageJson.version}`)).toBeNull();
  });

  it('links Discord to the MeshMonitor invite in a new tab', () => {
    render(<SidebarFooter {...baseProps} />);
    const discord = screen.getByTitle('source.sidebar.discord');
    expect(discord).toHaveAttribute('href', 'https://discord.gg/JVR3VBETQE');
    expect(MESHMONITOR_DISCORD_URL).toBe('https://discord.gg/JVR3VBETQE');
    expect(discord).toHaveAttribute('target', '_blank');
    expect(discord).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('links GitHub, Website, and Support externally in new tabs', () => {
    render(<SidebarFooter {...baseProps} />);
    const github = screen.getByTitle('source.sidebar.github');
    expect(github).toHaveAttribute('href', MESHMONITOR_GITHUB_URL);
    expect(github).toHaveAttribute('target', '_blank');
    const website = screen.getByTitle('source.sidebar.website');
    expect(website).toHaveAttribute('href', MESHMONITOR_WEBSITE_URL);
    expect(website).toHaveAttribute('target', '_blank');
    const support = screen.getByTitle('source.sidebar.support');
    expect(support).toHaveAttribute('href', MESHMONITOR_KOFI_URL);
    expect(MESHMONITOR_KOFI_URL).toBe('https://ko-fi.com/yeraze');
    expect(support).toHaveAttribute('target', '_blank');
    expect(support).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('hides Users when the viewer is not an admin', () => {
    render(<SidebarFooter {...baseProps} isAdmin={false} />);
    expect(screen.queryByTitle('source.sidebar.users')).toBeNull();
    // Settings stays — it is gated separately by settings:read.
    expect(screen.getByTitle('source.sidebar.settings')).toBeInTheDocument();
  });

  it('hides Settings when the viewer lacks settings:read', () => {
    render(<SidebarFooter {...baseProps} canReadSettings={false} />);
    expect(screen.queryByTitle('source.sidebar.settings')).toBeNull();
    expect(screen.getByTitle('source.sidebar.users')).toBeInTheDocument();
  });

  it('fires the Users and Settings click handlers', () => {
    render(<SidebarFooter {...baseProps} />);
    fireEvent.click(screen.getByTitle('source.sidebar.users'));
    expect(baseProps.onUsersClick).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTitle('source.sidebar.settings'));
    expect(baseProps.onSettingsClick).toHaveBeenCalledTimes(1);
  });

  it('applies the narrow-rail layout only when narrowIcons is set', () => {
    // The collapsed per-source rail is 60px wide; without this the six icons
    // wrap one per line and the footer overruns the sidebar (#4436).
    const { container, unmount } = render(<SidebarFooter {...baseProps} narrowIcons />);
    expect(container.firstElementChild?.className).toMatch(/narrow/);
    unmount();

    const plain = render(<SidebarFooter {...baseProps} />);
    expect(plain.container.firstElementChild?.className).not.toMatch(/narrow/);
  });

  it('fires the News click handler and disables the button when absent', () => {
    const { unmount } = render(<SidebarFooter {...baseProps} />);
    fireEvent.click(screen.getByTitle('source.sidebar.news'));
    expect(baseProps.onNewsClick).toHaveBeenCalledTimes(1);
    unmount();

    render(<SidebarFooter {...baseProps} onNewsClick={undefined} />);
    expect(screen.getByTitle('source.sidebar.news')).toBeDisabled();
  });
});
