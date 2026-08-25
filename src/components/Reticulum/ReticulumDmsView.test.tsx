/**
 * @vitest-environment jsdom
 *
 * ReticulumDmsView (#3960 Phase 2 WP5) — conversations list + message pane +
 * composer. Pins: conversation rendering, selecting a conversation calls
 * back into the hook's `loadConversation`, compose posts and shows an
 * optimistic bubble before the response lands, delivery-state chips render
 * for outgoing messages, and the empty states for "no conversations" /
 * "no conversation selected" / "no messages yet".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => (
      typeof fallback === 'string' ? fallback : key
    ),
  }),
}));

vi.mock('../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));

import { ReticulumDmsView } from './ReticulumDmsView';
import type { ReticulumConversation, ReticulumMessageRow } from '../../types/reticulum';

function makeMessage(overrides: Partial<ReticulumMessageRow> & Pick<ReticulumMessageRow, 'id'>): ReticulumMessageRow {
  return {
    id: overrides.id,
    sourceId: 's1',
    fromHash: 'peerHashA',
    toHash: 'selfHash',
    title: null,
    content: 'hello',
    timestamp: 1000,
    receivedAt: 1000,
    createdAt: 1000,
    state: 'delivered',
    method: 'opportunistic',
    signatureValidated: true,
    ratcheted: false,
    fields: null,
    replyToHash: null,
    threadHash: null,
    rssi: null,
    snr: null,
    quality: null,
    ...overrides,
  };
}

function makeConversation(overrides: Partial<ReticulumConversation> = {}): ReticulumConversation {
  return {
    peerHash: 'peerHashA',
    lastMessage: makeMessage({ id: 's1_last', content: 'hi there' }),
    messageCount: 3,
    ...overrides,
  };
}

const baseProps = {
  sourceId: 's1',
  conversations: [] as ReticulumConversation[],
  conversationsLoading: false,
  activePeerHash: null as string | null,
  messages: [] as ReticulumMessageRow[],
  messagesLoading: false,
  hasMoreMessages: false,
  identity: null as { destinationHash: string | null; displayName: string | null } | null,
  onSelectConversation: vi.fn(),
  onLoadMoreMessages: vi.fn(),
  onSend: vi.fn(),
};

beforeEach(() => {
  baseProps.onSelectConversation = vi.fn();
  baseProps.onLoadMoreMessages = vi.fn();
  baseProps.onSend = vi.fn();
});

describe('ReticulumDmsView', () => {
  it('renders the empty state when there are no conversations', () => {
    render(<ReticulumDmsView {...baseProps} />);
    expect(screen.getByTestId('reticulum-dms-empty')).toHaveTextContent('No conversations yet.');
  });

  it('shows a loading state for conversations while they are being fetched', () => {
    render(<ReticulumDmsView {...baseProps} conversationsLoading />);
    expect(screen.getByTestId('reticulum-dms-empty')).toHaveTextContent('Loading…');
  });

  it('renders conversations with the peer preview and calls onSelectConversation on click', () => {
    const conversations = [
      makeConversation({ peerHash: 'peerHashA', lastMessage: makeMessage({ id: 's1_a', content: 'hi there' }) }),
      makeConversation({ peerHash: 'peerHashB', lastMessage: makeMessage({ id: 's1_b', content: 'yo' }) }),
    ];
    render(<ReticulumDmsView {...baseProps} conversations={conversations} />);

    expect(screen.getByText('hi there')).toBeInTheDocument();
    expect(screen.getByText('yo')).toBeInTheDocument();

    fireEvent.click(screen.getByText('hi there'));
    expect(baseProps.onSelectConversation).toHaveBeenCalledWith('peerHashA');
  });

  it('resolves a peer name from the destinations list when available', () => {
    const conversations = [makeConversation({ peerHash: 'peerHashA' })];
    render(
      <ReticulumDmsView
        {...baseProps}
        conversations={conversations}
        destinations={[{
          sourceId: 's1',
          destinationHash: 'peerHashA',
          identityHash: null,
          appName: 'lxmf',
          aspects: 'delivery',
          displayName: 'Friendly Node',
          appDataB64: null,
          hops: null,
          nextHopInterface: null,
          rssi: null,
          snr: null,
          quality: null,
          announceCount: 1,
          firstSeen: 0,
          lastSeen: 0,
          lastAnnounceAt: null,
          isFavorite: false,
          createdAt: 0,
          updatedAt: 0,
        }]}
      />,
    );
    expect(screen.getByText('Friendly Node')).toBeInTheDocument();
  });

  it('shows the "select a conversation" placeholder when no peer is active', () => {
    render(<ReticulumDmsView {...baseProps} conversations={[makeConversation()]} />);
    expect(screen.getByTestId('reticulum-dms-no-selection')).toHaveTextContent('Select a conversation to view messages.');
  });

  it('shows the "no messages" empty state for an active but empty conversation', () => {
    render(<ReticulumDmsView {...baseProps} activePeerHash="peerHashA" messages={[]} />);
    expect(screen.getByTestId('reticulum-dms-no-messages')).toHaveTextContent('No messages in this conversation yet.');
  });

  it('renders messages and a delivery chip for outgoing (but not incoming) messages', () => {
    const messages = [
      makeMessage({ id: 's1_in', fromHash: 'peerHashA', toHash: 'selfHash', content: 'incoming msg', state: 'delivered' }),
      makeMessage({ id: 's1_out', fromHash: 'selfHash', toHash: 'peerHashA', content: 'outgoing msg', state: 'sent' }),
    ];
    render(<ReticulumDmsView {...baseProps} activePeerHash="peerHashA" messages={messages} />);

    expect(screen.getByText('incoming msg')).toBeInTheDocument();
    expect(screen.getByText('outgoing msg')).toBeInTheDocument();

    const chips = screen.getAllByTestId('reticulum-dms-delivery-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveAttribute('data-state', 'sent');
  });

  it('renders reply/thread badges and a reaction when present', () => {
    const messages = [
      makeMessage({
        id: 's1_reply',
        fromHash: 'peerHashA',
        toHash: 'selfHash',
        content: 'replying',
        replyToHash: 'origHash',
        threadHash: 'threadHash1',
        fields: JSON.stringify({ reaction: '👍' }),
      }),
    ];
    render(<ReticulumDmsView {...baseProps} activePeerHash="peerHashA" messages={messages} />);
    expect(screen.getByText('Reply')).toBeInTheDocument();
    expect(screen.getByText('Thread')).toBeInTheDocument();
    expect(screen.getByText('👍')).toBeInTheDocument();
  });

  it('renders attachment metadata placeholders without exposing raw bytes', () => {
    const messages = [
      makeMessage({
        id: 's1_att',
        fromHash: 'peerHashA',
        toHash: 'selfHash',
        content: 'see attached',
        fields: JSON.stringify({ fileAttachments: [['report.pdf', { bytesLength: 2048 }]] }),
      }),
    ];
    render(<ReticulumDmsView {...baseProps} activePeerHash="peerHashA" messages={messages} />);
    expect(screen.getByText(/report\.pdf/)).toBeInTheDocument();
    expect(screen.getByText(/2\.0 KB/)).toBeInTheDocument();
  });

  it('shows the identity backup note (R5) when the source has a known LXMF identity', () => {
    render(
      <ReticulumDmsView
        {...baseProps}
        activePeerHash="peerHashA"
        identity={{ destinationHash: 'selfHash123', displayName: null }}
      />,
    );
    expect(screen.getByTestId('reticulum-dms-identity-note')).toHaveTextContent(
      "This source's LXMF identity lives on the bridge volume",
    );
  });

  it('does not show the identity note when no identity has been resolved yet', () => {
    render(<ReticulumDmsView {...baseProps} activePeerHash="peerHashA" identity={null} />);
    expect(screen.queryByTestId('reticulum-dms-identity-note')).not.toBeInTheDocument();
  });

  it('shows a "load older" button only when hasMoreMessages, and it calls onLoadMoreMessages', () => {
    const messages = [makeMessage({ id: 's1_x' })];
    const { rerender } = render(<ReticulumDmsView {...baseProps} activePeerHash="peerHashA" messages={messages} hasMoreMessages={false} />);
    expect(screen.queryByText('Load older messages')).not.toBeInTheDocument();

    rerender(<ReticulumDmsView {...baseProps} activePeerHash="peerHashA" messages={messages} hasMoreMessages />);
    fireEvent.click(screen.getByText('Load older messages'));
    expect(baseProps.onLoadMoreMessages).toHaveBeenCalled();
  });

  describe('compose', () => {
    it('posts via onSend and shows an optimistic bubble immediately, before the promise resolves', async () => {
      let resolveSend: (row: ReticulumMessageRow | null) => void = () => {};
      const sendPromise = new Promise<ReticulumMessageRow | null>((resolve) => { resolveSend = resolve; });
      baseProps.onSend = vi.fn().mockReturnValue(sendPromise);

      render(<ReticulumDmsView {...baseProps} activePeerHash="peerHashA" messages={[]} />);

      const input = screen.getByLabelText('Type a message…');
      fireEvent.change(input, { target: { value: 'hello world' } });
      fireEvent.click(screen.getByLabelText('Send'));

      expect(baseProps.onSend).toHaveBeenCalledWith({ to: 'peerHashA', content: 'hello world' });
      // Optimistic bubble shows immediately, before the promise resolves.
      expect(screen.getByTestId('reticulum-dms-pending-message')).toHaveTextContent('hello world');
      expect(screen.getByTestId('reticulum-dms-pending-message').querySelector('[data-state="sending"]')).toBeInTheDocument();

      resolveSend(makeMessage({ id: 's1_new', content: 'hello world' }));
      await waitFor(() => expect(screen.queryByTestId('reticulum-dms-pending-message')).not.toBeInTheDocument());
    });

    it('flips the optimistic bubble to failed when onSend resolves null, without removing it', async () => {
      baseProps.onSend = vi.fn().mockResolvedValue(null);

      render(<ReticulumDmsView {...baseProps} activePeerHash="peerHashA" messages={[]} />);

      fireEvent.change(screen.getByLabelText('Type a message…'), { target: { value: 'will fail' } });
      fireEvent.click(screen.getByLabelText('Send'));

      await waitFor(() => {
        const pending = screen.getByTestId('reticulum-dms-pending-message');
        expect(pending.querySelector('[data-state="failed"]')).toBeInTheDocument();
      });
      expect(screen.getByText('will fail')).toBeInTheDocument();
    });

    it('does not send an empty/whitespace-only draft', () => {
      render(<ReticulumDmsView {...baseProps} activePeerHash="peerHashA" messages={[]} />);
      fireEvent.change(screen.getByLabelText('Type a message…'), { target: { value: '   ' } });
      expect(screen.getByLabelText('Send')).toBeDisabled();
    });

    it('clears leftover pending bubbles when switching conversations', () => {
      let resolveSend: (row: ReticulumMessageRow | null) => void = () => {};
      baseProps.onSend = vi.fn().mockReturnValue(new Promise((resolve) => { resolveSend = resolve; }));

      const { rerender } = render(<ReticulumDmsView {...baseProps} activePeerHash="peerHashA" messages={[]} />);
      fireEvent.change(screen.getByLabelText('Type a message…'), { target: { value: 'stuck' } });
      fireEvent.click(screen.getByLabelText('Send'));
      expect(screen.getByTestId('reticulum-dms-pending-message')).toBeInTheDocument();

      rerender(<ReticulumDmsView {...baseProps} activePeerHash="peerHashB" messages={[]} />);
      expect(screen.queryByTestId('reticulum-dms-pending-message')).not.toBeInTheDocument();
      void resolveSend; // avoid unused-var lint; the promise is intentionally left unresolved
    });
  });
});
