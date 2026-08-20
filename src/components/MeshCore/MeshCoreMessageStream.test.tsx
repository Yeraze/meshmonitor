/**
 * @vitest-environment jsdom
 *
 * Tests for date-separator rendering in the shared MeshCore chat stream
 * (issue #3316). A non-interactive separator must appear before the first
 * message and whenever consecutive messages cross a calendar-day boundary,
 * but not between messages sent on the same day.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === 'string') return fallback;
      return key;
    },
  }),
  // Required by config/i18n (pulled in transitively via SettingsContext, which
  // the embedded <LinkPreview> imports). Without these the mock is incomplete.
  Trans: ({ children }: { children?: unknown }) => children,
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import type { MeshCoreMessage } from './hooks/useMeshCore';

const DAY_MS = 24 * 60 * 60 * 1000;

function msg(id: string, timestamp: number, text: string): MeshCoreMessage {
  return { id, fromPublicKey: 'abcdef0123456789', text, timestamp };
}

function renderStream(messages: MeshCoreMessage[]) {
  return render(
    <MeshCoreMessageStream messages={messages} onSend={async () => true} />,
  );
}

describe('MeshCoreMessageStream date separators', () => {
  it('renders a single separator for messages all sent on the same day', () => {
    const now = Date.now();
    const { container } = renderStream([
      msg('a', now - 3000, 'first'),
      msg('b', now - 2000, 'second'),
      msg('c', now - 1000, 'third'),
    ]);

    expect(container.querySelectorAll('.mc-date-separator')).toHaveLength(1);
    // Same-day, recent messages collapse under "Today".
    expect(screen.getByText('Today')).toBeTruthy();
  });

  it('inserts a separator at each day boundary', () => {
    const now = Date.now();
    const { container } = renderStream([
      msg('a', now - 2 * DAY_MS, 'two days ago'),
      msg('b', now - 1 * DAY_MS, 'yesterday'),
      msg('c', now, 'today'),
    ]);

    // One separator per distinct day (first message always gets one).
    expect(container.querySelectorAll('.mc-date-separator')).toHaveLength(3);
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByText('Yesterday')).toBeTruthy();
  });

  it('renders no separators when there are no messages', () => {
    const { container } = renderStream([]);
    expect(container.querySelectorAll('.mc-date-separator')).toHaveLength(0);
  });
});

describe('MeshCoreMessageStream scope row (#3814)', () => {
  const SELF = 'abcdef0123456789';

  function renderWithSelf(messages: MeshCoreMessage[]) {
    return render(
      <MeshCoreMessageStream
        messages={messages}
        selfPublicKey={SELF}
        onSend={async () => true}
      />,
    );
  }

  it('renders the scope row on an outgoing message that used a scope', () => {
    const { container } = renderWithSelf([
      { id: 'a', fromPublicKey: SELF, text: 'hi', timestamp: Date.now(), scopeName: 'augsburg' },
    ]);
    const scope = container.querySelector('.mc-message-scope');
    expect(scope).toBeTruthy();
    expect(scope?.textContent).toContain('augsburg');
  });

  it('renders no scope row on an outgoing message with no scope', () => {
    const { container } = renderWithSelf([
      { id: 'a', fromPublicKey: SELF, text: 'hi', timestamp: Date.now(), scopeName: null },
    ]);
    expect(container.querySelector('.mc-message-scope')).toBeNull();
  });

  it('renders no scope row for an unscoped message (scopeCode 0)', () => {
    // Unscoped messages used to show a "🌐 no scope" badge — now they show nothing.
    const { container } = renderWithSelf([
      { id: 'u', fromPublicKey: 'fedcba9876543210', text: 'hi', timestamp: Date.now(), scopeCode: 0, scopeName: null },
    ]);
    expect(container.querySelector('.mc-message-scope')).toBeNull();
  });

  it('still renders the scope row on a received scoped message', () => {
    const { container } = renderWithSelf([
      { id: 'b', fromPublicKey: 'fedcba9876543210', text: 'hi', timestamp: Date.now(), scopeCode: 1234, scopeName: 'berlin' },
    ]);
    const scope = container.querySelector('.mc-message-scope');
    expect(scope).toBeTruthy();
    expect(scope?.textContent).toContain('berlin');
  });
});

describe('MeshCoreMessageStream reply (#3851)', () => {
  const SELF = 'abcdef0123456789';
  const channelMsg = (over: Partial<MeshCoreMessage> = {}): MeshCoreMessage => ({
    id: 'm1', fromPublicKey: 'channel-2', fromName: 'Alice', text: 'hello', timestamp: Date.now(), ...over,
  });

  it('shows a Reply button on a received channel message and prefills the @[Sender]: mention', () => {
    const onReply = vi.fn();
    render(<MeshCoreMessageStream messages={[channelMsg()]} selfPublicKey={SELF} onSend={async () => true} onReply={onReply} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onReply.mock.calls[0][0].id).toBe('m1');
    const input = screen.getByPlaceholderText('Type a message…') as HTMLInputElement;
    expect(input.value).toBe('@[Alice]: ');
  });

  it('hides the Reply button when onReply is omitted (DM view)', () => {
    render(<MeshCoreMessageStream messages={[channelMsg()]} selfPublicKey={SELF} onSend={async () => true} />);
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
  });

  it('hides the Reply button on outgoing messages', () => {
    render(<MeshCoreMessageStream messages={[{ id: 'o', fromPublicKey: SELF, text: 'mine', timestamp: Date.now() }]} selfPublicKey={SELF} onSend={async () => true} onReply={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
  });

  it('leaves the composer empty (no broken mention) when an anonymous channel message has no name', () => {
    const onReply = vi.fn();
    // Channel message with no parsed fromName and no resolvable contact.
    render(<MeshCoreMessageStream messages={[channelMsg({ fromName: undefined })]} selfPublicKey={SELF} onSend={async () => true} onReply={onReply} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    // No name to mention → empty draft, but the reply (scope) still propagates.
    expect((screen.getByPlaceholderText('Type a message…') as HTMLInputElement).value).toBe('');
    expect(onReply).toHaveBeenCalledTimes(1);
  });
});

describe('MeshCoreMessageStream entry scroll (#3810)', () => {
  let scrollIntoViewSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Run rAF callbacks synchronously so the entry scroll commits during render.
    vi.stubGlobal('requestAnimationFrame', (cb: (time: number) => void) => {
      cb(0);
      return 0;
    });
    scrollIntoViewSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewSpy as unknown as typeof Element.prototype.scrollIntoView;
    // jsdom reports scrollHeight 0; force a non-zero value so the bottom-scroll
    // path is observable via scrollTop.
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() { return 500; },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (Element.prototype as Partial<typeof Element.prototype>).scrollIntoView;
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  });

  const threeMessages = () => {
    const now = Date.now();
    return [
      msg('a', now - 3000, 'first'),
      msg('b', now - 2000, 'second'),
      msg('c', now - 1000, 'third'),
    ];
  };

  it('lands at the bottom (newest) on entry', () => {
    const { container } = render(
      <MeshCoreMessageStream
        messages={threeMessages()}
        conversationKey="channel-0"
        onSend={async () => true}
      />,
    );
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    const list = container.querySelector('.meshcore-message-list') as HTMLElement;
    expect(list.scrollTop).toBe(500); // == forced scrollHeight → bottom
  });

  it('runs the entry scroll once the async backlog populates (empty → non-empty)', () => {
    const { container, rerender } = render(
      <MeshCoreMessageStream
        messages={[]}
        conversationKey="channel-0"
        onSend={async () => true}
      />,
    );
    // Empty on first render (conversationKey already flipped) — nothing to scroll.
    let list = container.querySelector('.meshcore-message-list') as HTMLElement;
    expect(list.scrollTop).toBe(0);

    // Backlog arrives for the SAME conversationKey → scroll to the bottom.
    rerender(
      <MeshCoreMessageStream
        messages={threeMessages()}
        conversationKey="channel-0"
        onSend={async () => true}
      />,
    );
    list = container.querySelector('.meshcore-message-list') as HTMLElement;
    expect(list.scrollTop).toBe(500);
  });
});

describe('MeshCoreMessageStream load older (#4460)', () => {
  let scrollHeightValue = 0;

  beforeEach(() => {
    // Run rAF callbacks synchronously so the scroll-restore effect commits
    // during the test instead of on a later animation frame.
    vi.stubGlobal('requestAnimationFrame', (cb: (time: number) => void) => {
      cb(0);
      return 0;
    });
    scrollHeightValue = 300;
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() { return scrollHeightValue; },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() { return 200; },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  });

  const twoMessages = () => [
    msg('b', 2000, 'second'),
    msg('c', 3000, 'third'),
  ];

  it('calls onLoadOlder when scrolled near the top and an older page exists', () => {
    const onLoadOlder = vi.fn();
    const { container } = render(
      <MeshCoreMessageStream
        messages={twoMessages()}
        conversationKey="channel-0"
        onSend={async () => true}
        onLoadOlder={onLoadOlder}
        hasMoreOlder
      />,
    );
    const list = container.querySelector('.meshcore-message-list') as HTMLElement;
    list.scrollTop = 10;
    fireEvent.scroll(list);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('does not call onLoadOlder when there is no older page', () => {
    const onLoadOlder = vi.fn();
    const { container } = render(
      <MeshCoreMessageStream
        messages={twoMessages()}
        conversationKey="channel-0"
        onSend={async () => true}
        onLoadOlder={onLoadOlder}
        hasMoreOlder={false}
      />,
    );
    const list = container.querySelector('.meshcore-message-list') as HTMLElement;
    list.scrollTop = 10;
    fireEvent.scroll(list);
    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it('does not call onLoadOlder while a load is already in flight', () => {
    const onLoadOlder = vi.fn();
    const { container } = render(
      <MeshCoreMessageStream
        messages={twoMessages()}
        conversationKey="channel-0"
        onSend={async () => true}
        onLoadOlder={onLoadOlder}
        hasMoreOlder
        loadingOlder
      />,
    );
    const list = container.querySelector('.meshcore-message-list') as HTMLElement;
    list.scrollTop = 10;
    fireEvent.scroll(list);
    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it('does not call onLoadOlder when not scrolled near the top', () => {
    const onLoadOlder = vi.fn();
    const { container } = render(
      <MeshCoreMessageStream
        messages={twoMessages()}
        conversationKey="channel-0"
        onSend={async () => true}
        onLoadOlder={onLoadOlder}
        hasMoreOlder
      />,
    );
    const list = container.querySelector('.meshcore-message-list') as HTMLElement;
    list.scrollTop = 150;
    fireEvent.scroll(list);
    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it('restores the viewport to the same content once older messages are prepended', () => {
    const onLoadOlder = vi.fn();
    const { container, rerender } = render(
      <MeshCoreMessageStream
        messages={twoMessages()}
        conversationKey="channel-0"
        onSend={async () => true}
        onLoadOlder={onLoadOlder}
        hasMoreOlder
        loadingOlder={false}
      />,
    );
    const list = container.querySelector('.meshcore-message-list') as HTMLElement;
    list.scrollTop = 10;
    fireEvent.scroll(list);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    // Simulate the fetch resolving: the parent prepends an older message
    // (growing scrollHeight by 80px of new content) and flips loadingOlder
    // back to false.
    scrollHeightValue = 380;
    rerender(
      <MeshCoreMessageStream
        messages={[msg('a', 1000, 'first'), ...twoMessages()]}
        conversationKey="channel-0"
        onSend={async () => true}
        onLoadOlder={onLoadOlder}
        hasMoreOlder={false}
        loadingOlder={false}
      />,
    );

    // newScrollTop = scrollHeightAfter(380) - scrollHeightBefore(300) + scrollTopBefore(10)
    expect(list.scrollTop).toBe(90);
  });

  it('discards a pending restore when the conversation changes mid-load', () => {
    const onLoadOlder = vi.fn();
    const { container, rerender } = render(
      <MeshCoreMessageStream
        messages={twoMessages()}
        conversationKey="channel-0"
        onSend={async () => true}
        onLoadOlder={onLoadOlder}
        hasMoreOlder
        loadingOlder={false}
      />,
    );
    const list = container.querySelector('.meshcore-message-list') as HTMLElement;
    list.scrollTop = 10;
    fireEvent.scroll(list);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    // The operator switches channels before that load settles. The parent
    // resets its load-older state on a channel switch, so the request never
    // resolves back into this component — the captured metrics are now stale.
    scrollHeightValue = 380;
    rerender(
      <MeshCoreMessageStream
        messages={[msg('x', 5000, 'other channel'), msg('y', 6000, 'other channel 2')]}
        conversationKey="channel-1"
        onSend={async () => true}
        onLoadOlder={onLoadOlder}
        hasMoreOlder={false}
        loadingOlder={false}
      />,
    );

    // The new conversation must land at the bottom via the entry scroll (380),
    // NOT at 380 - 300 + 10 = 90, which is what channel-0's abandoned snapshot
    // would produce if the restore ref survived the conversation change.
    expect(list.scrollTop).toBe(380);
    expect(list.scrollTop).not.toBe(90);
  });
});

describe('MeshCoreMessageStream focus restore (#3823)', () => {
  it('returns focus to the input after a send resolves', async () => {
    // Controllable send so we can observe the disabled→enabled transition.
    let resolveSend: (ok: boolean) => void = () => {};
    const onSend = vi.fn(() => new Promise<boolean>((r) => { resolveSend = r; }));

    render(<MeshCoreMessageStream messages={[]} onSend={onSend} />);
    const input = screen.getByPlaceholderText('Type a message…') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'hello' } });
    input.focus();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // While sending, the input is disabled (so the browser drops focus).
    expect(input).toBeDisabled();

    // Resolve the send: input re-enables and focus is restored to it (#3823).
    resolveSend(true);
    await waitFor(() => expect(input).not.toBeDisabled());
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('does NOT steal focus when no send was initiated', async () => {
    render(<MeshCoreMessageStream messages={[]} onSend={async () => true} />);
    const input = screen.getByPlaceholderText('Type a message…') as HTMLInputElement;
    // A re-render unrelated to sending must not yank focus into the input.
    fireEvent.change(input, { target: { value: 'x' } });
    document.body.focus();
    await waitFor(() => expect(input).not.toBeDisabled());
    expect(document.activeElement).not.toBe(input);
  });
});

describe('MeshCoreMessageStream route-detail popup', () => {
  it('opens the route modal with repeater names when the hash chain is clicked', () => {
    const message: MeshCoreMessage = {
      ...msg('r1', Date.now(), 'ping'),
      hopCount: 2,
      routePath: 'a3,7f',
    };
    const contacts = [
      { publicKey: 'a3' + 'b'.repeat(62), advType: 2, advName: 'Hilltop' },
      { publicKey: '7f' + 'c'.repeat(62), advType: 3, advName: 'Downtown Room' },
    ];
    const { container } = render(
      <MeshCoreMessageStream messages={[message]} contacts={contacts} onSend={async () => true} />,
    );
    // No modal until the chain is clicked.
    expect(container.querySelector('.mcpm-modal')).toBeNull();
    fireEvent.click(container.querySelector('.mc-route-chain-link')!);
    expect(container.querySelector('.mcpm-modal')).not.toBeNull();
    const resolved = container.querySelector('.mc-route-resolved');
    expect(resolved?.textContent).toContain('Hilltop');
    expect(resolved?.textContent).toContain('Downtown Room');
    // Close via the backdrop.
    fireEvent.click(container.querySelector('.mcpm-modal')!);
    expect(container.querySelector('.mcpm-modal')).toBeNull();
  });

  it('renders no clickable chain for direct messages', () => {
    const message: MeshCoreMessage = { ...msg('r2', Date.now(), 'ping'), hopCount: 0 };
    const { container } = render(
      <MeshCoreMessageStream messages={[message]} onSend={async () => true} />,
    );
    expect(container.querySelector('.mc-route-chain-link')).toBeNull();
  });
});

/**
 * Regression: the mobile two-pane layout mounts the conversation but hides it
 * until the operator drills in from the channel/peer list. Measured on the
 * running app in that state: scrollHeight 0, clientHeight 0, offsetParent null.
 * The entry scroll fired there, `scrollTop = scrollHeight` was `0 = 0` (a silent
 * no-op), and the one shot was spent — so drilling in left the view pinned at
 * the top of a 17,000px backlog with nothing left to re-trigger it.
 */
