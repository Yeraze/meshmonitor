/**
 * @vitest-environment jsdom
 *
 * Tests for MeshCoreChannelsConfigSection (phase 3).
 *   - Renders the list of channels fetched from /api/channels/all.
 *   - "Add channel" appears and seeds the next free index + a generated secret.
 *   - Save sends a PUT to /api/channels/:idx with base64-encoded PSK +
 *     sourceId, and re-fetches afterwards.
 *   - Delete sends a DELETE to /api/channels/:idx?sourceId=… and re-fetches.
 *   - The secret input is hidden by default and toggles on "Show".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

// A single vi.fn mock. The saved-regions catalog fetch (#3770) fires on mount on
// its own effect; we special-case it inside the implementation so it returns an
// empty list WITHOUT consuming a queued once-value meant for the channel CRUD
// calls. Channel calls fall through to a per-test FIFO queue populated by
// `queueResponse(...)` (aliased to `mockResolvedValueOnce` so the existing tests
// read naturally). Assertions on call URLs use `channelCalls`, which excludes
// the saved-regions noise.
let responseQueue: Response[] = [];
let channelCalls: any[][] = [];
const csrfFetchMock = vi.fn((url: string, ...rest: any[]) => {
  if (typeof url === 'string' && url.includes('/saved-regions')) {
    return Promise.resolve(
      new Response(JSON.stringify({ success: true, regions: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }
  channelCalls.push([url, ...rest]);
  const next = responseQueue.shift();
  return Promise.resolve(next ?? new Response('null', { status: 200, headers: { 'content-type': 'application/json' } }));
});
// Shim the queue-driving + reset API the existing tests call on the mock.
(csrfFetchMock as any).mockResolvedValueOnce = (v: Response) => { responseQueue.push(v); return csrfFetchMock; };
(csrfFetchMock as any).mockReset = () => { responseQueue = []; channelCalls = []; csrfFetchMock.mockClear(); return csrfFetchMock; };

vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));

import { MeshCoreChannelsConfigSection } from './MeshCoreChannelsConfigSection';

const button = (name: string | RegExp) => screen.getByRole('button', { name });
const addButton = () => button('Add channel');
const saveButton = () => button('Save to device');
/** Click the confirm button inside the open ConfirmDialog. */
const confirmDialog = (name: string | RegExp) =>
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name }));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  csrfFetchMock.mockReset();
  // Make crypto.getRandomValues deterministic so we can match the seeded secret.
  vi.spyOn(crypto, 'getRandomValues').mockImplementation((arr: any) => {
    if (arr && typeof arr.length === 'number') {
      for (let i = 0; i < arr.length; i++) arr[i] = (i + 1) & 0xff;
    }
    return arr;
  });
});

