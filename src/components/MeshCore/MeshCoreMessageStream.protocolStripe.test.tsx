/**
 * @vitest-environment jsdom
 *
 * Protocol stripe (#5744): every MeshCore message row, sent or received,
 * carries the MeshCore protocol marker.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import type { MeshCoreMessage } from './hooks/useMeshCore';
import protocolStripe from '../messages/ProtocolStripe.module.css';

const SELF = 'aa'.repeat(32);
const now = Date.now();
const MESSAGES: MeshCoreMessage[] = [
  { id: 'in', fromPublicKey: 'channel-0', fromName: 'Someone', text: 'heard', timestamp: now - 2000 },
  { id: 'out', fromPublicKey: SELF, fromName: 'Me', text: 'sent', timestamp: now - 1000 },
];

describe('MeshCoreMessageStream protocol stripe (#5744)', () => {
  it('marks received and sent rows as MeshCore', () => {
    const { container } = render(
      <MeshCoreMessageStream messages={MESSAGES} selfPublicKey={SELF} onSend={async () => true} />,
    );
    const rows = Array.from(container.querySelectorAll('.mc-message-row'));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toHaveAttribute('data-protocol', 'meshcore');
      expect(row).toHaveClass(protocolStripe.stripe);
    }
    expect(container.querySelector('.mc-message-row.outgoing')).not.toBeNull();
  });
});
