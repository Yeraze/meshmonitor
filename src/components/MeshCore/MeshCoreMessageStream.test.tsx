/**
 * @vitest-environment jsdom
 *
 * Tests for date-separator rendering in the shared MeshCore chat stream
 * (issue #3316). A non-interactive separator must appear before the first
 * message and whenever consecutive messages cross a calendar-day boundary,
 * but not between messages sent on the same day.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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