describe('MeshCoreChannelsConfigSection — list rendering', () => {
  it('renders each channel returned by /api/channels/all', async () => {
    csrfFetchMock.mockResolvedValueOnce(
      jsonResponse([
        { id: 0, name: 'Public', psk: 'AAECAwQFBgcICQoLDA0ODw==' },
        { id: 1, name: 'Town', psk: 'EBESExQVFhcYGRobHB0eHw==' },
        { id: 2, name: '', psk: 'ICEiIyQlJicoKSorLC0uLw==' },
      ]),
    );

    render(
      <MeshCoreChannelsConfigSection baseUrl="" sourceId="src-a" canWrite={true} />,
    );

    await waitFor(() => {
      expect(screen.getByText('# Public')).toBeTruthy();
      expect(screen.getByText('# Town')).toBeTruthy();
      // Unnamed slot falls back to "Channel N".
      expect(screen.getByText('# Channel 2')).toBeTruthy();
    });

    const calledUrl = channelCalls[0][0] as string;
    expect(calledUrl).toContain('/api/channels/all?sourceId=src-a');
  });

  it('shows the empty-state when the API returns no channels', async () => {
    csrfFetchMock.mockResolvedValueOnce(jsonResponse([]));
    render(
      <MeshCoreChannelsConfigSection baseUrl="" sourceId="src-a" canWrite={true} />,
    );
    await waitFor(() =>
      expect(screen.getByText('No channels reported by the device yet.')).toBeTruthy(),
    );
  });

  it('disables Edit/Delete when canWrite=false', async () => {
    csrfFetchMock.mockResolvedValueOnce(
      jsonResponse([{ id: 1, name: 'Town', psk: 'AAECAwQFBgcICQoLDA0ODw==' }]),
    );
    render(
      <MeshCoreChannelsConfigSection baseUrl="" sourceId="src-a" canWrite={false} />,
    );
    await waitFor(() => screen.getByText('# Town'));
    expect((button('Edit') as HTMLButtonElement).disabled).toBe(true);
    expect((button('Delete') as HTMLButtonElement).disabled).toBe(true);
    expect((addButton() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('MeshCoreChannelsConfigSection — add channel', () => {
  it('seeds the editor with the next free idx and a generated secret', async () => {
    csrfFetchMock.mockResolvedValueOnce(
      jsonResponse([
        { id: 0, name: 'Public', psk: 'AAECAwQFBgcICQoLDA0ODw==' },
        // Note: idx 1 is missing → "next free" should be 1.
        { id: 2, name: 'Other', psk: 'EBESExQVFhcYGRobHB0eHw==' },
      ]),
    );

    render(
      <MeshCoreChannelsConfigSection baseUrl="" sourceId="src-a" canWrite={true} />,
    );
    await waitFor(() => screen.getByText('# Public'));

    fireEvent.click(addButton());

    expect(screen.getByText('Adding channel 1')).toBeTruthy();

    // crypto.getRandomValues mock fills bytes with [1,2,...,16].
    // Hex: 0102030405060708090a0b0c0d0e0f10
    const secretInput = screen.getByLabelText('Secret (hex, 32 chars)') as HTMLInputElement;
    expect(secretInput.value).toBe('0102030405060708090a0b0c0d0e0f10');
  });

  // Regression for #4733: slot 0 is the implicit MeshCore "Public" channel.
  // "Add channel" must never propose it, even starting from a completely
  // empty channel list (e.g. before the first device sync has landed).
  it('never proposes slot 0, even with an empty channel list', async () => {
    csrfFetchMock.mockResolvedValueOnce(jsonResponse([]));

    render(
      <MeshCoreChannelsConfigSection baseUrl="" sourceId="src-a" canWrite={true} />,
    );
    await waitFor(() =>
      expect(screen.getByText('No channels reported by the device yet.')).toBeTruthy(),
    );

    fireEvent.click(addButton());

    expect(screen.getByText('Adding channel 1')).toBeTruthy();
    expect(screen.queryByText('Adding channel 0')).toBeNull();
  });

  it('Save sends PUT to /api/channels/<idx> with base64 PSK + sourceId, then re-fetches', async () => {
    csrfFetchMock
      // initial list
      .mockResolvedValueOnce(jsonResponse([
        { id: 0, name: 'Public', psk: 'AAECAwQFBgcICQoLDA0ODw==' },
      ]))
      // PUT response
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      // re-fetch list after save
      .mockResolvedValueOnce(jsonResponse([
        { id: 0, name: 'Public', psk: 'AAECAwQFBgcICQoLDA0ODw==' },
        { id: 1, name: 'NewChan', psk: 'AQIDBAUGBwgJCgsMDQ4PEA==' },
      ]));

    render(
      <MeshCoreChannelsConfigSection baseUrl="" sourceId="src-a" canWrite={true} />,
    );
    await waitFor(() => screen.getByText('# Public'));

    fireEvent.click(addButton());
    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'NewChan' } });

    await act(async () => {
      fireEvent.click(saveButton());
    });

    // Find the PUT call.
    const putCall = channelCalls.find(
      c => typeof c[1]?.method === 'string' && c[1].method === 'PUT',
    );
    expect(putCall).toBeDefined();
    expect(putCall![0]).toBe('/api/channels/1');
    const body = JSON.parse(putCall![1].body);
    expect(body.name).toBe('NewChan');
    expect(body.sourceId).toBe('src-a');
    // PSK is the base64 of the 16-byte deterministic secret.
    expect(body.psk).toBe('AQIDBAUGBwgJCgsMDQ4PEA==');

    // Re-fetch happened (third csrfFetch call is a GET).
    await waitFor(() => screen.getByText('# NewChan'));
  });
});

describe('MeshCoreChannelsConfigSection — hashtag channels', () => {
  it('renders a synced hashtag channel without doubling the # prefix', async () => {
    csrfFetchMock.mockResolvedValueOnce(
      jsonResponse([
        // SHA-256("#general")[0:16] = 4c49f3f24629f5ee4ad5b3965db47985 → base64 below.
        { id: 0, name: '#general', psk: 'TEnz8kYp9e5K1bOWXbR5hQ==' },
      ]),
    );

    render(
      <MeshCoreChannelsConfigSection baseUrl="" sourceId="src-a" canWrite={true} />,
    );

    await waitFor(() => {
      expect(screen.getByText('#general')).toBeTruthy();
      // The decorative-prefixed form must NOT appear.
      expect(screen.queryByText('# #general')).toBeNull();
    });
  });

  it('auto-derives the secret from a #hashtag name and locks the field', async () => {
    csrfFetchMock.mockResolvedValueOnce(jsonResponse([]));

    render(
      <MeshCoreChannelsConfigSection baseUrl="" sourceId="src-a" canWrite={true} />,
    );
    await waitFor(() =>
      expect(screen.getByText('No channels reported by the device yet.')).toBeTruthy(),
    );

    fireEvent.click(addButton());
    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    const secretInput = screen.getByLabelText('Secret (hex, 32 chars)') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(nameInput, { target: { value: '#test' } });
    });

    // SHA-256("#test")[0:16].
    await waitFor(() =>
      expect(secretInput.value).toBe('9cd8fcf22a47333b591d96a2b848b73f'),
    );
    // The derived secret is read-only and Regenerate is disabled.
    expect(secretInput.readOnly).toBe(true);
    expect((button('Generate') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Save sends the # name and the derived PSK to the device', async () => {
    csrfFetchMock
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse([
        { id: 0, name: '#test', psk: 'nNj88ipHMztZHZaiuEi3Pw==' },
      ]));

    render(
      <MeshCoreChannelsConfigSection baseUrl="" sourceId="src-a" canWrite={true} />,
    );
    await waitFor(() =>
      expect(screen.getByText('No channels reported by the device yet.')).toBeTruthy(),
    );

    fireEvent.click(addButton());
    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: '#test' } });
    });
    const secretInput = screen.getByLabelText('Secret (hex, 32 chars)') as HTMLInputElement;
    await waitFor(() =>
      expect(secretInput.value).toBe('9cd8fcf22a47333b591d96a2b848b73f'),
    );

    await act(async () => {
      fireEvent.click(saveButton());
    });

    let putCall: any;
    await waitFor(() => {
      putCall = channelCalls.find(
        c => typeof c[1]?.method === 'string' && c[1].method === 'PUT',
      );
      expect(putCall).toBeDefined();
    });
    const body = JSON.parse(putCall![1].body);
    expect(body.name).toBe('#test');
    // base64 of 9cd8fcf22a47333b591d96a2b848b73f.
    expect(body.psk).toBe('nNj88ipHMztZHZaiuEi3Pw==');
  });

  // Regression for #3607: a user who typed a #hashtag name and clicked Save
  // before the async live-derive useEffect committed could persist the random
  // placeholder secret (different on every attempt, never matching the app).
  // handleSave now re-derives the deterministic key at save time, so the PUT
  // must carry SHA-256("#bot")[0:16] even when we never wait for the field to
  // update first.
  it('re-derives the deterministic hashtag PSK at save time (no race on the live-derive effect)', async () => {
    csrfFetchMock
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse([
        { id: 0, name: '#bot', psk: '61ChvLPk5de/aaV8na2iEQ==' },
      ]));

    render(
      <MeshCoreChannelsConfigSection baseUrl="" sourceId="src-a" canWrite={true} />,
    );
    await waitFor(() =>
      expect(screen.getByText('No channels reported by the device yet.')).toBeTruthy(),
    );

    fireEvent.click(addButton());
    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;

    // Type the hashtag name AND save inside the same act() flush — without a
    // waitFor on the derived secret. The displayed field may still hold the
    // random placeholder, but the saved PSK must be the deterministic key.
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: '#bot' } });
      fireEvent.click(saveButton());
    });

    let putCall: any;
    await waitFor(() => {
      putCall = channelCalls.find(
        c => typeof c[1]?.method === 'string' && c[1].method === 'PUT',
      );
      expect(putCall).toBeDefined();
    });
    const body = JSON.parse(putCall![1].body);
    expect(body.name).toBe('#bot');
    // SHA-256("#bot")[0:16] = eb50a1bcb3e4e5d7bf69a57c9dada211 → base64 below.
    // This is NOT the random getRandomValues placeholder (which would be
    // 0102…0f10 base64 'AQIDBAUGBwgJCgsMDQ4PEA==').
    expect(body.psk).toBe('61ChvLPk5de/aaV8na2iEQ==');
    expect(body.psk).not.toBe('AQIDBAUGBwgJCgsMDQ4PEA==');
  });
});

