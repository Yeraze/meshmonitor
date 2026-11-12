/**
 * @vitest-environment jsdom
 *
 * Relative-time tooltip (#6214): the `.mc-message-time` span on a MeshCore
 * message row carries a `title` with the relative + absolute time, via the
 * shared `formatRelativeTime`.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

// The user's time/date format (#4173 review L23); undefined = no provider.
let mockSettings: { timeFormat: '12' | '24'; dateFormat: string } | undefined;
vi.mock('../../contexts/SettingsContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/SettingsContext')>()),
  useSettingsOptional: () => mockSettings,
}));

import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import type { MeshCoreMessage } from './hooks/useMeshCore';

const SELF = 'aa'.repeat(32);
const now = Date.now();
const MESSAGES: MeshCoreMessage[] = [
  { id: 'in', fromPublicKey: 'channel-0', fromName: 'Someone', text: 'heard', timestamp: now - 5 * 60 * 1000 },
];

describe('MeshCoreMessageStream relative-time tooltip (#6214)', () => {
  it('gives the message-time span a relative-time title', () => {
    const { container } = render(
      <MeshCoreMessageStream messages={MESSAGES} selfPublicKey={SELF} onSend={async () => true} />,
    );
    const span = container.querySelector('.mc-message-time');
    expect(span).not.toBeNull();
    const title = span!.getAttribute('title') ?? '';
    expect(title).toMatch(/ago/);
    expect(title).toContain('(');
  });

  it('honours the 12-hour time setting (#4173 review L23)', () => {
    mockSettings = { timeFormat: '12', dateFormat: 'MM/DD/YYYY' };
    try {
      const { container } = render(
        <MeshCoreMessageStream messages={MESSAGES} selfPublicKey={SELF} onSend={async () => true} />,
      );
      const title = container.querySelector('.mc-message-time')!.getAttribute('title') ?? '';
      expect(title).toMatch(/ago \(.*\b(AM|PM)\)$/);
    } finally {
      mockSettings = undefined;
    }
  });

  it('keeps the 24-hour default without a settings provider', () => {
    const { container } = render(
      <MeshCoreMessageStream messages={MESSAGES} selfPublicKey={SELF} onSend={async () => true} />,
    );
    const title = container.querySelector('.mc-message-time')!.getAttribute('title') ?? '';
    expect(title).not.toMatch(/AM|PM/);
  });
});
