/**
 * @vitest-environment jsdom
 *
 * News content is authored on meshmonitor.org, so root-relative links in a feed
 * item must not resolve against the local instance's base URL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { NewsPopup } from './NewsPopup';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

vi.mock('../../services/api', () => ({
  default: {
    getNewsFeed: vi.fn(),
    getUserNewsStatus: vi.fn(),
    updateUserNewsStatus: vi.fn(),
    dismissNewsItem: vi.fn(),
  },
}));

import api from '../../services/api';

const feedWith = (content: string) => ({
  version: '1',
  lastUpdated: '2026-07-27T16:00:00Z',
  items: [
    {
      id: 'news-test',
      title: 'Test item',
      content,
      date: '2026-07-27T16:00:00Z',
      category: 'release' as const,
      priority: 'normal' as const,
    },
  ],
});

describe('NewsPopup link handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderWith = (content: string) => {
    (api.getNewsFeed as ReturnType<typeof vi.fn>).mockResolvedValue(feedWith(content));
    render(<NewsPopup isOpen onClose={vi.fn()} forceShowAll isAuthenticated={false} />);
  };

  it('sends a root-relative link to meshmonitor.org, not the local instance', async () => {
    renderWith('See the [ATAK guide](/features/atak).');

    const link = await screen.findByRole('link', { name: 'ATAK guide' });
    expect(link).toHaveAttribute('href', 'https://meshmonitor.org/features/atak');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('rewrites a root-relative image source', async () => {
    renderWith('![shot](/images/blog/foo.png)');

    const img = await screen.findByAltText('shot');
    expect(img).toHaveAttribute('src', 'https://meshmonitor.org/images/blog/foo.png');
  });

  it('leaves an absolute link untouched', async () => {
    renderWith('The [full changelog](https://github.com/Yeraze/meshmonitor) lists it.');

    const link = await screen.findByRole('link', { name: 'full changelog' });
    expect(link).toHaveAttribute('href', 'https://github.com/Yeraze/meshmonitor');
  });

  it('leaves a protocol-relative link untouched', async () => {
    renderWith('[cdn](//cdn.example.com/a.js)');

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'cdn' })).toHaveAttribute(
        'href',
        '//cdn.example.com/a.js'
      );
    });
  });
});
