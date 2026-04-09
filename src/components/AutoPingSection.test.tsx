/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import AutoPingSection from './AutoPingSection';

// Override the global i18n mock from src/test/setup.ts — the component calls
// `t(key, defaultValue)` with an English default, and these tests assert on
// English text like "Auto Ping", "Ping Interval", etc. Return the default.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string | Record<string, unknown>) => {
      if (typeof defaultValue === 'string') return defaultValue;
      return key;
    },
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
  Trans: ({ children }: { children: React.ReactNode }) => children,
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

// Mock the useSourceQuery hook — returns a query suffix string
vi.mock('../hooks/useSourceQuery', () => ({
  useSourceQuery: () => ''
}));

// Mock the useSource context hook
vi.mock('../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: null })
}));

describe('AutoPingSection Component', () => {
  const defaultProps = {
    baseUrl: '',
  };

  const mockSettingsResponse = {
    settings: {
      autoPingEnabled: false,
      autoPingIntervalSeconds: 30,
      autoPingMaxPings: 20,
      autoPingTimeoutSeconds: 60,
    },
    sessions: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCsrfFetch.mockResolvedValue({
      ok: true,
      json: async () => mockSettingsResponse,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Component Rendering', () => {
    it('should render the component with title', async () => {
      render(<AutoPingSection {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText('Auto Ping')).toBeInTheDocument();
      });
    });

    it('should render DM command help text', async () => {
      render(<AutoPingSection {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText('DM Commands')).toBeInTheDocument();
        // Target the <code> tags specifically — the description paragraph
        // also contains the literal text "ping stop".
        expect(screen.getByText('ping 5')).toBeInTheDocument();
        expect(screen.getByText('ping 5').tagName).toBe('CODE');
        expect(screen.getByText('ping stop')).toBeInTheDocument();
        expect(screen.getByText('ping stop').tagName).toBe('CODE');
      });
    });

    it('should render settings inputs', async () => {
      render(<AutoPingSection {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByLabelText(/Ping Interval/)).toBeInTheDocument();
        expect(screen.getByLabelText(/Max Pings/)).toBeInTheDocument();
        expect(screen.getByLabelText(/Ping Timeout/)).toBeInTheDocument();
      });
    });

    it('should render enable/disable checkbox', async () => {
      render(<AutoPingSection {...defaultProps} />);
      await waitFor(() => {
        const checkbox = screen.getByRole('checkbox');
        expect(checkbox).toBeInTheDocument();
      });
    });
  });

  describe('Settings Loading', () => {
    it('should fetch settings on mount', async () => {
      render(<AutoPingSection {...defaultProps} />);
      await waitFor(() => {
        expect(mockCsrfFetch).toHaveBeenCalledWith('/api/settings/auto-ping');
      });
    });

    it('should display loaded settings values', async () => {
      mockCsrfFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          settings: {
            autoPingEnabled: true,
            autoPingIntervalSeconds: 45,
            autoPingMaxPings: 10,
            autoPingTimeoutSeconds: 90,
          },
          sessions: [],
        }),
      });

      render(<AutoPingSection {...defaultProps} />);
      await waitFor(() => {
        const intervalInput = screen.getByLabelText(/Ping Interval/) as HTMLInputElement;
        expect(intervalInput.value).toBe('45');
      });
    });
  });

  describe('Active Sessions', () => {
    it('should not show sessions table when no sessions', async () => {
      render(<AutoPingSection {...defaultProps} />);
      await waitFor(() => {
        expect(screen.queryByText('Active Sessions')).not.toBeInTheDocument();
      });
    });

    it('should show sessions table when sessions exist', async () => {
      mockCsrfFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          settings: mockSettingsResponse.settings,
          sessions: [{
            requestedBy: 0x12345678,
            requestedByName: 'Test Node',
            totalPings: 5,
            completedPings: 2,
            successfulPings: 2,
            failedPings: 0,
            startTime: Date.now(),
            results: [],
          }],
        }),
      });

      render(<AutoPingSection {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText('Active Sessions')).toBeInTheDocument();
        expect(screen.getByText('Test Node')).toBeInTheDocument();
        expect(screen.getByText('2/5')).toBeInTheDocument();
      });
    });
  });

  describe('Save Functionality', () => {
    it('should register with save bar', async () => {
      render(<AutoPingSection {...defaultProps} />);
      await waitFor(() => {
        expect(mockUseSaveBar).toHaveBeenCalledWith(
          expect.objectContaining({
            id: 'auto-ping',
          })
        );
      });
    });
  });
});
