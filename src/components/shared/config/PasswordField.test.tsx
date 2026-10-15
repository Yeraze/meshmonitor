/**
 * @vitest-environment jsdom
 */
import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../../test/mockI18n');
  return createReactI18nextMock();
});

import { PasswordField } from './PasswordField';

const Controlled: React.FC<{ disabled?: boolean; initial?: string }> = ({ disabled, initial = '' }) => {
  const [value, setValue] = useState(initial);
  return (
    <PasswordField
      id="pw"
      aria-label="Secret"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      disabled={disabled}
      placeholder="Leave blank to keep"
    />
  );
};

const input = () => screen.getByLabelText('Secret') as HTMLInputElement;

describe('PasswordField', () => {
  it('starts hidden with a "Show password" toggle that is not pressed', () => {
    render(<Controlled initial="hunter2" />);
    expect(input().type).toBe('password');
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.getAttribute('type')).toBe('button');
  });

  it('toggles between password and text and flips the label', () => {
    render(<Controlled initial="hunter2" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input().type).toBe('text');
    const hide = screen.getByRole('button', { name: 'Hide password' });
    expect(hide.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(hide);
    expect(input().type).toBe('password');
  });

  it('passes props through and stays controlled', () => {
    render(<Controlled />);
    const el = input();
    expect(el.id).toBe('pw');
    expect(el.placeholder).toBe('Leave blank to keep');
    expect(el.getAttribute('autocomplete')).toBe('new-password');
    fireEvent.change(el, { target: { value: 'abc' } });
    expect(input().value).toBe('abc');
  });

  it('honours a caller autoComplete and className', () => {
    render(
      <PasswordField aria-label="Secret" value="" onChange={() => {}} autoComplete="off" className="setting-input" />,
    );
    expect(input().getAttribute('autocomplete')).toBe('off');
    expect(input().classList.contains('setting-input')).toBe(true);
  });

  it('disables the toggle with the input and reverts to hidden', () => {
    const { rerender } = render(<Controlled initial="x" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input().type).toBe('text');

    rerender(<Controlled initial="x" disabled />);
    expect(input().disabled).toBe(true);
    expect(input().type).toBe('password');
    const toggle = screen.getByRole('button', { name: 'Show password' }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    // Re-enabling does not bring the value back into view.
    rerender(<Controlled initial="x" />);
    expect(input().type).toBe('password');
  });

  it('does not submit the surrounding form', () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Controlled initial="x" />
      </form>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(input().type).toBe('text');
  });

  it('starts hidden again after a remount', () => {
    const { unmount } = render(<Controlled initial="x" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    unmount();
    render(<Controlled initial="x" />);
    expect(input().type).toBe('password');
  });
});
