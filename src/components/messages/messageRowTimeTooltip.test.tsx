/**
 * @vitest-environment jsdom
 *
 * Relative-time tooltip (#6214): the `.message-time` span on a Meshtastic DM
 * and channel row carries a `title` with the relative + absolute time
 * (e.g. "5 minutes ago (10:32 AM)"), via the shared `formatRelativeTime`.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

import { DmMessageRow, type MessageRowActions, type MessageRowNames } from './DmMessageRow';
import { ChannelMessageRow } from './ChannelMessageRow';
import type { MeshMessage } from '../../types/message';

const FIVE_MIN_AGO = new Date(Date.now() - 5 * 60 * 1000);

const msg: MeshMessage = {
  id: '1_123_456',
  from: '!deadbeef',
  to: '!cafebabe',
  fromNodeId: '!deadbeef',
  toNodeId: '!cafebabe',
  text: 'hello there',
  channel: 0,
  timestamp: FIVE_MIN_AGO,
};

const names: MessageRowNames = {
  token: {},
  name: () => 'Alice',
  short: () => 'ALIC',
  label: () => 'Alice',
};

const noop = () => {};
const actions: MessageRowActions = {
  senderClick: noop,
  relayClick: noop,
  resend: noop,
  reply: noop,
  emoji: noop,
  translate: noop,
  dismissTranslation: noop,
  remove: noop,
  tapback: noop,
  showDetails: noop,
};

describe('message timestamp relative-time tooltip (#6214)', () => {
  it('DmMessageRow .message-time has a relative-time title', () => {
    const { container } = render(
      <DmMessageRow
        msg={msg}
        isMine={false}
        dateSeparator={null}
        showUnreadDivider={false}
        reactions={[]}
        repliedMessage={null}
        currentNodeId="!cafebabe"
        canWrite={false}
        txDisabled={false}
        canTranslate={false}
        timeFormat="12"
        dateFormat="MM/DD/YYYY"
        today="2026-11-06"
        meshProtocol="meshtastic"
        mentionOptions={{}}
        names={names}
        actions={actions}
      />,
    );
    const span = container.querySelector('.message-time');
    expect(span).not.toBeNull();
    const title = span!.getAttribute('title') ?? '';
    expect(title).toMatch(/ago/);
    expect(title).toContain('(');
  });

  it('ChannelMessageRow .message-time has a relative-time title', () => {
    const { container } = render(
      <ChannelMessageRow
        msg={msg}
        isMine={false}
        dateSeparator={null}
        showUnreadDivider={false}
        reactions={[]}
        repliedMessage={null}
        currentNodeId="!cafebabe"
        canWrite={false}
        isDeviceChannel
        txDisabled={false}
        canTranslate={false}
        timeFormat="12"
        dateFormat="MM/DD/YYYY"
        today="2026-11-06"
        meshProtocol="meshtastic"
        mentionOptions={{}}
        names={names}
        actions={actions}
      />,
    );
    const span = container.querySelector('.message-time');
    expect(span).not.toBeNull();
    const title = span!.getAttribute('title') ?? '';
    expect(title).toMatch(/ago/);
    expect(title).toContain('(');
  });
});
