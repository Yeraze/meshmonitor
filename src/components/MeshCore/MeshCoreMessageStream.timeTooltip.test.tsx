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
});
