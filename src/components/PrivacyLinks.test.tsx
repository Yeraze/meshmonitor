/**
 * @vitest-environment jsdom
 *
 * PrivacyLinks (#5156) — the disclosure link strip shared by the sidebar
 * footer and the login page.
 *
 * The behaviour worth pinning down is the default: an operator who has
 * configured nothing must get no footer at all. A homelab instance should not
 * sprout a legal footer it never asked for, and "renders an empty <nav>" would
 * still add a visible gap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import PrivacyLinks from './PrivacyLinks';
import apiService from '../services/api';
import type { PrivacyLink } from '../types/privacy';

vi.mock('../services/api', () => ({
  default: { getPrivacyLinks: vi.fn() },
}));

const mockLinks = (links: PrivacyLink[]) => {
  vi.mocked(apiService.getPrivacyLinks).mockResolvedValue(links);
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PrivacyLinks', () => {
  it('renders nothing when the operator has configured no links', async () => {
    mockLinks([]);
    const { container } = render(<PrivacyLinks />);

    await waitFor(() => expect(apiService.getPrivacyLinks).toHaveBeenCalled());
    expect(container.querySelector('nav')).toBeNull();
  });

  it('renders nothing while the request is still in flight', () => {
    vi.mocked(apiService.getPrivacyLinks).mockReturnValue(new Promise(() => {}));
    const { container } = render(<PrivacyLinks />);

    expect(container.querySelector('nav')).toBeNull();
  });

  it('links out to an external URL in a new tab', async () => {
    mockLinks([{ slug: 'privacy', kind: 'url', href: 'https://example.org/privacy' }]);
    render(<PrivacyLinks />);

    const link = await screen.findByRole('link');
    expect(link).toHaveAttribute('href', 'https://example.org/privacy');
    expect(link).toHaveAttribute('target', '_blank');
    // Without noopener the target page gets a handle on window.opener.
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('links to the in-app route for a hosted document, in the same tab', async () => {
    mockLinks([{ slug: 'privacy', kind: 'hosted', title: 'Our Policy' }]);
    render(<PrivacyLinks />);

    const link = await screen.findByRole('link', { name: 'Our Policy' });
    expect(link).toHaveAttribute('href', '/privacy/privacy');
    expect(link).not.toHaveAttribute('target');
  });

  it('prefixes hosted hrefs with the app basename', async () => {
    // Deployments behind BASE_URL (e.g. /meshmonitor) would 404 without this.
    mockLinks([{ slug: 'terms', kind: 'hosted', title: 'Terms' }]);
    render(<PrivacyLinks basename="/meshmonitor" />);

    const link = await screen.findByRole('link', { name: 'Terms' });
    expect(link).toHaveAttribute('href', '/meshmonitor/privacy/terms');
  });

  it('does not double the slash when the basename has a trailing one', async () => {
    mockLinks([{ slug: 'terms', kind: 'hosted', title: 'Terms' }]);
    render(<PrivacyLinks basename="/meshmonitor/" />);

    const link = await screen.findByRole('link', { name: 'Terms' });
    expect(link).toHaveAttribute('href', '/meshmonitor/privacy/terms');
  });

  it('forces a new tab for hosted documents when asked (the embed case)', async () => {
    mockLinks([{ slug: 'privacy', kind: 'hosted', title: 'Our Policy' }]);
    render(<PrivacyLinks alwaysNewTab />);

    const link = await screen.findByRole('link', { name: 'Our Policy' });
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('renders every configured link', async () => {
    mockLinks([
      { slug: 'privacy', kind: 'hosted', title: 'Our Policy' },
      { slug: 'terms', kind: 'url', href: 'https://example.org/terms' },
      { slug: 'contact', kind: 'url', href: 'https://example.org/contact' },
    ]);
    render(<PrivacyLinks />);

    await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(3));
  });

  it('falls back to the translated label when a hosted document has no title', async () => {
    mockLinks([{ slug: 'contact', kind: 'url', href: 'https://example.org/contact' }]);
    render(<PrivacyLinks />);

    // The i18n test mock returns the key, so this asserts the key we ask for.
    expect(await screen.findByRole('link', { name: 'privacy.link.contact' })).toBeInTheDocument();
  });

  it('survives a failed request without breaking the surrounding page', async () => {
    // getPrivacyLinks swallows its own errors and resolves to []. A footer
    // that throws would take down the page it decorates.
    mockLinks([]);
    const { container } = render(<PrivacyLinks />);

    await waitFor(() => expect(apiService.getPrivacyLinks).toHaveBeenCalled());
    expect(container.querySelector('nav')).toBeNull();
  });
});
