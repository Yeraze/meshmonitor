/**
 * MeshCoreRequiredRepeaterSection (#6178 → #6193): the per-source Required
 * Repeaters picker. Offers only DIRECT relays (pathLen 0), stores the chosen
 * repeaters' full public keys as a list plus an ANY/ALL mode, and keeps (but
 * flags) a configured key that is no longer direct.
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

const REQ = 'b'.repeat(64);     // direct repeater
const NEAR = 'c'.repeat(64);    // direct repeater
const ROOM = 'd'.repeat(64);    // direct room-server
const FLOOD = 'e'.repeat(64);   // relay, pathLen unknown (flood) → excluded
const FAR = 'f'.repeat(64);     // relay, pathLen 3 → excluded
const PHONE = '1'.repeat(64);   // companion → excluded

const contacts: MeshCoreContact[] = [
  { publicKey: REQ, advType: 2, advName: 'Backbone', pathLen: 0 } as MeshCoreContact,
  { publicKey: NEAR, advType: 2, name: 'Nearby', pathLen: 0 } as MeshCoreContact,
  { publicKey: ROOM, advType: 3, advName: 'Room', pathLen: 0 } as MeshCoreContact,
  { publicKey: FLOOD, advType: 2, advName: 'Flooder', pathLen: null } as MeshCoreContact,
  { publicKey: FAR, advType: 2, advName: 'FarRepeater', pathLen: 3 } as MeshCoreContact,
  { publicKey: PHONE, advType: 1, advName: 'Phone', pathLen: 0 } as MeshCoreContact,
];

const option = (key: string) =>
  screen.queryByTestId(`meshcore-required-repeater-option-${key}`) as HTMLInputElement | null;
const modeSelect = () => screen.getByTestId('meshcore-required-repeater-mode') as HTMLSelectElement;
const posts = () => h.csrfFetch.mock.calls.filter(([, init]) => init?.method === 'POST');
const lastPostBody = () => JSON.parse(posts()[posts().length - 1][1].body);

describe('MeshCoreRequiredRepeaterSection (#6193)', () => {
  beforeEach(() => {
    h.csrfFetch.mockReset();
    h.showToast.mockReset();
  });

  it('offers only DIRECT relays (pathLen 0, relay advType)', async () => {
    mockServer({});
    render(<MeshCoreRequiredRepeaterSection baseUrl="/mm" sourceId="src-1" contacts={contacts} />);
    await waitFor(() => expect(h.csrfFetch).toHaveBeenCalledWith(SOURCE_URL));
    // Direct repeaters and room-server offered.
    expect(option(REQ)).not.toBeNull();
    expect(option(NEAR)).not.toBeNull();
    expect(option(ROOM)).not.toBeNull();
    // pathLen unknown / > 0, and a companion, are NOT offered.
    expect(option(FLOOD)).toBeNull();
    expect(option(FAR)).toBeNull();
    expect(option(PHONE)).toBeNull();
    expect(modeSelect().value).toBe('any');
  });

  it('loads stored list + mode from the new keys', async () => {
    mockServer({ meshcoreRequiredRepeaters: JSON.stringify([REQ, NEAR]), meshcoreRequiredRepeaterMode: 'all' });
    render(<MeshCoreRequiredRepeaterSection baseUrl="/mm" sourceId="src-1" contacts={contacts} />);
    await waitFor(() => expect(option(REQ)?.checked).toBe(true));
    expect(option(NEAR)?.checked).toBe(true);
    expect(modeSelect().value).toBe('all');
  });

  it('back-compat: loads the legacy single key as a one-item list', async () => {
    mockServer({ meshcoreRequiredRepeater: REQ });
    render(<MeshCoreRequiredRepeaterSection baseUrl="/mm" sourceId="src-1" contacts={contacts} />);
    await waitFor(() => expect(option(REQ)?.checked).toBe(true));
    expect(option(NEAR)?.checked).toBe(false);
  });

  it('multi-selects (add) and writes the new keys, clearing the legacy key', async () => {
    mockServer({});
    render(<MeshCoreRequiredRepeaterSection baseUrl="/mm" sourceId="src-1" contacts={contacts} />);
    await waitFor(() => expect(option(REQ)).not.toBeNull());
    await userEvent.click(option(REQ)!);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(lastPostBody()).toEqual({
      meshcoreRequiredRepeaters: JSON.stringify([REQ]),
      meshcoreRequiredRepeaterMode: 'any',
      meshcoreRequiredRepeater: '',
    });
    await userEvent.click(option(NEAR)!);
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(JSON.parse(lastPostBody().meshcoreRequiredRepeaters)).toEqual([REQ, NEAR]);
  });

  it('removes a selected repeater', async () => {
    mockServer({ meshcoreRequiredRepeaters: JSON.stringify([REQ, NEAR]) });
    render(<MeshCoreRequiredRepeaterSection baseUrl="/mm" sourceId="src-1" contacts={contacts} />);
    await waitFor(() => expect(option(REQ)?.checked).toBe(true));
    await userEvent.click(option(REQ)!);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(lastPostBody().meshcoreRequiredRepeaters)).toEqual([NEAR]);
  });

  it('toggles the ANY/ALL mode and saves it', async () => {
    mockServer({ meshcoreRequiredRepeaters: JSON.stringify([REQ]) });
    render(<MeshCoreRequiredRepeaterSection baseUrl="/mm" sourceId="src-1" contacts={contacts} />);
    await waitFor(() => expect(option(REQ)?.checked).toBe(true));
    await userEvent.selectOptions(modeSelect(), 'all');
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(lastPostBody().meshcoreRequiredRepeaterMode).toBe('all');
    expect(JSON.parse(lastPostBody().meshcoreRequiredRepeaters)).toEqual([REQ]);
  });

  it('keeps BUT FLAGS a configured key that is no longer direct', async () => {
    // FAR is a relay with pathLen 3 (not direct) but is in the saved list.
    mockServer({ meshcoreRequiredRepeaters: JSON.stringify([FAR]) });
    render(<MeshCoreRequiredRepeaterSection baseUrl="/mm" sourceId="src-1" contacts={contacts} />);
    await waitFor(() => expect(option(FAR)).not.toBeNull());
    // Still selected, not silently dropped, and flagged.
    expect(option(FAR)!.checked).toBe(true);
    expect(screen.getByTestId(`meshcore-required-repeater-flagged-${FAR}`)).toBeTruthy();
    expect(screen.getByTestId(`meshcore-required-repeater-flag-${FAR}`).textContent).toMatch(/no longer direct/);
  });

  it('flags a configured key with no known contact', async () => {
    const UNKNOWN = '9'.repeat(64);
    mockServer({ meshcoreRequiredRepeaters: JSON.stringify([UNKNOWN]) });
    render(<MeshCoreRequiredRepeaterSection baseUrl="/mm" sourceId="src-1" contacts={contacts} />);
    await waitFor(() => expect(option(UNKNOWN)).not.toBeNull());
    expect(option(UNKNOWN)!.checked).toBe(true);
    expect(screen.getByTestId(`meshcore-required-repeater-flag-${UNKNOWN}`).textContent).toMatch(/not a known relay/);
  });

  it('reverts and toasts on a save failure', async () => {
    mockServer({}, 500);
    render(<MeshCoreRequiredRepeaterSection baseUrl="/mm" sourceId="src-1" contacts={contacts} />);
    await waitFor(() => expect(option(REQ)).not.toBeNull());
    await userEvent.click(option(REQ)!);
    await waitFor(() => expect(h.showToast).toHaveBeenCalled());
    expect(option(REQ)!.checked).toBe(false);
  });
});
