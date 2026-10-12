/**
 * @vitest-environment jsdom
 *
 * Unified Messages protocol border (#5744): the card's left border names the
 * mesh protocol of the message, not the source that heard it. Source tags keep
 * their per-source colours, and the old "MeshCore" pill is gone.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
import protocolStripe from '../components/messages/ProtocolStripe.module.css';

function reception(sourceId: string, sourceType?: string) {
  return {
    sourceId,
    sourceName: `name-${sourceId}`,
    ...(sourceType === undefined ? {} : { sourceType }),
    hopStart: 3,
    hopLimit: 3,
    rxSnr: null,
    rxRssi: null,
    rxTime: null,
    timestamp: 1_700_000_000_000,
  };
}

function message(key: string, receptions: ReturnType<typeof reception>[]) {
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
    receptions,
  };
}

const MESSAGES = [
  message('mt', [reception('a', 'meshtastic_tcp')]),
  message('broker', [reception('b', 'mqtt_broker')]),
  message('bridge', [reception('c', 'mqtt_bridge')]),
  message('mc', [reception('d', 'meshcore')]),
  message('mcmqtt', [reception('e', 'meshcore_mqtt')]),
  message('ret', [reception('f', 'reticulum')]),
  message('untyped', [reception('g')]),
  message('multi', [reception('a', 'meshtastic_tcp'), reception('c', 'mqtt_bridge')]),
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

function cardFor(key: string): HTMLElement {
  return screen.getByText(`text-${key}`).closest('.unified-msg-card') as HTMLElement;
}

describe('UnifiedMessagesPage protocol border (#5744)', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiGet.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/unified/channels')) {
        return [{ name: 'Primary', sources: [{ sourceId: 'a', sourceName: 'name-a', channelNumber: 0 }] }];
      }
      if (url.startsWith('/api/unified/messages')) return MESSAGES;
      return {};
    });
  });

  it.each([
    ['mt', 'meshtastic', 'Meshtastic message'],
    ['broker', 'meshtastic', 'Meshtastic message'],
    ['bridge', 'meshtastic', 'Meshtastic message'],
    ['mc', 'meshcore', 'MeshCore message'],
    ['mcmqtt', 'meshcore', 'MeshCore message'],
    ['ret', 'reticulum', 'Reticulum message'],
    ['untyped', 'meshtastic', 'Meshtastic message'],
    ['multi', 'meshtastic', 'Meshtastic message'],
  ])('card %s carries the %s marker and names it', async (key, protocol, title) => {
    renderPage();
    await waitFor(() => expect(screen.getByText(`text-${key}`)).toBeInTheDocument());
    const card = cardFor(key);
    expect(card).toHaveAttribute('data-protocol', protocol);
    expect(card).toHaveClass(protocolStripe.stripe);
    expect(card).toHaveAttribute('title', title);
  });

  it('sets no inline border colour on the card', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('text-mc')).toBeInTheDocument());
    expect(cardFor('mc').style.borderLeftColor).toBe('');
  });

  it('no longer renders the MeshCore pill', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText('text-mc')).toBeInTheDocument());
    expect(container.querySelector('.unified-msg-card__proto-badge')).toBeNull();
    expect(screen.queryByText('MeshCore')).toBeNull();
  });

  it('keeps one colour per source on the source tags', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('text-multi')).toBeInTheDocument());
    const tags = Array.from(
      cardFor('multi').querySelectorAll<HTMLElement>('.unified-msg-card__source-tag'),
    );
    expect(tags).toHaveLength(2);
    expect(tags[0].style.color).not.toBe('');
    expect(tags[0].style.color).not.toBe(tags[1].style.color);
  });
});
