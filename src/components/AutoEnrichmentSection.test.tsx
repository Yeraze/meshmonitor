/**
 * @vitest-environment jsdom
 *
 * Auto-Enrichment settings (#5287). Modeled on MeshIssuesSection.test.tsx:
 * mocks useCsrfFetch / useSaveBar / ToastContainer directly.
 *
 * Covers two review follow-ups on #5322: a status refresh (after Run now, or
 * while polling a run) must never overwrite edits the user has not saved, and
 * the airtime warning must sit next to the push option.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import AutoEnrichmentSection from './AutoEnrichmentSection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string | Record<string, unknown>) => {
      if (typeof defaultValue === 'string') return defaultValue;
      if (defaultValue && typeof defaultValue === 'object' && 'defaultValue' in defaultValue) {
        return String((defaultValue as Record<string, unknown>).defaultValue);
      }
      return key;
    },
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
  Trans: ({ children }: { children: React.ReactNode }) => children,
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

const mockCsrfFetch = vi.fn();
vi.mock('../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => mockCsrfFetch }));

const mockShowToast = vi.fn();
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: mockShowToast }) }));

vi.mock('../hooks/useSaveBar', () => ({ useSaveBar: () => {} }));

function status(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    scheduleType: 'interval',
    intervalMinutes: 360,
    cron: '',
    cronValid: false,
    pushToNodeDb: false,
    inProgress: false,
    lastRunAt: null,
    lastRunSummary: null,
    pendingPushes: 0,
    limits: { minIntervalMinutes: 60, maxIntervalMinutes: 10080, pushCapPerRun: 25, pushSpacingMs: 30000 },
    ...overrides,
  };
}

function json(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return Promise.resolve({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: () => Promise.resolve(body),
  });
}

describe('AutoEnrichmentSection (#5287)', () => {
  beforeEach(() => {
    mockCsrfFetch.mockReset();
    mockShowToast.mockReset();
  });

  it('states the push airtime cost next to the push option', async () => {
    mockCsrfFetch.mockImplementation(() => json({ success: true, data: status() }));
    render(<AutoEnrichmentSection baseUrl="" />);

    const note = await screen.findByRole('note');
    expect(note.textContent).toMatch(/NodeInfo request over the mesh/);
    expect(note.textContent).toMatch(/25 per run, 30 s apart/);
  });

  it('keeps an unsaved edit when Run now refreshes the status', async () => {
    mockCsrfFetch.mockImplementation((url: string) => {
      if (url.endsWith('/run-now')) {
        return json({ success: true, data: { nodesFilled: 1, fieldsCopied: 2, pushesSent: 0, pushesFailed: 0, pushesPending: 0 } });
      }
      return json({ success: true, data: status() });
    });
    render(<AutoEnrichmentSection baseUrl="" />);

    // The user changes the interval but has not saved.
    const interval = await screen.findByLabelText('Run every') as HTMLSelectElement;
    await waitFor(() => expect(interval.value).toBe('6'));
    fireEvent.change(interval, { target: { value: '24' } });
    expect(interval.value).toBe('24');

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(mockShowToast).toHaveBeenCalled());
    // The refresh after the run must not reset the draft back to 6 hours.
    await waitFor(() =>
      expect(mockCsrfFetch.mock.calls.filter(c => String(c[0]).endsWith('/status')).length).toBeGreaterThan(1));
    expect((screen.getByLabelText('Run every') as HTMLSelectElement).value).toBe('24');
  });
});
