/**
 * @vitest-environment jsdom
 *
 * "Sent as X" label on an own channel send that went out under an API sender
 * name (#6282). Absent on a normal send.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../diagnostics/MessageDetailsModal', () => ({
  default: () => <div />,
}));

import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import type { MeshCoreMessage } from './hooks/useMeshCore';

const SELF = 'a'.repeat(64);
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);

const send = (over: Partial<MeshCoreMessage> = {}): MeshCoreMessage => ({
  id: 'sent-1', fromPublicKey: SELF, toPublicKey: 'channel-1', text: 'hello', timestamp: T0, ...over,
});

const renderStream = (messages: MeshCoreMessage[]) =>
  render(<MeshCoreMessageStream messages={messages} selfPublicKey={SELF} onSend={async () => true} />);

describe('MeshCoreMessageStream sent-as label (#6282)', () => {
  it('shows who the message was sent as', () => {
    renderStream([send({ fromName: 'Alerts Bot', senderNameOverride: 'Alerts Bot' })]);
    expect(screen.getByTestId('mc-sent-as').textContent).toContain('Sent as Alerts Bot');
  });

  it('shows nothing on a normal send', () => {
    renderStream([send()]);
    expect(screen.queryByTestId('mc-sent-as')).toBeNull();
  });
});
