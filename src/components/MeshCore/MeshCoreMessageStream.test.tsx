/**
 * @vitest-environment jsdom
 *
 * Tests for date-separator rendering in the shared MeshCore chat stream
 * (issue #3316). A non-interactive separator must appear before the first
 * message and whenever consecutive messages cross a calendar-day boundary,
 * but not between messages sent on the same day.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

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

  it('still renders the scope row on a received scoped message', () => {
    const { container } = renderWithSelf([
      { id: 'b', fromPublicKey: 'fedcba9876543210', text: 'hi', timestamp: Date.now(), scopeCode: 1234, scopeName: 'berlin' },
    ]);
    const scope = container.querySelector('.mc-message-scope');
    expect(scope).toBeTruthy();
    expect(scope?.textContent).toContain('berlin');
  });
});
