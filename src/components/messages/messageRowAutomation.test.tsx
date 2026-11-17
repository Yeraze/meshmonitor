/**
 * @vitest-environment jsdom
 *
 * is_automation indicator (#6449): a Meshtastic message whose sender set
 * Data.bitfield bit 2 shows a bot icon in the DM and channel rows.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

import { DmMessageRow, type MessageRowActions, type MessageRowNames } from './DmMessageRow';
import { ChannelMessageRow } from './ChannelMessageRow';
import HopCountDisplay from '../HopCountDisplay';
import type { MeshMessage } from '../../types/message';

const base: MeshMessage = {
  id: '1_123_456',
  from: '!deadbeef',
  to: '!cafebabe',
  fromNodeId: '!deadbeef',
  toNodeId: '!cafebabe',
  text: 'hello there',
  channel: 0,
  timestamp: new Date(Date.now() - 60_000),
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

const common = {
  isMine: false,
  dateSeparator: null,
  showUnreadDivider: false,
  reactions: [],
  repliedMessage: null,
  currentNodeId: '!cafebabe',
  canWrite: false,
  txDisabled: false,
  canTranslate: false,
  timeFormat: '12' as const,
  dateFormat: 'MM/DD/YYYY' as const,
  today: '2026-11-06',
  meshProtocol: 'meshtastic' as const,
  mentionOptions: {},
  names,
  actions,
};

const LABEL = /sent by an automation/i;

describe('is_automation indicator (#6449)', () => {
  for (const [label, isAutomation, shown] of [
    ['true', true, true],
    ['false', false, false],
    ['undefined', undefined, false],
  ] as const) {
    it(`DmMessageRow: isAutomation=${label} → ${shown ? 'shown' : 'hidden'}`, () => {
      render(<DmMessageRow {...common} msg={{ ...base, isAutomation }} />);
      expect(screen.queryByLabelText(LABEL) !== null).toBe(shown);
    });

    it(`ChannelMessageRow: isAutomation=${label} → ${shown ? 'shown' : 'hidden'}`, () => {
      render(<ChannelMessageRow {...common} isDeviceChannel msg={{ ...base, isAutomation }} />);
      expect(screen.queryByLabelText(LABEL) !== null).toBe(shown);
    });
  }

  it('HopCountDisplay renders the bot icon, with or without hop data', () => {
    const { unmount } = render(<HopCountDisplay isAutomation />);
    expect(screen.getByLabelText(LABEL).querySelector('[data-ui-icon="bot"]')).toBeInTheDocument();
    unmount();
    render(<HopCountDisplay hopStart={7} hopLimit={5} isAutomation />);
    expect(screen.getByLabelText(LABEL).querySelector('[data-ui-icon="bot"]')).toBeInTheDocument();
  });
});