describe('MeshCoreChannelsConfigSection — delete + secret-visibility', () => {
  it('Delete asks in a dialog, then sends DELETE to /api/channels/<idx>?sourceId=<src> and refetches', async () => {

    csrfFetchMock
      // initial list
      .mockResolvedValueOnce(jsonResponse([
        { id: 0, name: 'Public', psk: 'AAECAwQFBgcICQoLDA0ODw==' },
        { id: 1, name: 'GoneSoon', psk: 'EBESExQVFhcYGRobHB0eHw==' },
      ]))
      // DELETE response
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      // re-fetch
      .mockResolvedValueOnce(jsonResponse([
        { id: 0, name: 'Public', psk: 'AAECAwQFBgcICQoLDA0ODw==' },
      ]));

    render(
      <MeshCoreChannelsConfigSection baseUrl="" sourceId="src-a" canWrite={true} />,
    );
    await waitFor(() => screen.getByText('# GoneSoon'));

    // Find the row with GoneSoon and click its Delete button (the second one).
    // Slot 0 (Public) has no Delete (#5826), so GoneSoon's is the only one.
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
    expect(deleteButtons.length).toBe(1);
    fireEvent.click(deleteButtons[0]);
    // Nothing is sent until the dialog is confirmed.
    expect(channelCalls.find(c => c[1]?.method === 'DELETE')).toBeUndefined();
    expect(screen.getByRole('dialog').textContent).toContain('Delete channel 1?');
    await act(async () => {
      confirmDialog('Delete');
    });

    const deleteCall = channelCalls.find(
      c => typeof c[1]?.method === 'string' && c[1].method === 'DELETE',
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall![0]).toBe('/api/channels/1?sourceId=src-a');

    await waitFor(() => {
      expect(screen.queryByText('# GoneSoon')).toBeNull();
    });
  });

  it('Secret input is type=password by default and switches to text when Show is clicked', async () => {
    csrfFetchMock.mockResolvedValueOnce(
      jsonResponse([{ id: 1, name: 'Town', psk: 'AAECAwQFBgcICQoLDA0ODw==' }]),
    );

    render(
      <MeshCoreChannelsConfigSection baseUrl="" sourceId="src-a" canWrite={true} />,
    );
    await waitFor(() => screen.getByText('# Town'));

    fireEvent.click(button('Edit'));
    const secretInput = screen.getByLabelText('Secret (hex, 32 chars)') as HTMLInputElement;
    expect(secretInput.type).toBe('password');

    fireEvent.click(button('Show'));
    expect(secretInput.type).toBe('text');
    // Hex of the base64 'AAECAwQFBgcICQoLDA0ODw==' is 000102030405060708090a0b0c0d0e0f.
    expect(secretInput.value).toBe('000102030405060708090a0b0c0d0e0f');
  });
});

