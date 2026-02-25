/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import AutoFavoriteSection from './AutoFavoriteSection';

// Mock the useCsrfFetch hook
const mockCsrfFetch = vi.fn();
vi.mock('../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => mockCsrfFetch
}));

// Mock the ToastContainer
const mockShowToast = vi.fn();
vi.mock('./ToastContainer', () => ({
  useToast: () => ({ showToast: mockShowToast })
}));

// Mock the useSaveBar hook
const mockUseSaveBar = vi.fn();
vi.mock('../hooks/useSaveBar', () => ({
  useSaveBar: (opts: any) => mockUseSaveBar(opts)
}));

describe('AutoFavoriteSection Component', () => {
  const defaultProps = {
    baseUrl: '',
  };

  const mockSettingsResponse = {
    autoFavoriteEnabled: 'false',
    autoFavoriteStaleHours: '72',
  };

  const mockStatusResponse = {
    localNodeRole: 4, // ROUTER
    firmwareVersion: '2.7.0',
    supportsFavorites: true,
    autoFavoriteNodes: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock both API calls made by fetchData
    mockCsrfFetch.mockImplementation((url: string) => {
      if (url.includes('/api/settings')) {
        return Promise.resolve({
          ok: true,
          json: async () => mockSettingsResponse,
        });
      }
      if (url.includes('/api/auto-favorite/status')) {
        return Promise.resolve({
          ok: true,
          json: async () => mockStatusResponse,
        });
      }
      return Promise.resolve({ ok: false });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Note: The global react-i18next mock (src/test/setup.ts) returns translation keys,
  // not fallback values, so we match on the i18n key strings.

  it('should render the title "Auto Favorite"', async () => {
    render(<AutoFavoriteSection {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('automation.auto_favorite.title')).toBeInTheDocument();
    });
  });

  it('should render the description text about automatically favoriting eligible nodes', async () => {
    render(<AutoFavoriteSection {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('automation.auto_favorite.description')).toBeInTheDocument();
    });
  });

  it('should render the "Read more" link pointing to the correct URL', async () => {
    render(<AutoFavoriteSection {...defaultProps} />);
    await waitFor(() => {
      const readMoreLink = screen.getByText('automation.auto_favorite.read_more');
      expect(readMoreLink).toBeInTheDocument();
      expect(readMoreLink.closest('a')).toHaveAttribute(
        'href',
        'https://meshtastic.org/blog/zero-cost-hops-favorite-routers/'
      );
      expect(readMoreLink.closest('a')).toHaveAttribute('target', '_blank');
      expect(readMoreLink.closest('a')).toHaveAttribute('rel', 'noopener noreferrer');
    });
  });

  it('should render the enable checkbox', async () => {
    render(<AutoFavoriteSection {...defaultProps} />);
    await waitFor(() => {
      const checkbox = screen.getByRole('checkbox');
      expect(checkbox).toBeInTheDocument();
      expect(checkbox).not.toBeChecked();
    });
  });
});
