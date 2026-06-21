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
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>, vars?: Record<string, unknown>) => {
      if (typeof fallback === 'string') {
        if (vars && typeof vars === 'object') {
          return fallback.replace(/\{\{(\w+)\}\}/g, (_m, k) => String((vars as any)[k] ?? ''));
        }
        return fallback;
      }
      return key;
    },
  }),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

const csrfFetchMock = vi.fn();
vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));

import { MeshCoreChannelsConfigSection } from './MeshCoreChannelsConfigSection';

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

    const calledUrl = csrfFetchMock.mock.calls[0][0] as string;
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
      jsonResponse([{ id: 0, name: 'Public', psk: 'AAECAwQFBgcICQoLDA0ODw==' }]),
    );
    render(
      <MeshCoreChannelsConfigSection baseUrl="" sourceId="src-a" canWrite={false} />,
    );
    await waitFor(() => screen.getByText('# Public'));
    expect((screen.getByText('Edit') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Delete') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('+ Add channel') as HTMLButtonElement).disabled).toBe(true);
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

    fireEvent.click(screen.getByText('+ Add channel'));

    expect(screen.getByText('Adding channel 1')).toBeTruthy();

    // crypto.getRandomValues mock fills bytes with [1,2,...,16].
    // Hex: 0102030405060708090a0b0c0d0e0f10
    const secretInput = screen.getByLabelText('Secret (hex, 32 chars)') as HTMLInputElement;
    expect(secretInput.value).toBe('0102030405060708090a0b0c0d0e0f10');
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

    fireEvent.click(screen.getByText('+ Add channel'));
    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'NewChan' } });

    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    // Find the PUT call.
    const putCall = csrfFetchMock.mock.calls.find(
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

    fireEvent.click(screen.getByText('+ Add channel'));
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
    expect((screen.getByText('Regenerate') as HTMLButtonElement).disabled).toBe(true);
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

    fireEvent.click(screen.getByText('+ Add channel'));
    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: '#test' } });
    });
    const secretInput = screen.getByLabelText('Secret (hex, 32 chars)') as HTMLInputElement;
    await waitFor(() =>
      expect(secretInput.value).toBe('9cd8fcf22a47333b591d96a2b848b73f'),
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    let putCall: any;
    await waitFor(() => {
      putCall = csrfFetchMock.mock.calls.find(
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

    fireEvent.click(screen.getByText('+ Add channel'));
    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;

    // Type the hashtag name AND save inside the same act() flush — without a
    // waitFor on the derived secret. The displayed field may still hold the
    // random placeholder, but the saved PSK must be the deterministic key.
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: '#bot' } });
      fireEvent.click(screen.getByText('Save'));
    });

    let putCall: any;
    await waitFor(() => {
      putCall = csrfFetchMock.mock.calls.find(
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
  it('Delete sends DELETE to /api/channels/<idx>?sourceId=<src> and refetches', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

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
    const deleteButtons = screen.getAllByText('Delete') as HTMLButtonElement[];
    expect(deleteButtons.length).toBe(2);
    await act(async () => {
      fireEvent.click(deleteButtons[1]);
    });

    const deleteCall = csrfFetchMock.mock.calls.find(
      c => typeof c[1]?.method === 'string' && c[1].method === 'DELETE',
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall![0]).toBe('/api/channels/1?sourceId=src-a');

    await waitFor(() => {
      expect(screen.queryByText('# GoneSoon')).toBeNull();
    });

    confirmSpy.mockRestore();
  });

  it('Secret input is type=password by default and switches to text when Show is clicked', async () => {
    csrfFetchMock.mockResolvedValueOnce(
      jsonResponse([{ id: 0, name: 'Public', psk: 'AAECAwQFBgcICQoLDA0ODw==' }]),
    );

    render(
      <MeshCoreChannelsConfigSection baseUrl="" sourceId="src-a" canWrite={true} />,
    );
    await waitFor(() => screen.getByText('# Public'));

    fireEvent.click(screen.getByText('Edit'));
    const secretInput = screen.getByLabelText('Secret (hex, 32 chars)') as HTMLInputElement;
    expect(secretInput.type).toBe('password');

    fireEvent.click(screen.getByText('Show'));
    expect(secretInput.type).toBe('text');
    // Hex of the base64 'AAECAwQFBgcICQoLDA0ODw==' is 000102030405060708090a0b0c0d0e0f.
    expect(secretInput.value).toBe('000102030405060708090a0b0c0d0e0f');
  });
});
