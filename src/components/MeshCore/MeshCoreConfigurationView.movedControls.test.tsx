/**
 * MeshCore Device Configuration with the controls that moved in from the
 * Settings tab (#5683 follow-up), driven through the REAL useMeshCore hook so
 * the assertions are on the HTTP requests themselves.
 *
 * The move must not change what is sent to the radio or when. So this checks,
 * for each moved control: the route and the body are the ones the Settings
 * tab sent; opening the page sends no write and no transmitting request;
 * saving one section sends only that section; each control is gated on the
 * grant its own route checks, with and without it.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

let grants: (resource: string, action: string) => boolean = () => true;
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (resource: string, action: string) => grants(resource, action) }),
}));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => (globalThis as { fetch: typeof fetch }).fetch,
}));
vi.mock('../../contexts/MapContext', () => ({
  useMapContext: () => ({ setMeshCoreNodes: vi.fn() }),
}));
vi.mock('../../contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({
    state: { socket: { connected: true, on: vi.fn(), off: vi.fn(), emit: vi.fn(), io: { on: vi.fn(), off: vi.fn() } } },
  }),
}));
// Sections that were already on this page and own their own requests.
vi.mock('./MeshCoreChannelsConfigSection', () => ({ MeshCoreChannelsConfigSection: () => null }));
vi.mock('./MeshCoreLocalConsole', () => ({ MeshCoreLocalConsole: () => <div data-testid="local-console" /> }));
vi.mock('./MeshCoreObserverSection', () => ({ MeshCoreObserverSection: () => null }));

import { useMeshCore } from './hooks/useMeshCore';
import { MeshCoreConfigurationView } from './MeshCoreConfigurationView';

const SOURCE_ID = 'src-1';
const PREFIX = `/api/sources/${SOURCE_ID}/meshcore`;

interface Call { method: string; path: string; body: unknown }
let calls: Call[] = [];

/** Requests that change something or key the radio: every non-GET. */
const writes = () => calls.filter((call) => call.method !== 'GET');
const find = (method: string, path: string) =>
  calls.filter((call) => call.method === method && call.path === `${PREFIX}${path}`);

const STATUS = {
  connected: true, deviceType: 1, deviceTypeName: 'Companion', config: null,
  localNode: { publicKey: 'a'.repeat(64), name: 'Me', advType: 1 },
};

function respond(path: string, method: string, body: unknown): unknown {
  if (path.endsWith('/snapshot')) {
    return { success: true, data: { status: STATUS, contacts: [], nodes: [], messages: [], seqCursor: 0 } };
  }
  // A save re-reads the status; the node stays connected.
  if (path.endsWith('/status')) return { success: true, data: STATUS };
  if (path.endsWith('/config/default-path-hash-size')) {
    return { success: true, size: method === 'GET' ? 1 : (body as { size: number }).size };
  }
  if (path.endsWith('/config/default-scope')) {
    return { success: true, scope: method === 'GET' ? 'bayern' : (body as { scope: string }).scope };
  }
  if (path.endsWith('/saved-regions')) return { success: true, data: [], regions: [] };
  if (path.endsWith('/contacts/device-sync')) {
    return {
      success: true,
      data: { autoAddContacts: false, deviceContactCount: 3, favoriteCount: 2, missingFavorites: 1, maxContacts: 100 },
    };
  }
  if (path.endsWith('/contacts/push-to-device')) {
    return {
      success: true,
      data: {
        added: [], alreadyOnDevice: 0, skipped: [], notAddedNoRoom: 0, evicted: [],
        capacityKnown: true, maxContacts: 100, freeSlotsBefore: 97, freeSlotsAfter: 97,
      },
    };
  }
  if (path.endsWith('/regions/discover')) return { success: true, data: { regions: ['muenchen'], noZeroHopRepeaters: false } };
  if (path.endsWith('/discover')) return { success: true, data: { returned: 0, newCount: 0, nodes: [] } };
  return { success: true, data: {} };
}

function installFetch() {
  calls = [];
  (globalThis as { fetch: unknown }).fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = String(url).split('?')[0];
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    return { ok: true, status: 200, json: async () => respond(path, method, body) };
  });
}

const Harness: React.FC<{ receiveOnly?: boolean }> = ({ receiveOnly = false }) => {
  const { status, actions, loading } = useMeshCore({ baseUrl: '', sourceId: SOURCE_ID, enabled: true });
  return (
    <MeshCoreConfigurationView
      status={status}
      actions={actions}
      baseUrl=""
      sourceId={SOURCE_ID}
      receiveOnly={receiveOnly}
      loading={loading}
    />
  );
};

