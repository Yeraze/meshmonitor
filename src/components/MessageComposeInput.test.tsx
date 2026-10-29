/**
 * @vitest-environment jsdom
 *
 * MessageComposeInput is the only subscriber to the compose draft, so a
 * keystroke re-renders the box and not the tab hosting it (MessagesTab /
 * ChannelsTab render the whole conversation and node list).
 */
import React, { useRef } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import MessageComposeInput from './MessageComposeInput';
import { ComposeDraftContext, createComposeDraftStore } from '../contexts/composeDraftStore';

function setup(onSend = vi.fn(), disabled = false) {
  const store = createComposeDraftStore();
  const counts = { host: 0 };
  const Host = () => {
    counts.host++;
    const ref = useRef<HTMLTextAreaElement>(null);
    return (
      <MessageComposeInput
        listId="test-mention-list"
        textareaRef={ref}
        mentionCandidates={[]}
        homoglyphEnabled={false}
        placeholder="Say something"
        disabled={disabled}
        disabledTitle="TX off"
        onSend={onSend}
        sendAriaLabel="Send"
      />
    );
  };
  const utils = render(
    <ComposeDraftContext.Provider value={store}>
      <Host />
    </ComposeDraftContext.Provider>
  );
  const box = utils.container.querySelector('textarea.message-input') as HTMLTextAreaElement;
  const send = utils.getByLabelText('Send') as HTMLButtonElement;
  return { ...utils, store, counts, box, send, onSend };
}

describe('MessageComposeInput', () => {
  it('typing updates the box and the store without re-rendering the host', () => {
    const { box, store, counts } = setup();
    const before = counts.host;
    const text = 'twenty characters!!!';
    for (let i = 1; i <= text.length; i++) fireEvent.change(box, { target: { value: text.slice(0, i) } });
    expect(box.value).toBe(text);
    expect(store.get()).toBe(text);
    expect(counts.host).toBe(before);
  });

  it('enables send only for a non-blank draft and sends on Enter', () => {
    const { box, send, onSend } = setup();
    expect(send.disabled).toBe(true);
    fireEvent.change(box, { target: { value: '   ' } });
    expect(send.disabled).toBe(true);
    fireEvent.change(box, { target: { value: 'hi' } });
    expect(send.disabled).toBe(false);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it('reflects writes made elsewhere (send clears, reply prefill)', () => {
    const { box, store } = setup();
    act(() => store.set('prefill'));
    expect(box.value).toBe('prefill');
    act(() => store.set(''));
    expect(box.value).toBe('');
  });

  it('shows the byte counter and honours disabled', () => {
    const { box, send, container } = setup(vi.fn(), true);
    fireEvent.change(box, { target: { value: 'abc' } });
    expect(box.disabled).toBe(true);
    expect(box.title).toBe('TX off');
    expect(send.disabled).toBe(true);
    expect(container.querySelector('.input-with-counter')?.textContent).toContain('3');
  });
});