describe('MeshCoreMessageStream entry scroll on a hidden pane (#4473 follow-up)', () => {
  let resizeCallbacks: Array<() => void>;
  let scrollHeightValue: number;

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: (time: number) => void) => { cb(0); return 0; });
    resizeCallbacks = [];
    scrollHeightValue = 0; // hidden: no layout
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { resizeCallbacks.push(cb); }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() { return scrollHeightValue; },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  });

  const msgs = () => {
    const now = Date.now();
    return [msg('a', now - 2000, 'first'), msg('b', now - 1000, 'second')];
  };

  it('defers the entry scroll while the pane is hidden, then runs it on reveal', () => {
    const { container } = render(
      <MeshCoreMessageStream
        messages={msgs()}
        conversationKey="channel-0"
        onSend={async () => true}
      />,
    );
    const list = container.querySelector('.meshcore-message-list') as HTMLElement;
    // Hidden — the shot must NOT be spent.
    expect(list.scrollTop).toBe(0);

    // Operator drills in: the pane gains layout and the observer fires.
    scrollHeightValue = 900;
    act(() => { resizeCallbacks.forEach(cb => cb()); });

    expect(list.scrollTop).toBe(900);
  });

  it('does not spend the entry scroll on an EMPTY list that has layout', () => {
    // The empty state ("No messages on this channel yet") is itself laid out,
    // so the container has a real height before any message arrives. The
    // observer used to fire there, scroll to the bottom of the placeholder,
    // trivially succeed, and burn the one shot — leaving the view at the top
    // once the backlog landed.
    //
    // Seen on the anonymous read-only view, where the absent compose box shifts
    // render timing enough to expose it (list went 1 child -> 203 in one step,
    // scrollTop stuck at 0 over a 16,000px history).
    const { container, rerender } = render(
      <MeshCoreMessageStream
        messages={[]}
        conversationKey="channel-0"
        onSend={async () => true}
      />,
    );
    const list = container.querySelector('.meshcore-message-list') as HTMLElement;

    // Empty, but laid out — this must NOT consume the shot.
    scrollHeightValue = 741;
    act(() => { resizeCallbacks.forEach(cb => cb()); });
    expect(list.scrollTop).toBe(0);

    // Backlog arrives and the list grows: the shot must still be available.
    scrollHeightValue = 16148;
    rerender(
      <MeshCoreMessageStream
        messages={msgs()}
        conversationKey="channel-0"
        onSend={async () => true}
      />,
    );
    act(() => { resizeCallbacks.forEach(cb => cb()); });

    expect(list.scrollTop).toBe(16148);
  });

  it('does not re-scroll on later resizes once the entry scroll has run', () => {
    const { container } = render(
      <MeshCoreMessageStream
        messages={msgs()}
        conversationKey="channel-0"
        onSend={async () => true}
      />,
    );
    const list = container.querySelector('.meshcore-message-list') as HTMLElement;

    scrollHeightValue = 900;
    act(() => { resizeCallbacks.forEach(cb => cb()); });
    expect(list.scrollTop).toBe(900);

    // User scrolls up to read history; a later resize (keyboard, rotate) must
    // not yank them back to the bottom.
    list.scrollTop = 120;
    scrollHeightValue = 1400;
    act(() => { resizeCallbacks.forEach(cb => cb()); });
    expect(list.scrollTop).toBe(120);
  });
});

