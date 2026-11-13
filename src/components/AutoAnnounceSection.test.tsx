/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import enTranslations from '../../public/locales/en.json';
import AutoAnnounceSection from './AutoAnnounceSection';
import { Channel } from '../types/device';

// Override the global i18n mock (from src/test/setup.ts) with real translations
// from en.json so text-based assertions like `getByText('Auto Announce')` work.
vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  const t = (key: string, options?: Record<string, unknown>) => {
    const translations = enTranslations as unknown as Record<string, string>;
    let result = translations[key] ?? key;
    if (options) {
      Object.entries(options).forEach(([k, v]) => {
        result = result.replace(`{{${k}}}`, String(v));
      });
    }
    return result;
  };
  return createReactI18nextMock(t);
});

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

// Mock useSaveBar — component registers with SaveBar context which isn't
// mounted in isolation. Tests can assert on the registered handler via mockUseSaveBar.
const mockUseSaveBar = vi.fn();
vi.mock('../hooks/useSaveBar', () => ({
  useSaveBar: (opts: unknown) => mockUseSaveBar(opts)
}));

// Mock useSourceQuery — hook depends on React Query context
vi.mock('../hooks/useSourceQuery', () => ({
  useSourceQuery: () => ({ sourceId: null, baseUrl: '' })
}));

// Mock fetch for last announcement time
global.fetch = vi.fn();

describe('AutoAnnounceSection — firmware 2.8 MeshBeacon notice (#4731)', () => {
  const props = {
    enabled: true,
    intervalHours: 6,
    message: 'hi',
    channelIndexes: [0],
    announceOnStart: false,
    useSchedule: false,
    schedule: '0 */6 * * *',
    channels: [] as Channel[],
    baseUrl: '',
    onEnabledChange: vi.fn(),
    onIntervalChange: vi.fn(),
    onMessageChange: vi.fn(),
    onChannelIndexesChange: vi.fn(),
    onAnnounceOnStartChange: vi.fn(),
    onUseScheduleChange: vi.fn(),
    onScheduleChange: vi.fn(),
  };

  beforeEach(() => {
    (global.fetch as any) = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ lastAnnouncementTime: Date.now() }),
    });
  });

  it('renders the notice, worded to the verified firmware behavior', () => {
    render(<AutoAnnounceSection {...props} />);
    const notice = screen.getByText(/firmware 2\.8's MeshBeacon module/i);
    expect(notice).toBeInTheDocument();
    expect(notice.textContent).toMatch(/zero-hop/i);
    // MeshBeacon shipped in tagged v2.8.0.* prereleases, so the notice must say
    // "alpha/prerelease", not "development branch, not a released firmware" (#5056).
    expect(notice.textContent).toMatch(/alpha\/prerelease/i);
    expect(notice.textContent || '').not.toMatch(/development branch/i);
    // Must NOT claim a native "Auto Welcome" exists (the firmware has none).
    expect(notice.textContent || '').not.toMatch(/auto[- ]?welcome/i);
  });
});

describe('AutoAnnounceSection — TX-disabled and permission gating (#5807)', () => {
  const props = {
    enabled: true,
    intervalHours: 6,
    message: 'hi',
    channelIndexes: [0],
    announceOnStart: false,
    useSchedule: false,
    schedule: '0 */6 * * *',
    channels: [] as Channel[],
    baseUrl: '',
    onEnabledChange: vi.fn(),
    onIntervalChange: vi.fn(),
    onMessageChange: vi.fn(),
    onChannelIndexesChange: vi.fn(),
    onAnnounceOnStartChange: vi.fn(),
    onUseScheduleChange: vi.fn(),
    onScheduleChange: vi.fn(),
  };

  beforeEach(() => {
    (global.fetch as any) = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ lastAnnouncementTime: Date.now() }),
    });
  });

  it('enables Send Now by default and shows no paused note', () => {
    render(<AutoAnnounceSection {...props} />);
    expect(screen.getByText('Send Now').closest('button')).not.toBeDisabled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('disables Send Now and shows the paused note when the source cannot transmit', () => {
    render(<AutoAnnounceSection {...props} receiveOnly />);
    expect(screen.getByText('Send Now').closest('button')).toBeDisabled();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('disables Send Now, the enable toggle and the fields without write permission', () => {
    render(<AutoAnnounceSection {...props} canWrite={false} />);
    expect(screen.getByText('Send Now').closest('button')).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Auto Announce' })).toBeDisabled();
    const textboxes = screen.getAllByRole('textbox');
    expect(textboxes.length).toBeGreaterThan(0);
    textboxes.forEach(box => expect(box).toBeDisabled());
  });
});

describe('AutoAnnounceSection — token insert buttons', () => {
  const props = {
    enabled: true,
    intervalHours: 6,
    message: 'Hello XXX world',
    channelIndexes: [0],
    announceOnStart: false,
    useSchedule: false,
    schedule: '0 */6 * * *',
    channels: [] as Channel[],
    baseUrl: '',
    onEnabledChange: vi.fn(),
    onIntervalChange: vi.fn(),
    onMessageChange: vi.fn(),
    onChannelIndexesChange: vi.fn(),
    onAnnounceOnStartChange: vi.fn(),
    onUseScheduleChange: vi.fn(),
    onScheduleChange: vi.fn(),
  };

  beforeEach(() => {
    (global.fetch as any) = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ lastAnnouncementTime: Date.now() }),
    });
  });

  it('replaces the textarea selection with the clicked token', () => {
    const { container } = render(<AutoAnnounceSection {...props} />);
    const textarea = container.querySelector('#announceMessage') as HTMLTextAreaElement;
    textarea.setSelectionRange(6, 9);
    fireEvent.click(screen.getByRole('button', { name: '+ {VERSION}' }));
    expect(textarea.value).toBe('Hello {VERSION} world');
  });
});
