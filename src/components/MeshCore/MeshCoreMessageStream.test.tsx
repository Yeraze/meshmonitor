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
}));

// The stream now renders <LinkPreview>, which reads the global setting via
// useSettings(); stub it so the component tree doesn't require a provider.
vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({ linkPreviewsEnabled: true }),
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
