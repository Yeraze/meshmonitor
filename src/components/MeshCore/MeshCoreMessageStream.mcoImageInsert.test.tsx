/**
 * @vitest-environment jsdom
 *
 * #6586 phase 3: MeshCoreMessageStream passes its own byte cap as the image limit.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const PAYLOAD = 'MCOimg-test-payload';
vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../../hooks/useIsDesktop', () => ({ useIsDesktop: () => true }));
vi.mock('../../hooks/useViewTranslations', () => ({
  useViewTranslations: () => ({
    translationSettings: { enabled: false, canTranslate: false, defaultLanguage: 'en', defaultOutgoingLanguage: 'en' },
    translatedMessages: {},
    translateMessage: vi.fn(),
    dismissTranslation: vi.fn(),
  }),
}));

// The lazy dialog is WP3's; here it only reports the props it got and
// hands back a fixed payload.
vi.mock('../McoImage/compose/McoImageComposeDialog', async () => {
  const React = await import('react');
  return {
    default: (p: { limit: number; draftNotEmpty: boolean; onChoose(t: string): void; onClose(): void }) =>
      React.createElement(
        'div',
        { role: 'dialog', 'data-limit': String(p.limit), 'data-draft': String(p.draftNotEmpty) },
        React.createElement('button', { onClick: () => p.onChoose(PAYLOAD) }, 'choose-image'),
      ),
  };
});

import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import {
  meshcoreChannelMaxBytes,
  MESHCORE_MAX_MESSAGE_BYTES_CHANNEL_WORST_CASE,
  MESHCORE_MAX_MESSAGE_BYTES_DM,
} from '../../utils/meshcoreMessageLimits';

async function insertImage() {
  fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Insert image/ }));
  const dlg = await screen.findByRole('dialog');
  const limit = dlg.getAttribute('data-limit');
  fireEvent.click(screen.getByText('choose-image'));
  return limit;
}

describe('MeshCoreMessageStream insert image', () => {
  it.each([
    ['its default (worst-case channel) cap', undefined, MESHCORE_MAX_MESSAGE_BYTES_CHANNEL_WORST_CASE],
    ['a DM cap', MESHCORE_MAX_MESSAGE_BYTES_DM, MESHCORE_MAX_MESSAGE_BYTES_DM],
    ['a named-node channel cap', meshcoreChannelMaxBytes('Alice'), meshcoreChannelMaxBytes('Alice')],
  ])('passes %s as the limit', async (_n, maxBytes, expected) => {
    render(<MeshCoreMessageStream messages={[]} maxBytes={maxBytes} onSend={async () => true} />);
    expect(Number(await insertImage())).toBe(expected);
  });

  it('Alice channel limit is 153 (160 - 5 name bytes - 2)', () => {
    expect(meshcoreChannelMaxBytes('Alice')).toBe(153);
  });

  it('sends exactly the inserted payload', async () => {
    const onSend = vi.fn(async () => true);
    render(<MeshCoreMessageStream messages={[]} onSend={onSend} />);
    await insertImage();
    const box = screen.getByPlaceholderText('Type a message…') as HTMLTextAreaElement;
    expect(box.value).toBe(PAYLOAD);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toBe(PAYLOAD);
  });
});
