/**
 * @vitest-environment jsdom
 *
 * Public-key mismatch warning (#4738).
 *
 * The point of this component is that a security warning should be actionable
 * and proportionate, so the assertions are about exactly that: it says what
 * changed, it scales its alarm to the user's real exposure, and it never
 * leaves them without a next step.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock('../icons/UiIcon', () => ({ UiIcon: ({ name }: { name: string }) => <i data-icon={name} /> }));

import KeyMismatchWarning from './KeyMismatchWarning';

describe('KeyMismatchWarning', () => {
  it('always states what changed', () => {
    // The original warning said only "security risk" — the user could not tell
    // what had happened.
    render(<KeyMismatchWarning sentDirectMessageCount={0} />);
    expect(screen.getByText('key_mismatch.headline')).toBeTruthy();
  });

  it('escalates when the user has DMs at stake', () => {
    render(<KeyMismatchWarning sentDirectMessageCount={4} />);
    const el = screen.getByTestId('key-mismatch-warning');

    expect(el.getAttribute('data-severity')).toBe('high');
    expect(el.getAttribute('role')).toBe('alert');
    expect(screen.getByText('key_mismatch.risk_high')).toBeTruthy();
  });

  it('stays informational when only public-channel traffic is involved', () => {
    // Alarming everyone equally is how users learn to dismiss the warning.
    render(<KeyMismatchWarning sentDirectMessageCount={0} />);
    const el = screen.getByTestId('key-mismatch-warning');

    expect(el.getAttribute('data-severity')).toBe('low');
    expect(el.getAttribute('role')).toBe('status');
    expect(screen.getByText('key_mismatch.risk_low')).toBeTruthy();
  });

  it('states the severity in words, not only colour', () => {
    // Colour alone carries no meaning for users who cannot distinguish it.
    render(<KeyMismatchWarning sentDirectMessageCount={2} />);
    expect(screen.getByText('key_mismatch.severity_high')).toBeTruthy();
  });

  it('offers concrete actions on request, verification first', async () => {
    const user = userEvent.setup();
    render(<KeyMismatchWarning sentDirectMessageCount={2} />);

    expect(screen.queryByTestId('key-mismatch-actions')).toBeNull();
    await user.click(screen.getByTestId('key-mismatch-toggle'));

    const items = Array.from(screen.getByTestId('key-mismatch-actions').querySelectorAll('li'))
      .map((li) => li.textContent);
    // Deleting the node destroys the evidence, so verifying must come first.
    expect(items[0]).toBe('key_mismatch.action_verify');
    expect(items).toContain('key_mismatch.action_intentional');
  });

  it('only advises avoiding DMs when the user actually sends them', async () => {
    const user = userEvent.setup();
    render(<KeyMismatchWarning sentDirectMessageCount={0} />);
    await user.click(screen.getByTestId('key-mismatch-toggle'));

    const items = Array.from(screen.getByTestId('key-mismatch-actions').querySelectorAll('li'))
      .map((li) => li.textContent);
    expect(items).not.toContain('key_mismatch.action_avoid_dms');
  });

  it('keeps device specifics out of the way until asked for', async () => {
    // Useful in a support thread, noise for the decision at hand.
    const user = userEvent.setup();
    render(<KeyMismatchWarning sentDirectMessageCount={1} details="pubkey abc… != def…" />);

    expect(screen.queryByTestId('key-mismatch-details')).toBeNull();
    await user.click(screen.getByTestId('key-mismatch-toggle'));
    expect(screen.getByTestId('key-mismatch-details').textContent).toContain('pubkey abc');
  });

  it('renders the action slot it is given (e.g. Clear)', () => {
    render(
      <KeyMismatchWarning sentDirectMessageCount={0}>
        <button>Clear</button>
      </KeyMismatchWarning>,
    );
    expect(screen.getByText('Clear')).toBeTruthy();
  });
});
