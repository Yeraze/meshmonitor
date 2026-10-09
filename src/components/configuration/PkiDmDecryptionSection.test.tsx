/**
 * @vitest-environment jsdom
 *
 * PkiDmDecryptionSection: a MeshMonitor-side switch that moved from Device
 * Configuration to the source's Settings page (#5683 follow-up).
 *
 * The move changes neither what it calls nor what it needs: it reads
 * GET /api/sources/:id/pki-dm/status and saves POST /api/sources/:id/pki-dm
 * `{ enabled }` at once, by itself (it is not part of the Settings draft or
 * the save bar), and the switch needs `configuration:write`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../../contexts/IconStyleContext', () => ({ useIconStyleOptional: () => 'lucide' }));
vi.mock('../../contexts/SourceContext', () => ({ useSource: () => ({ sourceId: 'src a', sourceName: 'A' }) }));
vi.mock('../../services/api', () => ({ default: { getBaseUrl: async () => '/mm' } }));

interface Call { method: string; url: string; body: unknown }
const { state } = vi.hoisted(() => ({
  state: {
    calls: [] as Array<{ method: string; url: string; body: unknown }>,
    status: { enabled: false, globallyEnabled: true, keyStored: false, canStore: true } as Record<string, unknown>,
    statusCode: 200,
  },
}));
vi.mock('../../hooks/useCsrfFetch', () => {
  const csrfFetch = async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    state.calls.push({ method, url, body });
    if (method === 'POST') {
      state.status = { ...state.status, enabled: (body as { enabled: boolean }).enabled };
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
    return { ok: state.statusCode === 200, status: state.statusCode, json: async () => state.status };
  };
  return { useCsrfFetch: () => csrfFetch };
});

import PkiDmDecryptionSection from './PkiDmDecryptionSection';

const posts = (): Call[] => state.calls.filter((call) => call.method === 'POST');
const toggle = () => screen.getByRole('checkbox', { name: 'Decrypt PKI direct messages for this source' });

beforeEach(() => {
  state.calls = [];
  state.status = { enabled: false, globallyEnabled: true, keyStored: false, canStore: true };
  state.statusCode = 200;
});

describe('PkiDmDecryptionSection: same routes, same payload', () => {
  it('reads the status for this source and saves nothing on mount', async () => {
    render(<PkiDmDecryptionSection />);
    await screen.findByTestId('pki-dm-section');
    expect(state.calls).toEqual([{ method: 'GET', url: '/mm/api/sources/src%20a/pki-dm/status', body: undefined }]);
  });

  it('turning it on POSTs { enabled: true } to /pki-dm at once: it saves itself', async () => {
    render(<PkiDmDecryptionSection />);
    fireEvent.click(await waitFor(toggle));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({ method: 'POST', url: '/mm/api/sources/src%20a/pki-dm', body: { enabled: true } });
    await waitFor(() => expect(toggle()).toBeChecked());
  });

  it('turning it off POSTs { enabled: false }', async () => {
    state.status = { ...state.status, enabled: true, keyStored: true };
    render(<PkiDmDecryptionSection />);
    fireEvent.click(await waitFor(toggle));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ enabled: false });
  });
});

describe('PkiDmDecryptionSection: where it renders', () => {
  it('defaults to its Device Configuration anchor, for a viewer who keeps it there', async () => {
    render(<PkiDmDecryptionSection />);
    const section = await screen.findByTestId('pki-dm-section');
    expect(section.id).toBe('config-pki-dm');
    expect(section.classList.contains('config-section')).toBe(true);
  });

  it('takes the Settings anchor and section class when hosted there', async () => {
    render(<PkiDmDecryptionSection sectionId="settings-pki-dm" className="settings-section" />);
    const section = await screen.findByTestId('pki-dm-section');
    expect(section.id).toBe('settings-pki-dm');
    expect(section.classList.contains('settings-section')).toBe(true);
  });

  it('points at Global Settings for the install-wide switch', async () => {
    state.status = { ...state.status, globallyEnabled: false };
    render(<PkiDmDecryptionSection />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Enable it under Security in Global Settings/);
  });

  it('renders nothing when the status read is refused (no configuration:read)', async () => {
    state.statusCode = 403;
    const { container } = render(<PkiDmDecryptionSection />);
    await waitFor(() => expect(state.calls).toHaveLength(1));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('PkiDmDecryptionSection: the switch needs configuration:write', () => {
  it('with it, the switch is enabled and gives no permission note', async () => {
    render(<PkiDmDecryptionSection canWrite />);
    expect(await waitFor(toggle)).not.toBeDisabled();
    expect(screen.queryByText(/needs the Device Configuration write permission/)).toBeNull();
  });

  it('without it, the switch is disabled with the reason and sends nothing', async () => {
    render(<PkiDmDecryptionSection canWrite={false} />);
    const box = await waitFor(toggle);
    expect(box).toBeDisabled();
    expect(box).toHaveAttribute('title', 'Changing this needs the Device Configuration write permission on this source.');
    expect(screen.getByRole('status')).toHaveTextContent(/needs the Device Configuration write permission/);
    fireEvent.click(box);
    expect(posts()).toEqual([]);
  });
});