describe('MeshCoreChannelsConfigSection — slot 0 is the Public channel (#5826)', () => {
  it('offers no Edit or Delete on the stock Public slot, only a note', async () => {
    csrfFetchMock.mockResolvedValueOnce(jsonResponse([
      { id: 0, name: 'Public', psk: null },
      { id: 1, name: 'Town', psk: 'EBESExQVFhcYGRobHB0eHw==' },
    ]));
    render(<MeshCoreChannelsConfigSection baseUrl="" sourceId="src-a" canWrite={true} />);
    await waitFor(() => screen.getByText('# Town'));

    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1);
    expect(screen.queryByText('Reset to Public')).toBeNull();
    expect(screen.getByTestId('mc-public-slot-hint').textContent).toBe('Public channel, fixed by the firmware');
  });

  it('a misconfigured slot 0 offers Reset, which sends the DELETE the server allows', async () => {
    csrfFetchMock
      .mockResolvedValueOnce(jsonResponse([{ id: 0, name: 'Wrong', psk: 'EBESExQVFhcYGRobHB0eHw==' }]))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse([{ id: 0, name: 'Public', psk: null }]));
    render(<MeshCoreChannelsConfigSection baseUrl="" sourceId="src-a" canWrite={true} />);
    await waitFor(() => screen.getByText('# Wrong'));

    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    fireEvent.click(button('Reset to Public'));
    expect(screen.getByRole('dialog').textContent).toMatch(/slot 0/);
    await act(async () => {
      confirmDialog('Reset to Public');
    });
    const deleteCall = channelCalls.find(c => c[1]?.method === 'DELETE');
    expect(deleteCall![0]).toBe('/api/channels/0?sourceId=src-a');
  });
});

