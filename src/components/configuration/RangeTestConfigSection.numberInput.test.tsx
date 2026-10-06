/**
 * @vitest-environment jsdom
 *
 * Device Configuration module sections and NumberInput (#5649).
 *
 * Every module section keeps its numbers in the parent and saves through the
 * SaveBar. The old inputs ran `parseInt(e.target.value) || 0`, so clearing the
 * Range Test sender interval wrote 0 into the parent, and a Save right then
 * sent 0 to the radio. The section is tested end to end here: real SaveBar,
 * real `useSaveBar`, a parent that holds the state as ConfigurationTab does.
 */

import { describe, it, expect, vi } from 'vitest';
import React, { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  const t = (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key);
  return createReactI18nextMock(t);
});

import RangeTestConfigSection from './RangeTestConfigSection';
import { SaveBarProvider } from '../../contexts/SaveBarContext';
import { SaveBar } from '../SaveBar/SaveBar';

/** Stands in for ConfigurationTab: owns the values, builds the payload on save. */
function Parent({ onPayload, isDisabled }: { onPayload: (p: { sender: unknown }) => void; isDisabled?: boolean }) {
  const [enabled, setEnabled] = useState(true);
  const [sender, setSender] = useState(60);
  const [save, setSave] = useState(false);
  return (
    <SaveBarProvider>
      <RangeTestConfigSection
        enabled={enabled}
        setEnabled={setEnabled}
        sender={sender}
        setSender={setSender}
        save={save}
        setSave={setSave}
        isDisabled={isDisabled}
        isSaving={false}
        onSave={async () => onPayload({ sender })}
      />
      <SaveBar />
    </SaveBarProvider>
  );
}

const senderInput = () => document.getElementById('rangetestSender') as HTMLInputElement;
const saveButton = () => screen.queryByRole('button', { name: 'common.save' }) as HTMLButtonElement | null;

describe('RangeTestConfigSection: sender interval through NumberInput', () => {
  it('can be cleared and retyped, and saves the typed integer', async () => {
    const user = userEvent.setup();
    const onPayload = vi.fn();
    render(<Parent onPayload={onPayload} />);

    await user.click(senderInput());
    await user.keyboard('{Backspace}{Backspace}');
    expect(senderInput().value).toBe('');
    await user.keyboard('120');
    expect(senderInput().value).toBe('120');
    expect(senderInput()).not.toHaveAttribute('aria-invalid');

    expect(saveButton()!.disabled).toBe(false);
    await user.click(saveButton()!);

    expect(onPayload).toHaveBeenCalledTimes(1);
    const { sender } = onPayload.mock.calls[0][0];
    expect(sender).toBe(120);
    expect(Number.isInteger(sender)).toBe(true);
  });

  it('blocks Save while the interval is blank, and never turns blank into 0', async () => {
    const user = userEvent.setup();
    const onPayload = vi.fn();
    render(<Parent onPayload={onPayload} />);

    // Make the section dirty first, so the SaveBar is on screen.
    await user.click(document.getElementById('rangetestSave')!);
    expect(saveButton()!.disabled).toBe(false);

    await user.clear(senderInput());
    expect(senderInput().value).toBe('');
    expect(senderInput()).toHaveAttribute('aria-invalid', 'true');
    expect(saveButton()!.disabled).toBe(true);
    expect(screen.getByText('savebar.fix_invalid_fields')).toBeTruthy();

    await user.click(saveButton()!);
    expect(onPayload).not.toHaveBeenCalled();

    // Fixed: Save comes back and carries the number.
    await user.type(senderInput(), '300');
    expect(saveButton()!.disabled).toBe(false);
    await user.click(saveButton()!);
    expect(onPayload).toHaveBeenCalledWith({ sender: 300 });
  });

  it('blocks a value past the uint16 limit and a fractional one', async () => {
    const user = userEvent.setup();
    const onPayload = vi.fn();
    render(<Parent onPayload={onPayload} />);
    await user.click(document.getElementById('rangetestSave')!);

    await user.clear(senderInput());
    await user.type(senderInput(), '70000');
    expect(senderInput()).toHaveAttribute('aria-invalid', 'true');
    expect(saveButton()!.disabled).toBe(true);

    await user.clear(senderInput());
    await user.type(senderInput(), '1.5');
    expect(senderInput()).toHaveAttribute('aria-invalid', 'true');
    expect(saveButton()!.disabled).toBe(true);
    expect(onPayload).not.toHaveBeenCalled();
  });

  it('Dismiss puts the saved interval back in a blank field', async () => {
    const user = userEvent.setup();
    render(<Parent onPayload={vi.fn()} />);
    await user.click(document.getElementById('rangetestSave')!);
    await user.clear(senderInput());
    expect(senderInput().value).toBe('');

    await user.click(screen.getByRole('button', { name: 'common.dismiss' }));
    expect(senderInput().value).toBe('60');
    expect(senderInput()).not.toHaveAttribute('aria-invalid');
  });

  it('keeps 0 legal: it is the firmware value for "sender off"', async () => {
    const user = userEvent.setup();
    const onPayload = vi.fn();
    render(<Parent onPayload={onPayload} />);
    await user.clear(senderInput());
    await user.type(senderInput(), '0');
    expect(senderInput()).not.toHaveAttribute('aria-invalid');
    await user.click(saveButton()!);
    expect(onPayload).toHaveBeenCalledWith({ sender: 0 });
  });
});
