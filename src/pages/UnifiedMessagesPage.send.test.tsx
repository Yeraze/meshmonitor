/**
 * @vitest-environment jsdom
 *
 * The send composer on Unified Messages (#3045 P2).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});

let authenticated = true;
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    authStatus: { authenticated, user: authenticated ? { isAdmin: true } : null },
    hasPermission: () => authenticated,
  }),
}));

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('../services/api', () => ({
  default: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
  },
}));

vi.mock('../components/LinkPreview', () => ({ default: () => null }));
vi.mock('../components/MessageExportDialog/MessageExportDialog', () => ({ default: () => null }));

import UnifiedMessagesPage from './UnifiedMessagesPage';
import { UNIFIED_CHANNEL_STORAGE_KEY } from './unifiedChannelPreference';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <UnifiedMessagesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const channelSelect = () => screen.getByLabelText('unified.messages.channel_aria') as HTMLSelectElement;
const box = () =>
  screen.getAllByRole('combobox').find((e) => e.tagName === 'TEXTAREA') as HTMLTextAreaElement;
const sendersCalls = () => apiGet.mock.calls.filter((c) => c[0] === '/api/unified/senders').length;
const messageCalls = () => apiGet.mock.calls.filter((c) => String(c[0]).startsWith('/api/unified/messages')).length;

const sender = (n: number) => ({
  sourceId: 'a',
  sourceName: 'Alpha',
  channelNumber: n,
  canSend: true,
  sendKind: 'meshtastic',
  sendBlockedReason: null,
});

describe('UnifiedMessagesPage send composer (#3045 P2)', () => {
  beforeEach(() => {
    authenticated = true;
    localStorage.clear();
    apiGet.mockReset();
    apiPost.mockReset();
    apiPost.mockResolvedValue({ success: true });
    apiGet.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/unified/channels')) {
        return [
          { name: '#Public', sources: [{ sourceId: 'a', sourceName: 'a', channelNumber: 0 }] },
          { name: '#test', sources: [{ sourceId: 'a', sourceName: 'a', channelNumber: 1 }] },
        ];
      }
      if (url === '/api/unified/senders') {
        return {
          success: true,
          data: {
            channels: [
              { name: '#Public', sources: [sender(0)] },
              { name: '#test', sources: [sender(1)] },
            ],
          },
        };
      }
      if (url.startsWith('/api/unified/messages')) return [];
      return {};
    });
  });

  it('shows the composer on a single channel', async () => {
    renderPage();
    await waitFor(() => expect(channelSelect().value).toBe('#Public'));
    expect(await screen.findByLabelText('Send from')).toBeTruthy();
  });

  it('hides it on All Channels and never asks for senders', async () => {
    localStorage.setItem(UNIFIED_CHANNEL_STORAGE_KEY, '__all__');
    renderPage();
    await waitFor(() => expect(channelSelect().value).toBe('__all__'));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByLabelText('Send from')).toBeNull();
    expect(sendersCalls()).toBe(0);
  });

  it('hides it for an anonymous viewer', async () => {
    authenticated = false;
    renderPage();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByLabelText('Send from')).toBeNull();
    expect(sendersCalls()).toBe(0);
  });

  it('keeps one draft per channel', async () => {
    renderPage();
    await screen.findByLabelText('Send from');
    fireEvent.change(box(), { target: { value: 'hello public' } });
    fireEvent.change(channelSelect(), { target: { value: '#test' } });
    await waitFor(() => expect(channelSelect().value).toBe('#test'));
    await screen.findByLabelText('Send from');
    expect(box().value).toBe('');
    fireEvent.change(channelSelect(), { target: { value: '#Public' } });
    await screen.findByLabelText('Send from');
    expect(box().value).toBe('hello public');
  });

  it('refreshes the message list after a send', async () => {
    renderPage();
    await screen.findByLabelText('Send from');
    await waitFor(() => expect(messageCalls()).toBeGreaterThan(0));
    const before = messageCalls();
    fireEvent.change(box(), { target: { value: 'hi' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/messages/send', { sourceId: 'a', text: 'hi', channel: 0 }),
    );
    await waitFor(() => expect(messageCalls()).toBeGreaterThan(before));
  });
});
