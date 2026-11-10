/**
 * @vitest-environment jsdom
 *
 * #6281: the Security tab's notification hands a draft to the DM stream. It is
 * seeded once, never sent, and a later switch of conversation keeps whatever
 * the user has typed.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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

import { MeshCoreMessageStream } from './MeshCoreMessageStream';

const box = () => screen.getByPlaceholderText('Type a message…') as HTMLTextAreaElement;
const DRAFT = "MeshMonitor: your node's clock is 2h 14m behind. Please set its time.";

describe('MeshCoreMessageStream initialDraft', () => {
  it('pre-fills the compose box once and never sends it', async () => {
    const onSend = vi.fn(async () => true);
    const consumed = vi.fn();
    render(
      <MeshCoreMessageStream messages={[]} onSend={onSend} maxBytes={150} conversationKey="dm-a"
        initialDraft={DRAFT} onInitialDraftConsumed={consumed} />,
    );
    expect(box().value).toBe(DRAFT);
    expect(consumed).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not re-seed after the user edits, a re-render, or a conversation switch', () => {
    const onSend = vi.fn(async () => true);
    const view = (key: string, draft: string | null) => (
      <MeshCoreMessageStream messages={[]} onSend={onSend} maxBytes={150} conversationKey={key} initialDraft={draft} />
    );
    const { rerender } = render(view('dm-a', DRAFT));
    fireEvent.change(box(), { target: { value: 'my own text' } });
    rerender(view('dm-a', DRAFT));
    expect(box().value).toBe('my own text');
    // The owner drops the draft after it was consumed; a switch keeps the user's text.
    rerender(view('dm-b', null));
    expect(box().value).toBe('my own text');
  });

  it('shows no draft when none is handed over', () => {
    render(<MeshCoreMessageStream messages={[]} onSend={async () => true} />);
    expect(box().value).toBe('');
  });
});
