/**
 * @vitest-environment jsdom
 *
 * #6586 phase 3: the composer's "Insert image" entry in the + menu.
 */
import React, { useRef } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';

const PAYLOAD = 'MCOimg-test-payload';
vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});

// The lazy dialog is WP3's; here it only reports the props it got and
// hands back a fixed payload.
vi.mock('./McoImage/compose/McoImageComposeDialog', async () => {
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

import MessageComposeInput from './MessageComposeInput';
import { ComposeDraftContext, createComposeDraftStore } from '../contexts/composeDraftStore';

function setup(props: { imageByteLimit?: number; disabled?: boolean; draft?: string } = {}) {
  const store = createComposeDraftStore(props.draft ?? '');
  const onSend = vi.fn();
  const Host = () => {
    const ref = useRef<HTMLTextAreaElement>(null);
    return (
      <MessageComposeInput
        listId="t-list"
        textareaRef={ref}
        mentionCandidates={[]}
        homoglyphEnabled={false}
        placeholder="Say"
        disabled={props.disabled ?? false}
        disabledTitle="TX off"
        onSend={onSend}
        sendAriaLabel="Send"
        imageByteLimit={props.imageByteLimit}
      />
    );
  };
  const utils = render(
    <ComposeDraftContext.Provider value={store}>
      <Host />
    </ComposeDraftContext.Provider>,
  );
  const box = utils.container.querySelector('textarea.message-input') as HTMLTextAreaElement;
  return { ...utils, store, onSend, box };
}

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Insert' }));

describe('MessageComposeInput insert image', () => {
  it('has no + menu without imageByteLimit', () => {
    setup();
    expect(screen.queryByRole('button', { name: 'Insert' })).toBeNull();
  });

  it('shows Insert image in the + menu when imageByteLimit is set', () => {
    setup({ imageByteLimit: 200 });
    openMenu();
    expect(screen.getByRole('menuitem', { name: /Insert image/ })).toBeTruthy();
  });

  it('opens the dialog with the limit and the draft state', async () => {
    setup({ imageByteLimit: 151, draft: 'hello' });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Insert image/ }));
    const dlg = await screen.findByRole('dialog');
    expect(dlg.getAttribute('data-limit')).toBe('151');
    expect(dlg.getAttribute('data-draft')).toBe('true');
  });

  it('reports an empty draft as not-needing-replace', async () => {
    setup({ imageByteLimit: 200, draft: '   ' });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Insert image/ }));
    expect((await screen.findByRole('dialog')).getAttribute('data-draft')).toBe('false');
  });

  it('choosing replaces the draft, closes the dialog and focuses the box', async () => {
    const { store, box } = setup({ imageByteLimit: 200, draft: 'old text' });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Insert image/ }));
    fireEvent.click(await screen.findByText('choose-image'));
    expect(store.get()).toBe(PAYLOAD);
    expect(box.value).toBe(PAYLOAD);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(box);
  });

  it('send passes exactly the payload on', async () => {
    const { onSend, store } = setup({ imageByteLimit: 200 });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Insert image/ }));
    fireEvent.click(await screen.findByText('choose-image'));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(store.get()).toBe(PAYLOAD);
  });

  it('disables the + button with the composer', () => {
    setup({ imageByteLimit: 200, disabled: true });
    expect((screen.getByRole('button', { name: 'Insert' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Insert' }).getAttribute('title')).toBe('TX off');
  });
});