/**
 * #4504 — a directly-received message showed nothing but the word "direct".
 * SNR is the only thing left that says anything about the link.
 */
describe('MeshCoreMessageStream direct-message signal (#4504)', () => {
  const now = Date.now();

  it('shows SNR on a directly-received message', () => {
    render(
      <MeshCoreMessageStream
        messages={[{ ...msg('a', now, 'hello'), hopCount: 0, snr: 7.25 }]}
        conversationKey="channel-0"
        onSend={async () => true}
      />,
    );
    expect(screen.getByText(/SNR 7\.3 dB/)).toBeTruthy();
  });

  it('adds RSSI only when the message actually carries it', () => {
    const { container, rerender } = render(
      <MeshCoreMessageStream
        messages={[{ ...msg('a', now, 'hello'), hopCount: 0, snr: 5 }]}
        conversationKey="channel-0"
        onSend={async () => true}
      />,
    );
    // MeshCore's message push carries SNR but no RSSI, so this is the normal case.
    expect(container.textContent).not.toMatch(/RSSI/);

    rerender(
      <MeshCoreMessageStream
        messages={[{ ...msg('a', now, 'hello'), hopCount: 0, snr: 5, rssi: -92 }]}
        conversationKey="channel-0"
        onSend={async () => true}
      />,
    );
    expect(container.textContent).toMatch(/RSSI -92 dBm/);
  });

  it('does NOT show signal on a relayed message — it would misattribute the link', () => {
    // On a multi-hop message these values describe the hop from the LAST
    // repeater, not from the sender whose name sits beside them.
    const { container } = render(
      <MeshCoreMessageStream
        messages={[{ ...msg('a', now, 'hello'), hopCount: 2, routePath: 'a3,7f', snr: 7 }]}
        conversationKey="channel-0"
        onSend={async () => true}
      />,
    );
    expect(container.textContent).not.toMatch(/SNR/);
  });

  it('still renders "direct" when the message carries no SNR at all', () => {
    render(
      <MeshCoreMessageStream
        messages={[{ ...msg('a', now, 'hello'), hopCount: 0 }]}
        conversationKey="channel-0"
        onSend={async () => true}
      />,
    );
    expect(screen.getByText(/direct/)).toBeTruthy();
  });
});

