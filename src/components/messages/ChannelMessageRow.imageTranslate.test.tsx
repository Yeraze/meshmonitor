/**
 * @vitest-environment jsdom
 *
 * Image messages (SPIP, MCOimg) get no Translate button (#6586).
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

import { ChannelMessageRow, type MessageRowActions, type MessageRowNames } from './ChannelMessageRow';
import type { MeshMessage } from '../../types/message';

const SAMPLE = 'im3:2nTxb8bL@u#f!+~Xv(}LpQrfRJ+tBMPKr*JTvu0t6EbJbeD"%qhto7o)L(:>=5Mf%u}"[7EE%MACq%H"EA';

const mk = (text: string): MeshMessage => ({
  id: '1_123_456',
  from: '!deadbeef',
  to: '!cafebabe',
  fromNodeId: '!deadbeef',
  toNodeId: '!cafebabe',
  text,
  channel: 0,
  timestamp: new Date(),
});

const names: MessageRowNames = { token: {}, name: () => 'Alice', short: () => 'ALIC', label: () => 'Alice' };
const noop = () => {};
const actions: MessageRowActions = {
  senderClick: noop, relayClick: noop, resend: noop, reply: noop, emoji: noop, translate: noop,
  dismissTranslation: noop, remove: noop, tapback: noop, showDetails: noop,
};

const renderRow = (text: string) =>
  render(
    <ChannelMessageRow
      msg={mk(text)}
      isMine={false}
      dateSeparator={null}
      showUnreadDivider={false}
      reactions={[]}
      repliedMessage={null}
      currentNodeId="!cafebabe"
      canWrite
        isDeviceChannel
      txDisabled={false}
      canTranslate
      timeFormat="12"
      dateFormat="MM/DD/YYYY"
      today="2026-11-06"
      meshProtocol="meshtastic"
      mentionOptions={{}}
      names={names}
      actions={actions}
    />,
  );

describe('ChannelMessageRow Translate button vs image messages', () => {
  it('shows Translate on plain text', () => {
    expect(renderRow('hello there').container.querySelector('.translate-button')).not.toBeNull();
  });

  it.each([
    ['MCOimg', SAMPLE],
    ['SPIP', '3:yzyzyzyzy'],
  ])('hides Translate on %s', (_n, text) => {
    expect(renderRow(text).container.querySelector('.translate-button')).toBeNull();
  });
});