async function renderPage(props: { receiveOnly?: boolean } = {}) {
  render(<Harness {...props} />);
  // Connected and the moved sections have read their values.
  await waitFor(() => expect(find('GET', '/config/default-scope')).toHaveLength(1));
  await waitFor(() => expect(find('GET', '/config/default-path-hash-size')).toHaveLength(1));
  await screen.findByRole('heading', { name: 'Device actions' });
}

const button = (name: string) => screen.getByRole('button', { name });

beforeEach(() => {
  grants = () => true;
  installFetch();
});

describe('MeshCore Device Configuration: opening the page', () => {
  it('sends no write and no transmitting request', async () => {
    await renderPage();
    // Let any stray effect run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(writes()).toEqual([]);
  });

  it('shows the moved settings, the contact sync and one Device actions group, in that order', async () => {
    await renderPage();
    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent);
    const order = [
      'Telemetry', 'Default path hash size', 'Default region / scope',
      'Device actions', 'Contacts and adverts', 'Discover nodes',
    ].map((name) => headings.indexOf(name));
    expect(order.every((index) => index >= 0), JSON.stringify(headings)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(headings.filter((name) => name === 'Device actions')).toHaveLength(1);
    // The actions sit in their own group, apart from the saved settings.
    const group = screen.getByTestId('meshcore-device-actions');
    expect(within(group).getByRole('button', { name: 'Refresh contacts' })).toBeInTheDocument();
    expect(within(group).queryByRole('button', { name: 'Save path hash size' })).toBeNull();
    // And above the console, not appended after the danger zone.
    expect(group.compareDocumentPosition(screen.getByTestId('local-console')) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });
});

describe('MeshCore Device Configuration: each moved control sends what it sent from Settings', () => {
  it('Refresh contacts: POST /contacts/refresh, no body', async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(button('Refresh contacts'));
    await waitFor(() => expect(find('POST', '/contacts/refresh')).toHaveLength(1));
    expect(find('POST', '/contacts/refresh')[0].body).toBeUndefined();
    expect(writes()).toHaveLength(1);
  });

  it('zero-hop advert: POST /advert {mode: zero_hop}, once', async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(button('Advert (nearby, zero-hop)'));
    await waitFor(() => expect(find('POST', '/advert')).toHaveLength(1));
    expect(find('POST', '/advert')[0].body).toEqual({ mode: 'zero_hop' });
  });

  it('flood advert: nothing until confirmed, then POST /advert {mode: flood}', async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(button('Flood advert'));
    expect(find('POST', '/advert')).toHaveLength(0);
    await user.click(button('Send flood advert'));
    await waitFor(() => expect(find('POST', '/advert')).toHaveLength(1));
    expect(find('POST', '/advert')[0].body).toEqual({ mode: 'flood' });
  });

  it.each([
    ['Discover Nearby Nodes', 'nearby'],
    ['Discover Repeaters', 'repeaters'],
    ['Discover Sensors', 'sensors'],
  ])('%s: POST /discover {mode: %s}, once', async (name, mode) => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(button(name));
    await waitFor(() => expect(find('POST', '/discover')).toHaveLength(1));
    expect(find('POST', '/discover')[0].body).toEqual({ mode });
    expect(find('POST', '/advert')).toHaveLength(0);
  });

  it('default path hash size: POST /config/default-path-hash-size {size}, only on Save', async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Default path hash size' }), '2');
    expect(writes()).toEqual([]);
    await user.click(button('Save path hash size'));
    await waitFor(() => expect(find('POST', '/config/default-path-hash-size')).toHaveLength(1));
    expect(find('POST', '/config/default-path-hash-size')[0].body).toEqual({ size: 2 });
    expect(writes()).toHaveLength(1);
  });

  it('default scope: POST /config/default-scope {scope}, only on Save', async () => {
    const user = userEvent.setup();
    await renderPage();
    const input = screen.getByRole('textbox', { name: 'Default region / scope' });
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('bayern'));
    await user.clear(input);
    await user.type(input, 'muenchen');
    expect(writes()).toEqual([]);
    await user.click(button('Save default scope'));
    await waitFor(() => expect(find('POST', '/config/default-scope')).toHaveLength(1));
    expect(find('POST', '/config/default-scope')[0].body).toEqual({ scope: 'muenchen' });
    expect(writes()).toHaveLength(1);
  });

  it('region sweep: POST /regions/discover, no body, only on its button', async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(button('Discover regions from repeaters'));
    await waitFor(() => expect(find('POST', '/regions/discover')).toHaveLength(1));
    expect(find('POST', '/regions/discover')[0].body).toBeUndefined();
    expect(writes()).toHaveLength(1);
  });

  it('contact sync: reads GET /contacts/device-sync, and pushes only on its button', async () => {
    const user = userEvent.setup();
    await renderPage();
    await waitFor(() => expect(find('GET', '/contacts/device-sync').length).toBeGreaterThan(0));
    expect(find('POST', '/contacts/push-to-device')).toHaveLength(0);
    expect(find('POST', '/config/auto-add-contacts')).toHaveLength(0);
    await user.click(await screen.findByRole('button', { name: 'Push to radio' }));
    await waitFor(() => expect(find('POST', '/contacts/push-to-device')).toHaveLength(1));
  });

  it('saving a section that was here before sends none of the moved controls', async () => {
    const user = userEvent.setup();
    await renderPage();
    // Dirty a moved field, then save an unrelated section.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Default path hash size' }), '3');
    await user.click(button('Save name'));
    await waitFor(() => expect(find('POST', '/config/name')).toHaveLength(1));
    expect(writes().map((call) => call.path)).toEqual([`${PREFIX}/config/name`]);
    // The unsaved edit is still there, and still unsaved.
    expect((screen.getByRole('combobox', { name: 'Default path hash size' }) as HTMLSelectElement).value).toBe('3');
    expect(button('Save path hash size')).not.toBeDisabled();
  });
});

