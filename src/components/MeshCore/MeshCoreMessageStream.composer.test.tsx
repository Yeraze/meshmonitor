/**
 * @vitest-environment jsdom
 *
 * #6261 WP4: the MeshCore stream uses the shared MessageComposeInput
 * (emoji button, icon send, byte counter) and the shared translation UI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../../hooks/useIsDesktop', () => ({ useIsDesktop: () => true }));

const viewState = {
  canTranslate: false,
  translated: {} as Record<string, unknown>,
};
const translateMessage = vi.fn();
const dismissTranslation = vi.fn();
const useViewTranslationsMock = vi.fn();
vi.mock('../../hooks/useViewTranslations', () => ({
  useViewTranslations: (...args: unknown[]) => {
    useViewTranslationsMock(...args);
    return {
      translationSettings: {
        enabled: true,
        canTranslate: viewState.canTranslate,
        defaultLanguage: 'en',
        defaultOutgoingLanguage: 'ja',
      },
      translatedMessages: viewState.translated,
      translateMessage,
      dismissTranslation,
    };
  },
}));

import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import type { MeshCoreMessage } from './hooks/useMeshCore';

const SELF = 'abcdef0123456789';
const m = (over: Partial<MeshCoreMessage> = {}): MeshCoreMessage => ({
  id: 'm1', fromPublicKey: 'channel-2', fromName: 'Alice', text: 'hello', timestamp: Date.now(), ...over,
});
const box = () => screen.getByPlaceholderText('Type a message…') as HTMLTextAreaElement;

beforeEach(() => {
  vi.clearAllMocks();
  viewState.canTranslate = false;
  viewState.translated = {};
});

describe('MeshCoreMessageStream shared composer', () => {
  it('renders a textarea with an emoji button and an icon Send button', () => {
    render(<MeshCoreMessageStream messages={[]} onSend={async () => true} />);
    expect(box().tagName).toBe('TEXTAREA');
    expect(screen.getByRole('button', { name: 'Insert emoji' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  it('shows the byte counter against maxBytes (DM 160) and blocks an over-limit send', () => {
    const onSend = vi.fn(async () => true);
    render(<MeshCoreMessageStream messages={[]} maxBytes={160} onSend={onSend} />);
    fireEvent.change(box(), { target: { value: 'a'.repeat(161) } });
    expect(screen.getByText('161/160')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.change(box(), { target: { value: 'a'.repeat(160) } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('a'.repeat(160));
  });

  it('clears the draft after a successful send', async () => {
    render(<MeshCoreMessageStream messages={[]} onSend={async () => true} />);
    fireEvent.change(box(), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(box().value).toBe(''));
  });

  it('is single-line: pasted newlines become spaces and Shift+Enter adds none', () => {
    render(<MeshCoreMessageStream messages={[]} onSend={async () => true} />);
    fireEvent.change(box(), { target: { value: 'a\nb' } });
    expect(box().value).toBe('a b');
    const ev = fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
    expect(ev).toBe(false); // default prevented
  });

  it('inserts an @[Name] mention from the autocomplete', async () => {
    render(
      <MeshCoreMessageStream
        messages={[]}
        contacts={[{ publicKey: 'aa'.repeat(32), advName: 'Bobby', name: 'Bobby' } as never]}
        onSend={async () => true}
      />,
    );
    const el = box();
    el.focus();
    await userEvent.type(el, '@Bo');
    fireEvent.click(await screen.findByText('Bobby'));
    expect(el.value).toBe('@[Bobby] ');
  });

  it('prefills and focuses the composer on reply', async () => {
    render(<MeshCoreMessageStream messages={[m()]} selfPublicKey={SELF} onSend={async () => true} onReply={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    expect(box().value).toBe('@[Alice]: ');
    await waitFor(() => expect(document.activeElement).toBe(box()));
  });

  it('puts the receive-only title on the textarea, send button and bar', () => {
    const { container } = render(
      <MeshCoreMessageStream messages={[]} disabled disabledReason="RX only" onSend={async () => true} />,
    );
    expect(container.querySelector('.meshcore-send-bar')).toHaveAttribute('title', 'RX only');
    expect(box()).toHaveAttribute('title', 'RX only');
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('title', 'RX only');
    expect(box().disabled).toBe(true);
  });
});

describe('MeshCoreMessageStream translation', () => {
  it('asks for stored translations for the translatable rows only', () => {
    render(
      <MeshCoreMessageStream
        sourceId="src1"
        messages={[
          m({ id: 'a', text: 'hello', timestamp: 2000 }),
          m({ id: 'b', text: 'first', timestamp: 1000 }),
          m({ id: 'r', text: '', reactionEmoji: '👍' }),
          m({ id: 'e', text: '' }),
        ]}
        onSend={async () => true}
      />,
    );
    const [src, ids] = useViewTranslationsMock.mock.calls.at(-1)!;
    expect(src).toBe('src1');
    expect(ids).toEqual(['b', 'a']);
  });

  it('shows the Translate buttons only when canTranslate', () => {
    const { rerender } = render(<MeshCoreMessageStream messages={[m()]} onSend={async () => true} />);
    expect(screen.queryByRole('button', { name: 'Translate' })).toBeNull();
    viewState.canTranslate = true;
    rerender(<MeshCoreMessageStream messages={[m()]} onSend={async () => true} />);
    // one on the row, one in the composer
    expect(screen.getAllByRole('button', { name: /^Translate/ }).length).toBe(2);
  });

  it('clicking the row Translate button requests a translation', () => {
    viewState.canTranslate = true;
    render(<MeshCoreMessageStream messages={[m()]} onSend={async () => true} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Translate' })[0]);
    expect(translateMessage).toHaveBeenCalledWith('m1', 'hello');
  });

  it('renders a stored translation under the message', () => {
    viewState.translated = { m1: { loading: false, text: 'hola', targetLang: 'es' } };
    render(<MeshCoreMessageStream messages={[m()]} onSend={async () => true} />);
    expect(screen.getByText('hola')).toBeTruthy();
  });
});
