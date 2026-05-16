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
