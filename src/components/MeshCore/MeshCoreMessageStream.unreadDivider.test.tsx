/**
 * @vitest-environment jsdom
 *
 * Unread divider + jump-to-first-unread entry scroll in the MeshCore stream
 * (issue #4607).
 *
 * The behaviours pinned here are the ones the feature lives or dies on:
 *  - the line lands ABOVE the first message newer than the pinned watermark,
 *  - it never lands above one of our own sends,
 *  - the entry scroll targets it instead of the bottom,
 *  - and it survives the conversation being marked read (the caller pins the
 *    watermark, so a later re-render with the same prop keeps the line).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      (typeof fallback === 'string' ? fallback : key),
  }),
  Trans: ({ children }: { children?: unknown }) => children,
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import type { MeshCoreMessage } from './hooks/useMeshCore';

const SELF = 'ffffffffffffffff';

function msg(id: string, timestamp: number, from = 'abcdef0123456789'): MeshCoreMessage {
  return { id, fromPublicKey: from, text: `text-${id}`, timestamp };
}

function renderStream(props: Partial<React.ComponentProps<typeof MeshCoreMessageStream>> = {}) {
  return render(
    <MeshCoreMessageStream
      messages={[]}
      onSend={async () => true}
      conversationKey="channel-0"
      {...props}
    />,
  );
}

/** Ids of message rows, in DOM order, with the divider marked. */
function domOrder(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-message-id], [data-unread-divider]'))
    .map(el => el.getAttribute('data-message-id') ?? 'DIVIDER');
}

describe('MeshCoreMessageStream unread divider (#4607)', () => {
  it('renders no divider without a watermark', () => {
    const { container } = renderStream({
      messages: [msg('a', 1000), msg('b', 2000)],
    });
    expect(container.querySelector('[data-unread-divider]')).toBeNull();
  });

  it('renders no divider when every message predates the watermark', () => {
    const { container } = renderStream({
      messages: [msg('a', 1000), msg('b', 2000)],
      unreadAnchorMs: 5000,
    });
    expect(container.querySelector('[data-unread-divider]')).toBeNull();
  });

  it('places the divider immediately above the first message newer than the watermark', () => {
    const { container } = renderStream({
      messages: [msg('a', 1000), msg('b', 2000), msg('c', 3000)],
      unreadAnchorMs: 2000,
      // Older history exists, so the "line above the very first row" guard
      // does not apply here.
      hasMoreOlder: true,
    });
    expect(domOrder(container)).toEqual(['a', 'b', 'DIVIDER', 'c']);
  });

  it('never anchors on our own outgoing message', () => {
    // Replying and returning must not draw the line above what we just typed.
    const { container } = renderStream({
      messages: [msg('a', 1000), msg('mine', 2500, SELF), msg('c', 3000)],
      selfPublicKey: SELF,
      unreadAnchorMs: 2000,
      hasMoreOlder: true,
    });
    expect(domOrder(container)).toEqual(['a', 'mine', 'DIVIDER', 'c']);
  });

  it('suppresses a line above the very first message of a fully-loaded thread', () => {
    // "Everything below is new" in a thread never opened is not information.
    const { container } = renderStream({
      messages: [msg('a', 1000), msg('b', 2000)],
      unreadAnchorMs: 0,
      hasMoreOlder: false,
    });
    expect(container.querySelector('[data-unread-divider]')).toBeNull();
  });

  it('keeps the line at the top when older history has not been paged in', () => {
    const { container } = renderStream({
      messages: [msg('a', 1000), msg('b', 2000)],
      unreadAnchorMs: 0,
      hasMoreOlder: true,
    });
    expect(domOrder(container)).toEqual(['DIVIDER', 'a', 'b']);
  });

  it('keeps the divider across re-renders once the caller has pinned the watermark', () => {
    // The views mark a conversation read on entry. Because the watermark is a
    // pinned PROP rather than a live lookup, that must not erase the line.
    const { container, rerender } = renderStream({
      messages: [msg('a', 1000), msg('b', 2000), msg('c', 3000)],
      unreadAnchorMs: 2000,
      hasMoreOlder: true,
    });
    expect(container.querySelector('[data-unread-divider]')).not.toBeNull();

    rerender(
      <MeshCoreMessageStream
        messages={[msg('a', 1000), msg('b', 2000), msg('c', 3000), msg('d', 4000)]}
        onSend={async () => true}
        conversationKey="channel-0"
        unreadAnchorMs={2000}
        hasMoreOlder
      />,
    );
    expect(domOrder(container)).toEqual(['a', 'b', 'DIVIDER', 'c', 'd']);
  });
});

describe('MeshCoreMessageStream entry scroll (#4607)', () => {
  let scrollSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollSpy = vi.fn();
    // jsdom implements neither.
    Element.prototype.scrollIntoView = scrollSpy as unknown as typeof Element.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() { return 1000; },
    });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  it('scrolls to the divider instead of the bottom when there is one', () => {
    const { container } = renderStream({
      messages: [msg('a', 1000), msg('b', 2000), msg('c', 3000)],
      unreadAnchorMs: 2000,
      hasMoreOlder: true,
    });

    expect(scrollSpy).toHaveBeenCalled();
    // The container is left where scrollIntoView put it, NOT slammed to the end.
    const list = container.querySelector('.meshcore-message-list') as HTMLElement;
    expect(list.scrollTop).not.toBe(1000);
  });

  it('falls back to the bottom when there is no divider', () => {
    const { container } = renderStream({
      messages: [msg('a', 1000), msg('b', 2000)],
    });

    const list = container.querySelector('.meshcore-message-list') as HTMLElement;
    expect(list.scrollTop).toBe(1000);
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('re-arms the entry scroll when the conversation changes', () => {
    const { container, rerender } = renderStream({
      messages: [msg('a', 1000)],
      conversationKey: 'channel-0',
    });
    const list = container.querySelector('.meshcore-message-list') as HTMLElement;
    act(() => { list.scrollTop = 0; });

    rerender(
      <MeshCoreMessageStream
        messages={[msg('x', 5000)]}
        onSend={async () => true}
        conversationKey="channel-1"
      />,
    );
    expect(list.scrollTop).toBe(1000);
  });
});
