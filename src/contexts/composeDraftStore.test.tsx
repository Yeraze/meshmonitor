/**
 * @vitest-environment jsdom
 *
 * The compose draft lives outside MessagingContext so a keystroke re-renders
 * only the compose host, not every MessagingContext consumer (App included).
 * These tests pin that, and pin that the #4183 draft-scoping behaviour moved
 * with it intact.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { MessagingProvider, useMessaging } from './MessagingContext';
import { useComposeDraft, useComposeDraftStore, createComposeDraftStore } from './composeDraftStore';
import ComposeDraftBinder from '../components/ComposeDraftBinder';

let activeTab = 'messages';
vi.mock('./AuthContext', () => ({ useAuth: () => ({ authStatus: { authenticated: false } }) }));
vi.mock('./SourceContext', () => ({ useSource: () => ({ sourceId: null, sourceName: null }) }));
vi.mock('./UIContext', () => ({ useUI: () => ({ showMqttMessages: true, activeTab }) }));
vi.mock('../hooks/useUnreadCounts', () => ({
  useUnreadCounts: () => ({ data: undefined, refetch: vi.fn() }),
  useMarkAsRead: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../hooks/useFirstUnread', () => ({ useFirstUnread: () => ({ data: undefined }) }));

describe('createComposeDraftStore', () => {
  it('notifies on change, skips no-op writes, supports updater functions', () => {
    const store = createComposeDraftStore();
    const listener = vi.fn();
    const unsub = store.subscribe(listener);
    store.set('hi');
    store.set('hi');
    store.set((prev) => prev + '!');
    expect(store.get()).toBe('hi!');
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
    store.set('');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('compose draft render isolation', () => {
  beforeEach(() => {
    activeTab = 'messages';
  });

  function setup() {
    const counts = { consumer: 0, binder: 0 };
    let messaging: ReturnType<typeof useMessaging> | null = null;
    let store: ReturnType<typeof useComposeDraftStore> | null = null;

    // Stands in for App: reads MessagingContext, never the draft.
    const Consumer = () => {
      counts.consumer++;
      messaging = useMessaging();
      store = useComposeDraftStore();
      return null;
    };
    const Compose = () => (
      <ComposeDraftBinder>
        {(draft, setDraft) => {
          counts.binder++;
          return <textarea data-testid="compose" value={draft} onChange={(e) => setDraft(e.target.value)} />;
        }}
      </ComposeDraftBinder>
    );
    const utils = render(
      <MessagingProvider>
        <Consumer />
        <Compose />
      </MessagingProvider>
    );
    return { ...utils, counts, messaging: () => messaging!, store: () => store! };
  }

  it('typing re-renders the compose host but not a MessagingContext consumer', () => {
    const { getByTestId, counts, store } = setup();
    const consumerBefore = counts.consumer;
    const binderBefore = counts.binder;
    const box = getByTestId('compose') as HTMLTextAreaElement;

    const text = 'hello mesh';
    for (let i = 1; i <= text.length; i++) {
      fireEvent.change(box, { target: { value: text.slice(0, i) } });
    }

    expect(box.value).toBe(text);
    expect(store().get()).toBe(text);
    expect(counts.consumer).toBe(consumerBefore);
    expect(counts.binder).toBe(binderBefore + text.length);
  });

  it('setNewMessage from the context writes the draft (send clears it)', () => {
    const { getByTestId, messaging } = setup();
    const box = getByTestId('compose') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'draft' } });
    act(() => messaging().setNewMessage(''));
    expect(box.value).toBe('');
  });

  it('openDmWithDraft prefills the draft and the scoping effect keeps it', () => {
    const { getByTestId, messaging } = setup();
    act(() => messaging().openDmWithDraft('!00000001', 'prefilled'));
    expect((getByTestId('compose') as HTMLTextAreaElement).value).toBe('prefilled');
    expect(messaging().selectedDMNode).toBe('!00000001');
  });

  it('switching conversation still clears the draft (#4183)', () => {
    const { getByTestId, messaging } = setup();
    act(() => messaging().setSelectedDMNode('!00000001'));
    const box = getByTestId('compose') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'private' } });
    act(() => messaging().setSelectedDMNode('!00000002'));
    expect(box.value).toBe('');
  });

  it('openDmForCompose empties the draft and raises the focus request', () => {
    const { getByTestId, messaging } = setup();
    fireEvent.change(getByTestId('compose'), { target: { value: 'old' } });
    act(() => messaging().openDmForCompose('!00000003'));
    expect((getByTestId('compose') as HTMLTextAreaElement).value).toBe('');
    expect(messaging().pendingComposeFocus).toBe('!00000003');
  });
});

describe('useComposeDraft outside a provider', () => {
  it('falls back to a module store instead of throwing', () => {
    let value: string | null = null;
    const Probe = () => {
      [value] = useComposeDraft();
      return null;
    };
    render(<Probe />);
    expect(value).toBe('');
  });
});
