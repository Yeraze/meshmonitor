/**
 * SaveBar and invalid number fields (#5649).
 *
 * A `NumberInput` never hands its section a blank or out-of-range value, so the
 * section's own state still looks saveable. The section passes its number scope
 * to `useSaveBar`; the bar must then refuse to save and Dismiss must put the
 * field back.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import React, { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SaveBarProvider, SaveBarGroup } from '../../contexts/SaveBarContext';
import { useSaveBar } from '../../hooks/useSaveBar';
import { SaveBar } from './SaveBar';
import { NumberInput } from '../common/NumberInput';
import { NumberInputScope } from '../common/NumberInputScope';
import { useNumberInputScope } from '../common/numberInputScope';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock((key: string) => key);
});

/** A section shaped like the real ones: saved value, edited value, SaveBar. */
function IntervalSection({ id, onSave }: { id: string; onSave: (hours: number) => void }) {
  const [saved, setSaved] = useState(6);
  const [hours, setHours] = useState(6);
  const [label, setLabel] = useState('');
  const numberScope = useNumberInputScope();
  useSaveBar({
    id,
    sectionName: id,
    hasChanges: hours !== saved || label !== '',
    isSaving: false,
    onSave: async () => {
      onSave(hours);
      setSaved(hours);
      setLabel('');
    },
    onDismiss: () => {
      setHours(saved);
      setLabel('');
    },
    numberScope,
  });
  return (
    <NumberInputScope scope={numberScope}>
      <NumberInput aria-label={`${id}-hours`} value={hours} min={3} max={24} integer onChange={setHours} />
      <input aria-label={`${id}-label`} value={label} onChange={e => setLabel(e.target.value)} />
    </NumberInputScope>
  );
}

const hours = (id = 'announce') => screen.getByLabelText(`${id}-hours`) as HTMLInputElement;
const saveButton = () => screen.getByRole('button', { name: /common\.save|savebar\.save_all/ }) as HTMLButtonElement;

describe('SaveBar: number fields', () => {
  it('will not save while a number field is blank, and saves the number once fixed', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <SaveBarProvider>
        <IntervalSection id="announce" onSave={onSave} />
        <SaveBar />
      </SaveBarProvider>,
    );

    // Make the section dirty through another field, then blank the interval.
    await user.type(screen.getByLabelText('announce-label'), 'x');
    expect(saveButton().disabled).toBe(false);

    await user.clear(hours());
    expect(saveButton().disabled).toBe(true);
    // The reason is in words, not only in the outline.
    expect(screen.getByRole('status')).toHaveTextContent('savebar.fix_invalid_fields');
    await user.click(saveButton());
    expect(onSave).not.toHaveBeenCalled();

    await user.type(hours(), '12');
    expect(saveButton().disabled).toBe(false);
    await user.click(saveButton());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(12);
  });

  it('will not save a value under the minimum, and never sends 0 or the minimum in its place', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <SaveBarProvider>
        <IntervalSection id="announce" onSave={onSave} />
        <SaveBar />
      </SaveBarProvider>,
    );

    await user.type(screen.getByLabelText('announce-label'), 'x');
    await user.clear(hours());
    await user.type(hours(), '1');
    expect(hours().value).toBe('1');
    expect(saveButton().disabled).toBe(true);
    await user.click(saveButton());
    expect(onSave).not.toHaveBeenCalled();
  });

  it('Dismiss puts a blank field back to its saved value', async () => {
    const user = userEvent.setup();
    render(
      <SaveBarProvider>
        <IntervalSection id="announce" onSave={vi.fn()} />
        <SaveBar />
      </SaveBarProvider>,
    );

    await user.type(screen.getByLabelText('announce-label'), 'x');
    await user.clear(hours());
    expect(hours().value).toBe('');

    await user.click(screen.getByText('common.dismiss'));
    expect(hours().value).toBe('6');
    expect(hours()).not.toHaveAttribute('aria-invalid');
  });

  it('one invalid section blocks a grouped Save All', async () => {
    const user = userEvent.setup();
    const saveA = vi.fn();
    const saveB = vi.fn();
    render(
      <SaveBarProvider>
        <SaveBarGroup id="settings">
          <IntervalSection id="a" onSave={saveA} />
          <IntervalSection id="b" onSave={saveB} />
        </SaveBarGroup>
        <SaveBar />
      </SaveBarProvider>,
    );

    await user.type(screen.getByLabelText('a-label'), 'x');
    await user.type(screen.getByLabelText('b-label'), 'x');
    await user.clear(hours('b'));
    expect(saveButton().disabled).toBe(true);
    await user.click(saveButton());
    expect(saveA).not.toHaveBeenCalled();
    expect(saveB).not.toHaveBeenCalled();
  });

  it('an invalid field in a section with no changes does not block another section', async () => {
    const user = userEvent.setup();
    const saveA = vi.fn();
    render(
      <SaveBarProvider>
        <IntervalSection id="a" onSave={saveA} />
        <IntervalSection id="b" onSave={vi.fn()} />
        <SaveBar />
      </SaveBarProvider>,
    );

    // b is blank but clean (nothing was emitted), a is dirty and valid.
    await user.clear(hours('b'));
    await user.type(screen.getByLabelText('a-label'), 'x');
    expect(saveButton().disabled).toBe(false);
    await user.click(saveButton());
    expect(saveA).toHaveBeenCalledWith(6);
  });
});
