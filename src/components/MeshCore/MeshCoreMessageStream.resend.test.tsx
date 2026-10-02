/**
 * @vitest-environment jsdom
 *
 * Resend action on our own channel messages that no repeater relayed (#5512).
 * The button shows only when the server would accept the resend: our channel
 * send, a stored wire timestamp, nobody heard it, under the cap, under an hour
 * old, past the 30 s cooldown, no auto-retry pending, and the composer enabled.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import type { MeshCoreMessage } from './hooks/useMeshCore';
import { resendAvailability } from './meshcoreResend';

const SELF = 'a'.repeat(64);
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

function sent(overrides: Partial<MeshCoreMessage> = {}): MeshCoreMessage {
  return {
    id: 'sent-1',
    fromPublicKey: SELF,
    toPublicKey: 'channel-1',
    text: 'anyone out there?',
    timestamp: T0,
    senderTimestamp: Math.floor(T0 / 1000),
    ...overrides,
  };
}

function renderStream(
  messages: MeshCoreMessage[],
  props: { onResendMessage?: (m: MeshCoreMessage) => Promise<unknown>; disabled?: boolean } = {},
) {
  return render(
    <MeshCoreMessageStream
      messages={messages}
      selfPublicKey={SELF}
      onSend={async () => true}
      onResendMessage={'onResendMessage' in props ? props.onResendMessage : vi.fn(async () => null)}
      disabled={props.disabled}
    />,
  );
}

const resendButton = () => screen.queryByRole('button', { name: 'Resend' });

describe('MeshCoreMessageStream — resend (#5512)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 31_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows Resend on our unheard channel message once the cooldown has passed', () => {
    renderStream([sent()]);
    expect(resendButton()).not.toBeNull();
  });

  it('hides it during the 30 s cooldown and shows it when the clock passes it', () => {
    vi.setSystemTime(T0 + 10_000);
    renderStream([sent()]);
    expect(resendButton()).toBeNull();
    act(() => { vi.advanceTimersByTime(25_000); });
    expect(resendButton()).not.toBeNull();
  });

  it('honours the cooldown after a resend', () => {
    vi.setSystemTime(T0 + 60_000);
    renderStream([sent({ resendCount: 1, lastResendAt: T0 + 50_000 })]);
    expect(resendButton()).toBeNull();
  });

  it('hides it once a repeater was heard', () => {
    renderStream([sent({ heardBy: [{ hash: 'ab', name: 'R1', snr: 3 }] })]);
    expect(resendButton()).toBeNull();
  });

  it('hides it when the cap is reached', () => {
    renderStream([sent({ resendCount: 3, lastResendAt: T0 })]);
    expect(resendButton()).toBeNull();
  });

  it('hides it for a message older than an hour, and drops it as the hour passes', () => {
    vi.setSystemTime(T0 + 60 * 60 * 1000 - 2_000);
    renderStream([sent()]);
    expect(resendButton()).not.toBeNull();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(resendButton()).toBeNull();
  });

  it('hides it for a message with no stored timestamp (sent before resend support)', () => {
    renderStream([sent({ senderTimestamp: undefined })]);
    expect(resendButton()).toBeNull();
  });

  it('hides it while the automated retry is pending', () => {
    renderStream([sent({ autoRetryPending: true })]);
    expect(resendButton()).toBeNull();
  });

  it('hides it when the stream is disabled or the parent offers no resend', () => {
    const { unmount } = renderStream([sent()], { disabled: true });
    expect(resendButton()).toBeNull();
    unmount();
    renderStream([sent()], { onResendMessage: undefined });
    expect(resendButton()).toBeNull();
  });

  it('never offers it on received messages or DMs', () => {
    renderStream([
      sent({ id: 'rx', fromPublicKey: 'channel-1', fromName: 'Bob' }),
      sent({ id: 'dm', toPublicKey: 'b'.repeat(64) }),
    ]);
    expect(resendButton()).toBeNull();
  });

  it('asks for confirmation, then calls the parent once', async () => {
    const onResend = vi.fn(async (_m: MeshCoreMessage) => ({ resendCount: 1, lastResendAt: T0 + 31_000 }));
    renderStream([sent()], { onResendMessage: onResend });

    fireEvent.click(resendButton()!);
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('anyone out there?');
    expect(dialog.textContent).toContain('3 of 3 resends left');
    expect(onResend).not.toHaveBeenCalled();

    const confirm = Array.from(dialog.querySelectorAll('button')).find(b => b.textContent === 'Resend')!;
    await act(async () => { fireEvent.click(confirm); });
    expect(onResend).toHaveBeenCalledTimes(1);
    expect(onResend.mock.calls[0][0]).toMatchObject({ id: 'sent-1' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancel closes the dialog without resending', () => {
    const onResend = vi.fn(async () => null);
    renderStream([sent()], { onResendMessage: onResend });
    fireEvent.click(resendButton()!);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onResend).not.toHaveBeenCalled();
  });

  it('hides the button when a channel_heard update arrives', () => {
    const { rerender } = renderStream([sent()]);
    expect(resendButton()).not.toBeNull();
    rerender(
      <MeshCoreMessageStream
        messages={[sent({ heardBy: [{ hash: '7f', name: null, snr: 4 }] })]}
        selfPublicKey={SELF}
        onSend={async () => true}
        onResendMessage={vi.fn(async () => null)}
      />,
    );
    expect(resendButton()).toBeNull();
  });
});

describe('resendAvailability (#5512)', () => {
  it('distinguishes never / wait / ready', () => {
    expect(resendAvailability(sent(), SELF, T0 + 31_000).kind).toBe('ready');
    expect(resendAvailability(sent(), SELF, T0 + 5_000).kind).toBe('wait');
    expect(resendAvailability(sent({ autoRetryPending: true }), SELF, T0 + 31_000).kind).toBe('wait');
    expect(resendAvailability(sent(), undefined, T0 + 31_000).kind).toBe('never');
    expect(resendAvailability(sent({ resendCount: 3 }), SELF, T0 + 31_000).kind).toBe('never');
  });
});
