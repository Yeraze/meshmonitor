/**
 * @vitest-environment jsdom
 *
 * Reply and tapback actions, and the delivery icon, on Unified Messages rows (#3045 P3).
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
    hasPermission: () => true,
  }),
}));

let publicActive = false;
vi.mock('../hooks/usePublicInstanceView', () => ({
  usePublicInstanceView: () => ({ active: publicActive }),
}));

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('../services/api', () => ({
  default: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
  },
}));

vi.mock('../contexts/SettingsContext', () => ({ useSettingsOptional: () => undefined }));
vi.mock('../components/LinkPreview', () => ({ default: () => null }));
vi.mock('../components/MessageExportDialog/MessageExportDialog', () => ({ default: () => null }));

import UnifiedMessagesPage from './UnifiedMessagesPage';
import { UNIFIED_CHANNEL_STORAGE_KEY } from './unifiedChannelPreference';

const sender = {
  sourceId: 'a',
  sourceName: 'Alpha',
  channelNumber: 0,
  canSend: true,
  sendKind: 'meshtastic',
  sendBlockedReason: null,
  reactionsOutbound: null,
};

const reception = (sourceType: string) => ({
  sourceId: 'a',
  sourceName: 'Alpha',
  sourceType,
  hopStart: null,
  hopLimit: null,
  rxSnr: null,
  rxRssi: null,
  rxTime: null,
  timestamp: Date.now(),
});

const msg = (over: Record<string, unknown>) => ({
  dedupKey: 'k',
  packetId: 11,
  requestId: null,
  fromNodeNum: 1,
  fromNodeId: '!1',
  fromNodeLongName: 'Bob',
  toNodeNum: 0,
  toNodeId: '!ffffffff',
  channel: 0,
  channelName: '#Public',
  text: 'hello',
  emoji: null,
  replyId: null,
  timestamp: Date.now(),
  createdAt: Date.now(),
  receptions: [reception('meshtastic_tcp')],
  ...over,
});

let feed: unknown[] = [];

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

describe('UnifiedMessagesPage reply actions (#3045 P3)', () => {
  beforeEach(() => {
    authenticated = true;
    publicActive = false;
    localStorage.clear();
    apiGet.mockReset();
    apiPost.mockReset();
    feed = [msg({})];
    apiGet.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/unified/channels')) {
        return [{ name: '#Public', sources: [{ sourceId: 'a', sourceName: 'Alpha', channelNumber: 0 }] }];
      }
      if (url === '/api/unified/senders') {
        return { success: true, data: { channels: [{ name: '#Public', sources: [sender] }] } };
      }
      if (url.startsWith('/api/unified/messages')) return feed;
      return {};
    });
  });

  it('offers reply and react on a Meshtastic row', async () => {
    renderPage();
    expect(await screen.findByLabelText('Reply')).toBeTruthy();
    expect(screen.getByLabelText('React')).toBeTruthy();
  });

  it('offers none on All Channels', async () => {
    localStorage.setItem(UNIFIED_CHANNEL_STORAGE_KEY, '__all__');
    renderPage();
    await screen.findByText('hello');
    expect(screen.queryByLabelText('Reply')).toBeNull();
    expect(screen.queryByLabelText('React')).toBeNull();
  });

  it('offers none when signed out', async () => {
    authenticated = false;
    renderPage();
    await screen.findByText('hello');
    expect(screen.queryByLabelText('Reply')).toBeNull();
  });

  it('offers none in public view', async () => {
    publicActive = true;
    renderPage();
    await screen.findByText('hello');
    expect(screen.queryByLabelText('Reply')).toBeNull();
  });

  it('offers none on a row with no packet id', async () => {
    feed = [msg({ packetId: null })];
    renderPage();
    await screen.findByText('hello');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByLabelText('Reply')).toBeNull();
    expect(screen.queryByLabelText('React')).toBeNull();
  });

  it('offers none on a MeshCore reaction row', async () => {
    feed = [
      msg({
        dedupKey: 'r',
        packetId: null,
        reactionEmoji: '👍',
        reactionTargetRefs: [],
        receptions: [reception('meshcore')],
      }),
    ];
    renderPage();
    await waitFor(() => expect(apiGet.mock.calls.some((c) => c[0] === '/api/unified/senders')).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByLabelText('Reply')).toBeNull();
    expect(screen.queryByLabelText('React')).toBeNull();
  });

  it('offers none on a Reticulum row', async () => {
    feed = [msg({ receptions: [reception('reticulum')] })];
    renderPage();
    await screen.findByText('hello');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByLabelText('Reply')).toBeNull();
    expect(screen.queryByLabelText('React')).toBeNull();
  });

  it('offers a MeshCore tapback only with reactions on and a copy of the message', async () => {
    const mc = { ...sender, sendKind: 'meshcore', reactionsOutbound: false };
    apiGet.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/unified/channels')) {
        return [{ name: '#Public', sources: [{ sourceId: 'a', sourceName: 'Alpha', channelNumber: 0 }] }];
      }
      if (url === '/api/unified/senders') {
        return { success: true, data: { channels: [{ name: '#Public', sources: [mc] }] } };
      }
      if (url.startsWith('/api/unified/messages')) {
        return [msg({ packetId: null, receptions: [reception('meshcore')], meshcoreRowRefs: ['mc:a:7'] })];
      }
      return {};
    });
    renderPage();
    expect(await screen.findByLabelText('Reply')).toBeTruthy();
    expect(screen.queryByLabelText('React')).toBeNull();
  });

  it('clicking reply sets the composer banner and does not open the reception modal', async () => {
    renderPage();
    fireEvent.click(await screen.findByLabelText('Reply'));
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.getByText(/Replying to/)).toBeTruthy();
    expect(screen.queryByText('unified.messages.modal.title')).toBeNull();
  });

  it('shows a status icon on a row with delivery fields only', async () => {
    feed = [
      msg({ dedupKey: 'mine', text: 'mine', packetId: 1, deliveryState: 'pending' }),
      msg({ dedupKey: 'theirs', text: 'theirs', packetId: 2 }),
    ];
    renderPage();
    await screen.findByText('theirs');
    expect(screen.getAllByTitle('message_status.pending')).toHaveLength(1);
  });
});
