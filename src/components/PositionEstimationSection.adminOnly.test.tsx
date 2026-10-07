/**
 * @vitest-environment jsdom
 *
 * "Recalculate now" recomputes the global estimated-positions table from every
 * source, so the server takes it from admins only. The button must not look
 * usable to anyone else.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import PositionEstimationSection from './PositionEstimationSection';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});

const mockCsrfFetch = vi.fn();
vi.mock('../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => mockCsrfFetch }));
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../hooks/useSaveBar', () => ({ useSaveBar: () => {} }));

let isAdmin = true;
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ authStatus: { authenticated: true, user: { isAdmin } } }),
}));

const status = {
  running: true,
  inProgress: false,
  enabled: true,
  frequencyHours: 6,
  lookbackHours: 24,
  maxUncertaintyKm: 0,
  lastRunTime: null,
  lastRunResult: null,
};

describe('PositionEstimationSection: Recalculate now is admin only', () => {
  beforeEach(() => {
    mockCsrfFetch.mockReset();
    mockCsrfFetch.mockImplementation(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(status) }));
    isAdmin = true;
  });

  it('is disabled, with the reason, for a user who is not an admin', async () => {
    isAdmin = false;
    render(<PositionEstimationSection baseUrl="" />);

    const button = await screen.findByRole('button', { name: 'Recalculate now' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toMatch(/Only an administrator can run this job/);
    fireEvent.click(button);
    expect(mockCsrfFetch.mock.calls.some(c => String(c[0]).endsWith('/run-now'))).toBe(false);
  });

  it('is enabled for an admin', async () => {
    render(<PositionEstimationSection baseUrl="" />);

    const button = await screen.findByRole('button', { name: 'Recalculate now' }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(button.title).toBe('');
  });
});
