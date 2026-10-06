/**
 * @vitest-environment jsdom
 *
 * Remote Admin Scanner number fields (#5649).
 *
 * The scan interval is a mesh timer: each scan sends admin requests to nodes.
 * The field used to be `parseInt(value) || 5`, so a cleared field snapped back
 * to 5 and the user could not type a new value. It can now be cleared; while
 * it is blank or outside 1-60 the SaveBar will not save, and the value that is
 * saved in the end is the whole number the user typed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const h = vi.hoisted(() => ({ csrfFetch: vi.fn(), showToast: vi.fn() }));

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock((key: string) => key);
});
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: h.showToast }) }));
vi.mock('../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => h.csrfFetch }));
vi.mock('../hooks/useSourceQuery', () => ({ useSourceQuery: () => '' }));
vi.mock('../contexts/SettingsContext', () => ({ useSettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }) }));

import RemoteAdminScannerSection from './RemoteAdminScannerSection';
import { SaveBarProvider } from '../contexts/SaveBarContext';
import { SaveBar } from './SaveBar';

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const savedBodies = () =>
  h.csrfFetch.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, string>);

async function renderSection() {
  render(
    <SaveBarProvider>
      <RemoteAdminScannerSection baseUrl="" />
      <SaveBar />
    </SaveBarProvider>,
  );
  // Loaded: scanner on, every 10 minutes, 72 h expiry.
  await waitFor(() => expect((document.getElementById('scannerInterval') as HTMLInputElement | null)?.value).toBe('10'));
  return {
    interval: document.getElementById('scannerInterval') as HTMLInputElement,
    expiry: document.getElementById('scannerExpiration') as HTMLInputElement,
  };
}

const saveButton = () => screen.getByRole('button', { name: 'common.save' }) as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  h.csrfFetch.mockImplementation(async (url: string) => {
    if (url.includes('/api/settings')) {
      return json({ remoteAdminScannerIntervalMinutes: '10', remoteAdminScannerExpirationHours: '72' });
    }
    return json([]);
  });
});

describe('RemoteAdminScannerSection number fields (#5649)', () => {
  it('lets the interval be cleared and retyped, and saves the typed whole number', async () => {
    const { interval, expiry } = await renderSection();

    // Make the section dirty through the other field so the SaveBar is up.
    fireEvent.change(expiry, { target: { value: '48' } });
    expect(saveButton()).not.toBeDisabled();

    fireEvent.change(interval, { target: { value: '' } });
    // Blank stays blank: the old code put 5 back here.
    expect(interval.value).toBe('');
    expect(interval).toHaveAttribute('aria-invalid', 'true');
    expect(saveButton()).toBeDisabled();
    expect(screen.getByText('savebar.fix_invalid_fields')).toBeInTheDocument();
    fireEvent.click(saveButton());
    expect(savedBodies()).toEqual([]);

    fireEvent.change(interval, { target: { value: '20' } });
    expect(saveButton()).not.toBeDisabled();
    fireEvent.click(saveButton());

    await waitFor(() => expect(savedBodies()).toHaveLength(1));
    expect(savedBodies()[0]).toMatchObject({
      remoteAdminScannerIntervalMinutes: '20',
      remoteAdminScannerExpirationHours: '48',
    });
  });

  it('blocks an interval under the 1 minute floor or over 60, and never saves 0 for it', async () => {
    const { interval, expiry } = await renderSection();
    fireEvent.change(expiry, { target: { value: '48' } });

    for (const bad of ['0', '-3', '61', '2.5']) {
      fireEvent.change(interval, { target: { value: bad } });
      expect(interval.value).toBe(bad);
      expect(interval, bad).toHaveAttribute('aria-invalid', 'true');
      expect(saveButton(), bad).toBeDisabled();
      fireEvent.click(saveButton());
    }
    expect(savedBodies()).toEqual([]);
  });

  it('blocks an expiry outside 24-168 hours', async () => {
    const { interval, expiry } = await renderSection();
    fireEvent.change(interval, { target: { value: '15' } });
    expect(saveButton()).not.toBeDisabled();

    fireEvent.change(expiry, { target: { value: '5' } });
    expect(expiry).toHaveAttribute('aria-invalid', 'true');
    expect(saveButton()).toBeDisabled();

    fireEvent.change(expiry, { target: { value: '' } });
    expect(saveButton()).toBeDisabled();
    fireEvent.click(saveButton());
    expect(savedBodies()).toEqual([]);
  });

  it('Dismiss puts the saved values back in a blank field', async () => {
    const { interval, expiry } = await renderSection();
    fireEvent.change(expiry, { target: { value: '48' } });
    fireEvent.change(interval, { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: 'common.dismiss' }));

    await waitFor(() => expect(interval.value).toBe('10'));
    expect(expiry.value).toBe('72');
    expect(interval).not.toHaveAttribute('aria-invalid');
  });
});