/**
 * #4816 Phase 1 WP3 — the outgoing delivery-status icon became a clickable
 * button that opens the Delivery Details modal. It must not disturb the
 * pre-existing heard-by badge/toggle or the route-detail popup, which are
 * independent, separately-keyed pieces of state on the same message row.
 */
describe('MeshCoreMessageStream delivery details modal (#4816)', () => {
  const SELF_KEY = 'abcdef0123456789';
  const now = Date.now();

  function outgoingMessage(overrides: Partial<MeshCoreMessage> = {}): MeshCoreMessage {
    return {
      ...msg('out-1', now, 'ping'),
      fromPublicKey: SELF_KEY,
      deliveryStatus: 'delivered',
      roundTripMs: 42,
      ...overrides,
    };
  }

  it('renders no dialog until the outgoing delivery-status button is clicked', () => {
    const { container } = render(
      <MeshCoreMessageStream
        messages={[outgoingMessage()]}
        selfPublicKey={SELF_KEY}
        onSend={async () => true}
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(container.querySelector('.mc-delivery-status')!);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('opens the modal as a real button (not the old inert span)', () => {
    const { container } = render(
      <MeshCoreMessageStream
        messages={[outgoingMessage()]}
        selfPublicKey={SELF_KEY}
        onSend={async () => true}
      />,
    );
    const statusEl = container.querySelector('.mc-delivery-status')!;
    expect(statusEl.tagName).toBe('BUTTON');
  });

  it('closes the modal via its close button', () => {
    const { container } = render(
      <MeshCoreMessageStream
        messages={[outgoingMessage()]}
        selfPublicKey={SELF_KEY}
        onSend={async () => true}
      />,
    );
    fireEvent.click(container.querySelector('.mc-delivery-status')!);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not disturb the heard-by toggle', () => {
    const { container } = render(
      <MeshCoreMessageStream
        messages={[outgoingMessage({
          heardBy: [{ hash: 'ab12', name: 'Repeater1', snr: 5 }],
        })]}
        selfPublicKey={SELF_KEY}
        onSend={async () => true}
      />,
    );

    // Heard-by list is collapsed until the badge is toggled.
    expect(container.querySelector('.mc-heard-by-list')).toBeNull();
    fireEvent.click(container.querySelector('.mc-heard-by-badge')!);
    expect(container.querySelector('.mc-heard-by-list')).not.toBeNull();
    expect(screen.getByText('Repeater1')).toBeTruthy();

    // Opening the delivery details modal afterward doesn't collapse it or
    // interfere with its own state.
    fireEvent.click(container.querySelector('.mc-delivery-status')!);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(container.querySelector('.mc-heard-by-list')).not.toBeNull();
  });

  it('does not disturb the route-detail popup', () => {
    // The route-detail chain link only renders on RECEIVED messages (the
    // stream gates it on `!outgoing`), so this needs a separate incoming
    // message alongside the outgoing one whose delivery-status button we're
    // testing — two independent pieces of state on two different rows.
    const incoming: MeshCoreMessage = {
      ...msg('in-1', now - 1000, 'pong'),
      fromPublicKey: 'fedcba9876543210',
      hopCount: 2,
      routePath: 'a3,7f',
    };
    const outgoing = outgoingMessage();
    const { container } = render(
      <MeshCoreMessageStream messages={[incoming, outgoing]} selfPublicKey={SELF_KEY} onSend={async () => true} />,
    );

    // Route-detail modal opens independently of delivery details. Both
    // modals use role="dialog" (see MeshCoreMessageRouteModal), so the
    // Delivery Details modal is disambiguated by its own heading id
    // (`#ddm-title`) rather than by role alone.
    expect(container.querySelector('.mcpm-modal')).toBeNull();
    fireEvent.click(container.querySelector('.mc-route-chain-link')!);
    expect(container.querySelector('.mcpm-modal')).not.toBeNull();
    expect(container.querySelector('#ddm-title')).toBeNull();

    // Close the route-detail modal via the backdrop, then confirm the
    // delivery-status button still opens its own modal independently.
    fireEvent.click(container.querySelector('.mcpm-modal')!);
    expect(container.querySelector('.mcpm-modal')).toBeNull();

    fireEvent.click(container.querySelector('.mc-delivery-status')!);
    expect(container.querySelector('#ddm-title')).not.toBeNull();
    // The route-detail modal must not have reappeared as a side effect.
    expect(container.querySelector('.mcpm-modal')).toBeNull();
  });
});
