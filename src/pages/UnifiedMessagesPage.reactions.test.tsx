/**
 * @vitest-environment jsdom
 *
 * Unified Messages MeshCore reaction chips (#5763): read-only chips on the
 * target card, a dim line for an unmatched reaction, tapbacks unchanged.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    authStatus: { authenticated: true, user: { isAdmin: true } },
    hasPermission: () => true,
  }),
}));

const apiGet = vi.fn();
vi.mock('../services/api', () => ({
  default: { get: (...args: unknown[]) => apiGet(...args) },
}));

vi.mock('../components/LinkPreview', () => ({ default: () => null }));
vi.mock('../components/MessageExportDialog/MessageExportDialog', () => ({ default: () => null }));

import UnifiedMessagesPage from './UnifiedMessagesPage';

const rx = {
  sourceId: 'd',
  sourceName: 'name-d',
  sourceType: 'meshcore',
  hopStart: null,
  hopLimit: null,
  rxSnr: null,
  rxRssi: null,
  rxTime: null,
  timestamp: 1_700_000_000_000,
};

function message(key: string, extra: Record<string, unknown> = {}) {
  return {
    dedupKey: key,
    packetId: null,
    requestId: null,
    fromNodeNum: 1,
    fromNodeId: '!00000001',
    fromNodeLongName: 'Sender',
    toNodeNum: 0xffffffff,
    toNodeId: '^all',
    channel: 0,
    channelName: 'Primary',
    text: `text-${key}`,
    emoji: null,
    replyId: null,
    timestamp: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    receptions: [rx],
    ...extra,
  };
}

const reaction = (key: string, name: string, refs: string[]) =>
  message(key, {
    text: '👍',
    fromNodeId: `pk-${name}`,
    fromNodeLongName: name,
    reactionEmoji: '👍',
    reactionTargetRefs: refs,
  });

const MESSAGES = [
  message('target', { meshcoreRowRefs: ['row1'] }),
  reaction('r-match', 'Ann', ['row1']),
  reaction('r-none', 'Bob', []),
  reaction('r-off', 'Cy', ['gone']),
  message('mtparent', { packetId: 77 }),
  message('tapback', { text: '❤️', emoji: 1, replyId: 77 }),
];

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

describe('UnifiedMessagesPage MeshCore reactions (#5763)', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiGet.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/unified/channels')) {
        return [{ name: 'Primary', sources: [{ sourceId: 'd', sourceName: 'name-d', channelNumber: 0 }] }];
      }
      if (url.startsWith('/api/unified/messages')) return MESSAGES;
      return {};
    });
  });

  it('draws a chip inside the target card and no card for the reaction', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText('text-target')).toBeInTheDocument());
    const card = screen.getByText('text-target').closest('.unified-msg-card') as HTMLElement;
    expect(within(card).getAllByTestId('mc-reaction-chip')).toHaveLength(1);
    expect(container.querySelectorAll('.unified-msg-card').length).toBe(2);
  });

  it('draws a dim line for an unmatched reaction and hides an off-page one', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('text-target')).toBeInTheDocument());
    const lines = screen.getAllByTestId('mc-reaction-unmatched');
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toContain('Bob');
  });

  it('renders no chip as a button', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('text-target')).toBeInTheDocument());
    for (const chip of screen.getAllByTestId('mc-reaction-chip')) {
      expect(chip.tagName).not.toBe('BUTTON');
    }
  });

  it('still renders a Meshtastic tapback in unified-reactions', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText('text-mtparent')).toBeInTheDocument());
    expect(container.querySelector('.unified-reactions .unified-reaction')).not.toBeNull();
  });
});
