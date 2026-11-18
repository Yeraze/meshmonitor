/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('../../services/api', () => ({
  default: {
    get: (...a: unknown[]) => apiGet(...a),
    post: (...a: unknown[]) => apiPost(...a),
  },
}));

import UnifiedSendComposer from './UnifiedSendComposer';
import { createComposeDraftStore } from '../../contexts/composeDraftStore';
import { UNIFIED_SENDER_STORAGE_KEY } from '../../pages/unifiedSenderPreference';

type Ref = Record<string, unknown>;
const ref = (over: Ref): Ref => ({
  sourceId: 'a',
  sourceName: 'Alpha',
  channelNumber: 2,
  canSend: true,
  sendKind: 'meshtastic',
  sendBlockedReason: null,
  ...over,
});

let sources: Ref[] = [];
function sendersCalls() {
  return apiGet.mock.calls.filter((c) => c[0] === '/api/unified/senders').length;
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store = createComposeDraftStore();
  const onSent = vi.fn();
  const utils = render(
    <QueryClientProvider client={client}>
      <UnifiedSendComposer channelName="#Public" draftStore={store} onSent={onSent} />
    </QueryClientProvider>,
  );
  return { ...utils, store, onSent, client };
}

const picker = () => screen.findByLabelText('Send from') as Promise<HTMLSelectElement>;
const box = () => screen.getAllByRole('combobox').find((e) => e.tagName === 'TEXTAREA') as HTMLTextAreaElement;
const sendBtn = () => screen.getByLabelText('Send message');

function type(text: string) {
  fireEvent.change(box(), { target: { value: text } });
}