describe('MeshCore Device Configuration: receive-only holds every transmitting control', () => {
  it('disables adverts, Discover x3 and the region sweep; Refresh and Save stay usable', async () => {
    await renderPage({ receiveOnly: true });
    for (const name of [
      'Advert (nearby, zero-hop)', 'Flood advert', 'Discover Nearby Nodes',
      'Discover Repeaters', 'Discover Sensors', 'Discover regions from repeaters',
    ]) {
      expect(button(name), name).toBeDisabled();
    }
    expect(button('Refresh contacts')).not.toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Default path hash size' })).not.toBeDisabled();
  });
});

describe('MeshCore Device Configuration: each moved control is gated on its own grant', () => {
  const deny = (...denied: string[]) => (resource: string, action: string) =>
    !denied.includes(`${resource}:${action}`);

  it('configuration:write only (no nodes:write, no connection:write): settings editable, actions disabled', async () => {
    grants = deny('nodes:write', 'connection:write');
    const user = userEvent.setup();
    await renderPage();
    expect(screen.getByRole('combobox', { name: 'Default path hash size' })).not.toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Default region / scope' })).not.toBeDisabled();
    for (const name of [
      'Refresh contacts', 'Advert (nearby, zero-hop)', 'Flood advert',
      'Discover Nearby Nodes', 'Discover regions from repeaters',
    ]) {
      expect(button(name), name).toBeDisabled();
      expect(button(name).getAttribute('title'), name).toMatch(/write permission on this source/);
      await user.click(button(name));
    }
    expect(writes()).toEqual([]);
  });

  it('nodes:write and connection:write but configuration read-only: actions usable, settings disabled', async () => {
    grants = deny('configuration:write');
    await renderPage();
    for (const name of ['Refresh contacts', 'Advert (nearby, zero-hop)', 'Discover Nearby Nodes', 'Discover regions from repeaters']) {
      expect(button(name), name).not.toBeDisabled();
    }
    expect(screen.getByRole('combobox', { name: 'Default path hash size' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Default region / scope' })).toBeDisabled();
    expect(button('Save path hash size')).toBeDisabled();
    expect(button('Save default scope')).toBeDisabled();
    // The page already says why its saves are off.
    expect(screen.getByRole('status')).toHaveTextContent(/don't have permission to change configuration/);
  });

  it('connection:write alone: adverts usable, node actions disabled with the reason', async () => {
    grants = deny('nodes:write', 'configuration:write');
    await renderPage();
    expect(button('Advert (nearby, zero-hop)')).not.toBeDisabled();
    expect(button('Refresh contacts')).toBeDisabled();
    expect(button('Refresh contacts')).toHaveAttribute('title', 'This needs the Nodes write permission on this source.');
  });
});
