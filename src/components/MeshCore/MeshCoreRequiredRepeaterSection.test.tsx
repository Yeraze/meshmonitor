/**
 * MeshCoreRequiredRepeaterSection (#6178): the per-source Required Repeater
 * picker. Lists this source's relays, stores the chosen repeater's full public
 * key, and defaults to "None".
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MeshCoreRequiredRepeaterSection } from './MeshCoreRequiredRepeaterSection';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const h = vi.hoisted(() => ({ csrfFetch: vi.fn(), showToast: vi.fn() }));
vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => h.csrfFetch }));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: h.showToast }) }));

const SOURCE_URL = '/mm/api/settings?sourceId=src-1';

const json = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'application/json' },
  json: async () => body,
});

function mockServer(settings: Record<string, unknown>, postStatus = 200) {
  h.csrfFetch.mockImplementation(async (_url: string, init?: { method?: string }) =>
    init?.method === 'POST' ? json({ success: postStatus === 200 }, postStatus) : json(settings));
}

const REQ = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);
const contacts: MeshCoreContact[] = [
  { publicKey: REQ, advType: 2, advName: 'Backbone' } as MeshCoreContact,
  { publicKey: OTHER, advType: 3, name: 'Room' } as MeshCoreContact,
  { publicKey: 'd'.repeat(64), advType: 1, advName: 'Phone' } as MeshCoreContact, // companion, excluded
];

const select = () => screen.getByTestId('meshcore-required-repeater-select') as HTMLSelectElement;
const posts = () => h.csrfFetch.mock.calls.filter(([, init]) => init?.method === 'POST');

describe('MeshCoreRequiredRepeaterSection (#6178)', () => {
  beforeEach(() => {
    h.csrfFetch.mockReset();
    h.showToast.mockReset();
  });

  it('defaults to None and lists only relays (repeater / room-server)', async () => {
    mockServer({});
    render(<MeshCoreRequiredRepeaterSection baseUrl="/mm" sourceId="src-1" contacts={contacts} />);
    await waitFor(() => expect(h.csrfFetch).toHaveBeenCalledWith(SOURCE_URL));
    expect(select().value).toBe('');
    const options = Array.from(select().querySelectorAll('option')).map(o => o.textContent);
    expect(options).toContain('None (default)');
    expect(options).toContain('Backbone');
    expect(options).toContain('Room');
    expect(options).not.toContain('Phone'); // companion excluded
  });

  it('loads the stored repeater', async () => {
    mockServer({ meshcoreRequiredRepeater: REQ });
    render(<MeshCoreRequiredRepeaterSection baseUrl="/mm" sourceId="src-1" contacts={contacts} />);
    await waitFor(() => expect(select().value).toBe(REQ));
  });

  it('saves the chosen repeater as its full public key', async () => {
    mockServer({});
    render(<MeshCoreRequiredRepeaterSection baseUrl="/mm" sourceId="src-1" contacts={contacts} />);
    await waitFor(() => expect(select().value).toBe(''));
    await userEvent.selectOptions(select(), REQ);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(posts()[0][1].body)).toEqual({ meshcoreRequiredRepeater: REQ });
  });

  it('clears back to None', async () => {
    mockServer({ meshcoreRequiredRepeater: REQ });
    render(<MeshCoreRequiredRepeaterSection baseUrl="/mm" sourceId="src-1" contacts={contacts} />);
    await waitFor(() => expect(select().value).toBe(REQ));
    await userEvent.selectOptions(select(), '');
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(posts()[0][1].body)).toEqual({ meshcoreRequiredRepeater: '' });
  });

  it('keeps a stored repeater unknown to contacts as an extra option', async () => {
    mockServer({ meshcoreRequiredRepeater: 'f'.repeat(64) });
    render(<MeshCoreRequiredRepeaterSection baseUrl="/mm" sourceId="src-1" contacts={contacts} />);
    await waitFor(() => expect(select().value).toBe('f'.repeat(64)));
  });

  it('reverts and toasts on a save failure', async () => {
    mockServer({}, 500);
    render(<MeshCoreRequiredRepeaterSection baseUrl="/mm" sourceId="src-1" contacts={contacts} />);
    await waitFor(() => expect(select().value).toBe(''));
    await userEvent.selectOptions(select(), REQ);
    await waitFor(() => expect(h.showToast).toHaveBeenCalled());
    expect(select().value).toBe('');
  });
});
