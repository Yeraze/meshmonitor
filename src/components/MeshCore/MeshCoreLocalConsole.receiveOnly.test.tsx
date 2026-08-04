/**
 * @vitest-environment jsdom
 *
 * MeshCoreLocalConsole — receive-only mode (#4547 Phase 2 WP3).
 *
 * The local console stays usable while receive-only: local serial CLI is
 * explicitly allowed (interview decision 2). Only the synthetic `advert`
 * quick action transmits, so it alone is disabled (with a tooltip) via
 * `ActionCommand.disabled`, not by disabling the console body wholesale.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MeshCoreLocalConsole } from './MeshCoreLocalConsole';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
  }),
}));

function makeActions() {
  return { sendLocalCliCommand: vi.fn().mockResolvedValue({ ok: true, reply: 'ok' }) };
}

describe('MeshCoreLocalConsole receive-only mode — Companion device', () => {
  let actions: ReturnType<typeof makeActions>;

  beforeEach(() => {
    actions = makeActions();
  });

  it('keeps the input, Send button, and non-advert quick actions enabled', () => {
    render(
      <MeshCoreLocalConsole
        sourceId="src-1"
        deviceType={1}
        connected
        actions={actions}
        receiveOnly
      />,
    );
    const input = screen.getByPlaceholderText(/Type a command/);
    expect(input).not.toBeDisabled();

    for (const label of ['Version', 'Stats', 'Clock', 'Help']) {
      const btn = screen.getByText(label).closest('button');
      expect(btn).not.toBeDisabled();
    }
  });

  it('disables only the "Send advert" quick action, with a tooltip', () => {
    render(
      <MeshCoreLocalConsole
        sourceId="src-1"
        deviceType={1}
        connected
        actions={actions}
        receiveOnly
      />,
    );
    const advertBtn = screen.getByText('Send advert').closest('button');
    expect(advertBtn).toBeDisabled();
    expect(advertBtn).toHaveAttribute('title', 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.');
  });

  it('runs a non-transmitting quick action (ver) successfully while receive-only', async () => {
    render(
      <MeshCoreLocalConsole
        sourceId="src-1"
        deviceType={1}
        connected
        actions={actions}
        receiveOnly
      />,
    );
    fireEvent.click(screen.getByText('Version'));
    // Quick actions pre-fill the input rather than auto-sending — press Send.
    const sendBtn = screen.getByText('Send');
    fireEvent.click(sendBtn);
    await waitFor(() => expect(actions.sendLocalCliCommand).toHaveBeenCalledWith('ver', undefined));
  });

  it('appends the receive-only hint to the input placeholder', () => {
    render(
      <MeshCoreLocalConsole
        sourceId="src-1"
        deviceType={1}
        connected
        actions={actions}
        receiveOnly
      />,
    );
    const input = screen.getByPlaceholderText(
      /Type a command \(ver, stats, clock, advert, help\).*Local serial commands still work/,
    );
    expect(input).toBeInTheDocument();
  });

  it('leaves the advert action enabled and untitled when receiveOnly is false', () => {
    render(
      <MeshCoreLocalConsole
        sourceId="src-1"
        deviceType={1}
        connected
        actions={actions}
      />,
    );
    const advertBtn = screen.getByText('Send advert').closest('button');
    expect(advertBtn).not.toBeDisabled();
    expect(advertBtn).toHaveAttribute('title', 'advert');
  });
});

describe('MeshCoreLocalConsole receive-only mode — Repeater device (ACL form)', () => {
  it('leaves the ACL setperm form enabled — local serial is allowed even while receive-only', () => {
    const actions = makeActions();
    const { container } = render(
      <MeshCoreLocalConsole
        sourceId="src-1"
        deviceType={2}
        connected
        actions={actions}
        receiveOnly
      />,
    );
    // MeshCoreAclManager renders a "setperm" submit control; assert it's not
    // disabled by checking the pubkey input (the form's own required field).
    const pubkeyInput = container.querySelector('.acl-pubkey-input');
    expect(pubkeyInput).not.toBeDisabled();

    // The "Send advert" quick action, part of the Repeater catalog, is still
    // the one gated control.
    const advertBtn = screen.getByText('Send advert').closest('button');
    expect(advertBtn).toBeDisabled();
  });
});