describe('UnifiedSendComposer', () => {
  beforeEach(() => {
    localStorage.clear();
    apiGet.mockReset();
    apiPost.mockReset();
    sources = [ref({})];
    apiGet.mockImplementation(async (url: string) => {
      if (url === '/api/unified/senders') return { success: true, data: { channels: [{ name: '#Public', sources }] } };
      if (url.includes('/meshcore/status')) return { data: { localNode: { name: 'Node' } } };
      return {};
    });
    apiPost.mockResolvedValue({ success: true });
  });

  it('lists eligible nodes enabled, live-blocked disabled with reason, hides forbidden', async () => {
    sources = [
      ref({}),
      ref({ sourceId: 'b', sourceName: 'Bravo', sendKind: 'mqtt_native', canSend: false, sendBlockedReason: 'TX_DISABLED' }),
      ref({ sourceId: 'c', sourceName: 'Charlie', canSend: false, sendKind: null, sendBlockedReason: 'FORBIDDEN' }),
    ];
    setup();
    const sel = await picker();
    const opts = Array.from(sel.options);
    expect(opts.map((o) => o.textContent)).toEqual(['Alpha · Meshtastic', 'Bravo — transmit is off']);
    expect(opts[0].disabled).toBe(false);
    expect(opts[1].disabled).toBe(true);
  });

  it('selects the stored node, or the first eligible when the stored one is gone', async () => {
    sources = [ref({}), ref({ sourceId: 'b', sourceName: 'Bravo', channelNumber: 5 })];
    localStorage.setItem(UNIFIED_SENDER_STORAGE_KEY, JSON.stringify({ '#Public': 'b' }));
    const first = setup();
    expect((await picker()).value).toBe('b');
    first.unmount();

    localStorage.setItem(UNIFIED_SENDER_STORAGE_KEY, JSON.stringify({ '#Public': 'zzz' }));
    setup();
    expect((await picker()).value).toBe('a');
  });

  it('writes storage on a manual pick', async () => {
    sources = [ref({}), ref({ sourceId: 'b', sourceName: 'Bravo' })];
    setup();
    fireEvent.change(await picker(), { target: { value: 'b' } });
    expect(JSON.parse(localStorage.getItem(UNIFIED_SENDER_STORAGE_KEY)!)).toEqual({ '#Public': 'b' });
  });

  it.each([
    ['meshtastic', ref({ sourceId: 'a', channelNumber: 2 }), '/api/messages/send', { sourceId: 'a', text: 'hi', channel: 2 }],
    [
      'mqtt_native',
      ref({ sourceId: 'b', sendKind: 'mqtt_native', channelNumber: 10003 }),
      '/api/sources/b/mqtt/native/send',
      { text: 'hi', channel: 10003 },
    ],
    [
      'meshcore',
      ref({ sourceId: 'c', sendKind: 'meshcore', channelNumber: 1 }),
      '/api/sources/c/meshcore/messages/send',
      { text: 'hi', channelIdx: 1 },
    ],
  ])('posts the right route and body for %s, clears the draft on success', async (_k, r, endpoint, body) => {
    sources = [r];
    const { store, onSent } = setup();
    await picker();
    type('hi');
    fireEvent.click(sendBtn());
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith(endpoint, body));
    await waitFor(() => expect(store.get()).toBe(''));
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it('keeps the draft on 429, shows the wait, and never retries', async () => {
    apiPost.mockRejectedValue({ status: 429, code: 'RATE_LIMITED', retryAfterSeconds: 12, message: 'x' });
    const { store, onSent } = setup();
    await picker();
    type('hi');
    fireEvent.click(sendBtn());
    expect(await screen.findByText('Sending too fast. Try again in 12s.')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 100));
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(store.get()).toBe('hi');
    expect(onSent).not.toHaveBeenCalled();
    // 429 does not refetch senders
    expect(sendersCalls()).toBe(1);
  });

  it.each([
    [{ status: 409, code: 'TX_DISABLED' }, 'Transmit is disabled on Alpha. Nothing was sent.'],
    [{ status: 503, code: 'SOURCE_NOT_CONNECTED' }, 'Alpha is not connected. Nothing was sent.'],
    [{ status: 403, code: 'FORBIDDEN' }, 'You do not have permission to send on this channel from Alpha.'],
    [{ status: 500, message: 'boom' }, 'Message not sent: boom'],
  ])('shows %j and refetches senders once without retrying', async (err, text) => {
    apiPost.mockRejectedValue(err);
    const { store } = setup();
    await picker();
    type('hi');
    fireEvent.click(sendBtn());
    expect(await screen.findByText(text)).toBeTruthy();
    await waitFor(() => expect(sendersCalls()).toBe(2));
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(store.get()).toBe('hi');
  });

  it('sends once on two quick clicks', async () => {
    let resolve!: (v: unknown) => void;
    apiPost.mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    await picker();
    type('hi');
    fireEvent.click(sendBtn());
    fireEvent.click(sendBtn());
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    fireEvent.click(sendBtn());
    await new Promise((r) => setTimeout(r, 50));
    expect(apiPost).toHaveBeenCalledTimes(1);
    resolve({ success: true });
  });

  it('shows a disabled composer when every node is live-blocked', async () => {
    sources = [ref({ canSend: false, sendBlockedReason: 'SOURCE_NOT_CONNECTED' })];
    setup();
    const sel = await picker();
    expect(Array.from(sel.options).map((o) => o.textContent)).toContain('Alpha — not connected');
    expect(box().disabled).toBe(true);
  });

  it('lists a source once when it holds two slots of the same name', async () => {
    sources = [ref({ channelNumber: 2 }), ref({ channelNumber: 5 })];
    setup();
    const select = await picker();
    expect(Array.from(select.options).filter((o) => o.value === 'a')).toHaveLength(1);
  });

  it('labels the empty picker when no node can send', async () => {
    sources = [ref({ canSend: false, sendBlockedReason: 'SOURCE_NOT_CONNECTED' })];
    setup();
    const select = await picker();
    expect(select.options[select.selectedIndex].textContent).toBe('No sender available');
  });

  it('renders nothing when no ref has a live state', async () => {
    sources = [ref({ canSend: false, sendKind: null, sendBlockedReason: 'FORBIDDEN' })];
    const { container } = setup();
    await waitFor(() => expect(sendersCalls()).toBe(1));
    expect(container.textContent).toBe('');
  });
});