describe('MeshCoreChannelsConfigSection — one editing model (#5829)', () => {
  const ROWS = [
    { id: 0, name: 'Public', psk: null },
    { id: 1, name: 'Town', psk: 'AAECAwQFBgcICQoLDA0ODw==', scope: 'muenchen' },
    { id: 2, name: '#general', psk: 'TEnz8kYp9e5K1bOWXbR5hQ==' },
  ];

  it('sends nothing but reads on mount', async () => {
    csrfFetchMock.mockResolvedValueOnce(jsonResponse(ROWS));
    render(<MeshCoreChannelsConfigSection baseUrl="" sourceId="src-a" canWrite={true} />);
    await waitFor(() => screen.getByText('# Town'));
    expect(channelCalls.every(c => !c[1]?.method || c[1].method === 'GET')).toBe(true);
  });

  it('collapsed cards show the slot, the encryption status and the scope', async () => {
    csrfFetchMock.mockResolvedValueOnce(jsonResponse(ROWS));
    render(<MeshCoreChannelsConfigSection baseUrl="" sourceId="src-a" canWrite={true} />);
    await waitFor(() => screen.getByText('# Town'));
    const cards = screen.getAllByTestId('mc-channel-card');
    expect(cards[0].textContent).toContain('Slot 0');
    expect(cards[0].textContent).toContain('Public key');
    expect(cards[1].textContent).toContain('Slot 1');
    expect(cards[1].textContent).toContain('Private key');
    expect(cards[1].textContent).toContain('Scope: muenchen');
    expect(cards[2].textContent).toContain('Hashtag key (public)');
  });

  it('Save to device stays off until the draft changes, then sends one PUT', async () => {
    csrfFetchMock
      .mockResolvedValueOnce(jsonResponse(ROWS))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse(ROWS));
    render(<MeshCoreChannelsConfigSection baseUrl="" sourceId="src-a" canWrite={true} />);
    await waitFor(() => screen.getByText('# Town'));

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'City' } });
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      fireEvent.click(saveButton());
    });
    const puts = channelCalls.filter(c => c[1]?.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0][0]).toBe('/api/channels/1');
    expect(JSON.parse(puts[0][1].body)).toEqual({
      name: 'City',
      psk: 'AAECAwQFBgcICQoLDA0ODw==',
      scope: 'muenchen',
      sourceId: 'src-a',
    });
  });

  it('Cancel drops the draft and writes nothing', async () => {
    csrfFetchMock.mockResolvedValueOnce(jsonResponse(ROWS));
    render(<MeshCoreChannelsConfigSection baseUrl="" sourceId="src-a" canWrite={true} />);
    await waitFor(() => screen.getByText('# Town'));

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Changed' } });
    fireEvent.click(button('Cancel'));
    expect(screen.queryByLabelText('Name')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Town');
    expect(channelCalls.some(c => c[1]?.method === 'PUT')).toBe(false);
  });

  it('asks before opening another card over unsaved edits', async () => {
    csrfFetchMock.mockResolvedValueOnce(jsonResponse(ROWS));
    render(<MeshCoreChannelsConfigSection baseUrl="" sourceId="src-a" canWrite={true} />);
    await waitFor(() => screen.getByText('# Town'));

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Changed' } });
    // The only collapsed card left with Edit is #general.
    fireEvent.click(button('Edit'));
    expect(screen.getByRole('dialog').textContent).toContain('Discard unsaved changes?');

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Keep editing' }));
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Changed');

    fireEvent.click(button('Edit'));
    confirmDialog('Discard changes');
    await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('#general'));
  });

  it('opening a card with no edits switches without asking', async () => {
    csrfFetchMock.mockResolvedValueOnce(jsonResponse(ROWS));
    render(<MeshCoreChannelsConfigSection baseUrl="" sourceId="src-a" canWrite={true} />);
    await waitFor(() => screen.getByText('# Town'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    fireEvent.click(button('Edit'));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('#general'));
  });
});
