/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AutoFavoriteSection from './AutoFavoriteSection';
import { SourceProvider } from '../contexts/SourceContext';

// Local override of the global react-i18next mock (src/test/setup.ts): keeps
// `t()`'s existing "returns the raw key" behavior (this file's pre-existing
// assertions match on key strings), but gives `Trans` a real implementation —
// the global mock's `Trans: ({ children }) => children` renders nothing for
// the aircraft-exclusion-disabled hint below, since that usage carries no
// `children`, only `defaults`/`components`. Mirrors
// CoverageMqttRecordingSection.test.tsx's local override.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options) {
        let result = key;
        Object.entries(options).forEach(([k, v]) => {
          result = result.replace(`{{${k}}}`, String(v));
        });
        return result;
      }
      return key;
    },
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
  Trans: ({ i18nKey, defaults, components }: {
    i18nKey?: string;
    defaults?: string;
    components?: Record<string, React.ReactElement>;
  }) => {
    const template = defaults ?? i18nKey ?? '';
    const linkMatch = template.match(/<link>(.*?)<\/link>/);
    if (!linkMatch) return <>{template}</>;
    const before = template.slice(0, linkMatch.index);
    const after = template.slice((linkMatch.index ?? 0) + linkMatch[0].length);
    const link = components?.link;
    return (
      <>
        {before}
        {link ? React.cloneElement(link, undefined, linkMatch[1]) : linkMatch[1]}
        {after}
      </>
    );
  },
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

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
      // #5364/#5365 WP5 added a second (aircraft-exclusion) checkbox, so this
      // targets the enable checkbox by id rather than the now-ambiguous role.
      const checkbox = document.getElementById('autoFavoriteEnabled') as HTMLInputElement;
      expect(checkbox).toBeInTheDocument();
      expect(checkbox).not.toBeChecked();
    });
  });

  it('passes the active sourceId to /api/auto-favorite/status', async () => {
    // Regression for #2826: the role/firmware status was always read from the
    // legacy first source, so switching sources kept showing the wrong role.
    render(
      <SourceProvider sourceId="src-active" sourceName="Active">
        <AutoFavoriteSection {...defaultProps} />
      </SourceProvider>
    );
    await waitFor(() => {
      expect(mockCsrfFetch).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/auto-favorite\/status\?sourceId=src-active$/)
      );
    });
  });

  it('omits sourceId when no source is active (legacy single-source)', async () => {
    render(<AutoFavoriteSection {...defaultProps} />);
    await waitFor(() => {
      expect(mockCsrfFetch).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/auto-favorite\/status$/)
      );
    });
  });
});

// #5364/#5365 D14, spec §5.11: the "Exclude likely aircraft" switch.
describe('AutoFavoriteSection — likely-aircraft exclusion switch (#5364/#5365 D14)', () => {
  const defaultProps = { baseUrl: '' };

  const mockStatusResponse = {
    localNodeRole: 4, // ROUTER
    firmwareVersion: '2.7.0',
    supportsFavorites: true,
    autoFavoriteNodes: [],
  };

  function mockSettings(settings: Record<string, string>) {
    mockCsrfFetch.mockImplementation((url: string) => {
      if (url.includes('/api/settings')) {
        return Promise.resolve({ ok: true, json: async () => settings });
      }
      if (url.includes('/api/auto-favorite/status')) {
        return Promise.resolve({ ok: true, json: async () => mockStatusResponse });
      }
      return Promise.resolve({ ok: false });
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the switch checked by default when autoFavoriteExcludeAircraft is absent', async () => {
    mockSettings({ autoFavoriteEnabled: 'true', autoFavoriteStaleHours: '72' });
    render(<AutoFavoriteSection {...defaultProps} />);
    await waitFor(() => {
      const checkbox = document.getElementById('autoFavoriteExcludeAircraft') as HTMLInputElement;
      expect(checkbox).toBeInTheDocument();
      expect(checkbox.checked).toBe(true);
      expect(checkbox.disabled).toBe(false);
    });
  });

  it('loads the switch unchecked when autoFavoriteExcludeAircraft is stored as "false"', async () => {
    mockSettings({
      autoFavoriteEnabled: 'true',
      autoFavoriteStaleHours: '72',
      autoFavoriteExcludeAircraft: 'false',
    });
    render(<AutoFavoriteSection {...defaultProps} />);
    await waitFor(() => {
      const checkbox = document.getElementById('autoFavoriteExcludeAircraft') as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
    });
  });

  it('toggling the switch marks the section dirty and POSTs autoFavoriteExcludeAircraft scoped to the active source', async () => {
    mockSettings({ autoFavoriteEnabled: 'true', autoFavoriteStaleHours: '72' });
    render(
      <SourceProvider sourceId="src-active" sourceName="Active">
        <AutoFavoriteSection {...defaultProps} />
      </SourceProvider>
    );

    const checkbox = await waitFor(() => {
      const el = document.getElementById('autoFavoriteExcludeAircraft') as HTMLInputElement;
      expect(el.checked).toBe(true);
      return el;
    });

    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(false));

    const latestOpts = mockUseSaveBar.mock.calls.at(-1)![0] as { hasChanges: boolean; onSave: () => Promise<void> };
    expect(latestOpts.hasChanges).toBe(true);

    await latestOpts.onSave();

    const postCall = mockCsrfFetch.mock.calls.find(
      ([, init]: [string, RequestInit | undefined]) => init?.method === 'POST'
    ) as [string, RequestInit];
    expect(postCall[0]).toMatch(/\/api\/settings\?sourceId=src-active$/);
    const body = JSON.parse(postCall[1].body as string);
    expect(body.autoFavoriteExcludeAircraft).toBe('false');
  });

  it('disables the switch and shows the needs-detection hint linking to #settings-node-display when aircraftDetectionEnabled is off for this source', async () => {
    mockSettings({
      autoFavoriteEnabled: 'true',
      autoFavoriteStaleHours: '72',
      aircraftDetectionEnabled: 'false',
    });
    render(
      <MemoryRouter>
        <AutoFavoriteSection {...defaultProps} />
      </MemoryRouter>
    );

    await waitFor(() => {
      const checkbox = document.getElementById('autoFavoriteExcludeAircraft') as HTMLInputElement;
      expect(checkbox.disabled).toBe(true);
    });

    const hintLink = screen.getByText('Settings → Node Display');
    expect(hintLink.closest('a')).toHaveAttribute('href', '/settings#settings-node-display');
  });

  it('leaves the switch enabled when aircraftDetectionEnabled is on for this source', async () => {
    mockSettings({
      autoFavoriteEnabled: 'true',
      autoFavoriteStaleHours: '72',
      aircraftDetectionEnabled: 'true',
    });
    render(
      <MemoryRouter>
        <AutoFavoriteSection {...defaultProps} />
      </MemoryRouter>
    );

    await waitFor(() => {
      const checkbox = document.getElementById('autoFavoriteExcludeAircraft') as HTMLInputElement;
      expect(checkbox.disabled).toBe(false);
    });
    expect(screen.queryByText('Settings → Node Display')).not.toBeInTheDocument();
  });
});
