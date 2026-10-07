/**
 * NumberInput (#5649): the one number field for the app.
 *
 * The bug it ends: a controlled `<input type="number">` bound to number state
 * through `parseInt(e.target.value) || 60` put "60" back the moment the field
 * went blank, so a user could not backspace 60 away to type 120.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import React, { useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NumberInput, type NumberInputProps } from './NumberInput';
import { NumberInputScope } from './NumberInputScope';
import { useNumberInputScope } from './numberInputScopeContext';
import { evaluateNumberDraft, formatNumberDraft } from './numberInputValidation';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

type HarnessProps = Omit<NumberInputProps, 'value' | 'onChange' | 'allowEmpty'> & {
  initial: number | null;
  allowEmpty?: boolean;
  onEmit?: (v: number | null) => void;
};

/** A parent that keeps number state, as every form in the app does. */
function Harness({ initial, onEmit, allowEmpty, ...rest }: HarnessProps) {
  const [value, setValue] = useState<number | null>(initial);
  const handle = (v: number | null) => {
    onEmit?.(v);
    setValue(v);
  };
  return (
    <>
      {allowEmpty ? (
        <NumberInput {...rest} aria-label="field" value={value} allowEmpty onChange={handle} />
      ) : (
        <NumberInput {...rest} aria-label="field" value={value} onChange={handle} />
      )}
      <output data-testid="parent">{String(value)}</output>
      <button onClick={() => setValue(999)}>external</button>
    </>
  );
}

const field = () => screen.getByLabelText('field') as HTMLInputElement;
const parent = () => screen.getByTestId('parent').textContent;

describe('NumberInput: clearing and retyping', () => {
  it('lets the user backspace 60 away and type 120 (the reported case)', async () => {
    const user = userEvent.setup();
    const onEmit = vi.fn();
    render(<Harness initial={60} min={0} max={3600} integer onEmit={onEmit} />);

    await user.click(field());
    await user.keyboard('{Backspace}');
    expect(field().value).toBe('6');
    await user.keyboard('{Backspace}');
    // Blank, and it stays blank: nothing puts 60 (or 0) back.
    expect(field().value).toBe('');
    expect(field()).toHaveAttribute('aria-invalid', 'true');

    await user.keyboard('120');
    expect(field().value).toBe('120');
    expect(field()).not.toHaveAttribute('aria-invalid');
    expect(parent()).toBe('120');
    // The parent heard numbers only: never '', NaN, null or 0-for-blank.
    for (const [v] of onEmit.mock.calls) {
      expect(typeof v).toBe('number');
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(onEmit.mock.calls.map(c => c[0])).toEqual([6, 1, 12, 120]);
  });

  it('does not emit while blank, so the parent keeps its last valid number', async () => {
    const user = userEvent.setup();
    const onEmit = vi.fn();
    render(<Harness initial={60} onEmit={onEmit} />);

    await user.clear(field());
    expect(field().value).toBe('');
    expect(onEmit).not.toHaveBeenCalled();
    expect(parent()).toBe('60');
  });

  it('keeps a blank required field blank and invalid after blur', async () => {
    const user = userEvent.setup();
    render(<Harness initial={60} />);

    await user.clear(field());
    await user.tab();
    expect(field()).not.toHaveFocus();
    expect(field().value).toBe('');
    expect(field()).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('NumberInput: invalid state', () => {
  it('marks a blank required field and gives assistive tech a reason', async () => {
    const user = userEvent.setup();
    render(<Harness initial={5} />);
    expect(field()).not.toHaveAttribute('aria-invalid');

    await user.clear(field());
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(field().className).toMatch(/invalid/);
    const reasonId = field().getAttribute('aria-describedby')!;
    expect(document.getElementById(reasonId)).toHaveTextContent('Enter a number');
    // Not colour alone: the reason is also the tooltip.
    expect(field()).toHaveAttribute('title', 'Enter a number');
  });

  it('keeps the reason out of a wrapping label, so the field keeps its name', async () => {
    const user = userEvent.setup();
    function Labelled() {
      const [v, setV] = useState(5);
      return (
        <label>
          Cooldown
          <NumberInput value={v} onChange={setV} />
        </label>
      );
    }
    render(<Labelled />);
    await user.clear(screen.getByLabelText('Cooldown'));
    const el = screen.getByLabelText('Cooldown');
    expect(el).toHaveAttribute('aria-invalid', 'true');
    expect(el.closest('label')!.textContent).toBe('Cooldown');
    expect(el).toHaveAccessibleDescription('Enter a number');
  });

  it('is invalid on first render when the parent has no number', () => {
    render(<Harness initial={null} />);
    expect(field().value).toBe('');
    expect(field()).toHaveAttribute('aria-invalid', 'true');
  });

  it('blocks a value below min: red, not emitted, not clamped, not replaced by 0', async () => {
    const user = userEvent.setup();
    const onEmit = vi.fn();
    render(<Harness initial={30} min={15} max={1440} integer onEmit={onEmit} />);

    await user.clear(field());
    await user.type(field(), '5');
    expect(field().value).toBe('5');
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(onEmit).not.toHaveBeenCalled();
    expect(parent()).toBe('30');
    expect(document.getElementById(field().getAttribute('aria-describedby')!))
      .toHaveTextContent('Must be between 15 and 1440');

    await user.tab();
    expect(field().value).toBe('5');
    expect(parent()).toBe('30');
  });

  it('blocks a value above max without clamping the keystroke', async () => {
    const user = userEvent.setup();
    const onEmit = vi.fn();
    render(<Harness initial={5} max={10} onEmit={onEmit} />);

    await user.clear(field());
    await user.type(field(), '25');
    expect(field().value).toBe('25');
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(onEmit.mock.calls.map(c => c[0])).toEqual([2]);
    expect(parent()).toBe('2');
  });

  it('rejects a decimal in an integer field and accepts it in a decimal field', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness initial={1} integer />);
    await user.clear(field());
    await user.type(field(), '1.5');
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(parent()).toBe('1');
    unmount();

    const onEmit = vi.fn();
    render(<Harness initial={1} step={0.1} onEmit={onEmit} />);
    await user.clear(field());
    await user.type(field(), '1.5');
    expect(field()).not.toHaveAttribute('aria-invalid');
    expect(parent()).toBe('1.5');
    expect(onEmit).toHaveBeenLastCalledWith(1.5);
  });

  it('accepts negative numbers when min allows them', async () => {
    const user = userEvent.setup();
    render(<Harness initial={0} min={-90} max={90} step="any" />);
    await user.clear(field());
    await user.type(field(), '-33.5');
    expect(field()).not.toHaveAttribute('aria-invalid');
    expect(parent()).toBe('-33.5');
  });

  it('never marks a disabled field invalid', () => {
    render(<Harness initial={null} disabled />);
    expect(field()).not.toHaveAttribute('aria-invalid');
  });

  it('shows the reason in the form when asked to', async () => {
    const user = userEvent.setup();
    render(<Harness initial={5} showReason />);
    await user.clear(field());
    expect(screen.getByText('Enter a number').className).toMatch(/reasonVisible/);
  });
});

describe('NumberInput: allowEmpty', () => {
  it('treats blank as a legal value and emits null', async () => {
    const user = userEvent.setup();
    const onEmit = vi.fn();
    render(<Harness initial={7} allowEmpty onEmit={onEmit} />);

    await user.clear(field());
    expect(field().value).toBe('');
    expect(field()).not.toHaveAttribute('aria-invalid');
    expect(onEmit).toHaveBeenLastCalledWith(null);
    expect(parent()).toBe('null');

    await user.type(field(), '9');
    expect(onEmit).toHaveBeenLastCalledWith(9);
  });

  it('still enforces min/max on a value that is present', async () => {
    const user = userEvent.setup();
    render(<Harness initial={null} allowEmpty min={1} max={5} />);
    expect(field()).not.toHaveAttribute('aria-invalid');
    await user.type(field(), '9');
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(parent()).toBe('null');
  });
});

describe('NumberInput: value changed from outside', () => {
  it('follows the parent when not focused', () => {
    render(<Harness initial={60} />);
    fireEvent.click(screen.getByText('external'));
    expect(field().value).toBe('999');
  });

  it('follows the parent out of an invalid blank state when not focused', async () => {
    const user = userEvent.setup();
    render(<Harness initial={60} />);
    await user.clear(field());
    await user.tab();
    expect(field().value).toBe('');

    fireEvent.click(screen.getByText('external'));
    expect(field().value).toBe('999');
    expect(field()).not.toHaveAttribute('aria-invalid');
  });

  it('leaves the text alone while the user is in the field', async () => {
    const user = userEvent.setup();
    render(<Harness initial={60} />);
    await user.clear(field());
    await user.type(field(), '12');

    // A poll lands mid-edit. fireEvent keeps focus where it is.
    fireEvent.click(screen.getByText('external'));
    expect(field()).toHaveFocus();
    expect(field().value).toBe('12');

    // On leaving, valid text settles on what the parent now holds.
    await user.tab();
    expect(field().value).toBe('999');
  });

  it('settles on the parent value on blur when the parent changed what was typed', async () => {
    const user = userEvent.setup();
    function Rounding() {
      const [v, setV] = useState(1);
      return <NumberInput aria-label="field" value={v} onChange={n => setV(Math.round(n))} />;
    }
    render(<Rounding />);
    await user.clear(field());
    await user.type(field(), '2.6');
    expect(field().value).toBe('2.6');
    await user.tab();
    expect(field().value).toBe('3');
  });
});

describe('NumberInput: alsoValid', () => {
  it('accepts a sentinel under the floor, and still blocks the rest of the gap', async () => {
    const user = userEvent.setup();
    const onEmit = vi.fn();
    // 0 = "use the firmware default"; a real interval must be 32 or more.
    render(<Harness initial={0} min={32} max={86400} integer alsoValid={[0]} onEmit={onEmit} />);
    expect(field()).not.toHaveAttribute('aria-invalid');

    await user.clear(field());
    await user.type(field(), '5');
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(onEmit).not.toHaveBeenCalled();

    await user.clear(field());
    await user.type(field(), '0');
    expect(field()).not.toHaveAttribute('aria-invalid');
    expect(onEmit).toHaveBeenLastCalledWith(0);
  });
});

describe('NumberInput: zeroHint', () => {
  const HINT = '0 = firmware default (3 hours). Save sends 3600 seconds (1 hour), not 0.';
  const hint = () => screen.queryByText(HINT);
  const describedBy = () => (field().getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);

  it('shows what 0 means under a field loaded with 0, and ties it to the field', () => {
    render(<Harness initial={0} min={3600} integer alsoValid={[0]} zeroHint={HINT} />);

    expect(hint()).not.toBeNull();
    expect(hint()!.className).toMatch(/hint/);
    expect(describedBy()).toContain(hint()!.id);
    expect(field()).toHaveAccessibleDescription(HINT);
    // The field's name stays its label: the hint is a description, not a name.
    expect(hint()).toHaveAttribute('aria-hidden', 'true');
    expect(field()).not.toHaveAttribute('aria-invalid');
  });

  it('is hidden for any other value', () => {
    render(<Harness initial={10800} min={3600} integer alsoValid={[0]} zeroHint={HINT} />);
    expect(hint()).toBeNull();
    expect(field()).not.toHaveAttribute('aria-describedby');
  });

  it('follows the text as the user types 0 and then a real value', async () => {
    const user = userEvent.setup();
    const onEmit = vi.fn();
    render(<Harness initial={10800} min={3600} integer alsoValid={[0]} zeroHint={HINT} onEmit={onEmit} />);

    await user.clear(field());
    expect(hint()).toBeNull(); // blank is not 0
    await user.type(field(), '0');
    expect(hint()).not.toBeNull();
    expect(onEmit).toHaveBeenLastCalledWith(0);

    await user.type(field(), '7'); // "07" is 7: under the floor, invalid
    expect(hint()).toBeNull();
    expect(field()).toHaveAttribute('aria-invalid', 'true');

    await user.clear(field());
    await user.type(field(), '7200');
    expect(hint()).toBeNull();
    expect(field()).not.toHaveAttribute('aria-describedby');
  });

  it('appears when a server load brings a 0, and goes when it brings a value', () => {
    function Loader() {
      const [value, setValue] = useState(900);
      return (
        <>
          <NumberInput aria-label="field" min={32} integer alsoValid={[0]} zeroHint={HINT} value={value} onChange={setValue} />
          <button onClick={() => setValue(0)}>load zero</button>
          <button onClick={() => setValue(900)}>load value</button>
        </>
      );
    }
    render(<Loader />);
    expect(hint()).toBeNull();
    fireEvent.click(screen.getByText('load zero'));
    expect(hint()).not.toBeNull();
    fireEvent.click(screen.getByText('load value'));
    expect(hint()).toBeNull();
  });

  it('keeps the caller\'s own aria-describedby', () => {
    render(<Harness initial={0} alsoValid={[0]} zeroHint={HINT} aria-describedby="caller-help" />);
    expect(describedBy()).toEqual(['caller-help', hint()!.id]);
  });

  it('still explains a 0 on a disabled field', () => {
    render(<Harness initial={0} min={32} alsoValid={[0]} zeroHint={HINT} disabled />);
    expect(hint()).not.toBeNull();
    expect(describedBy()).toContain(hint()!.id);
  });

  it('shows nothing at 0 when the field has no hint', () => {
    render(<Harness initial={0} min={0} />);
    expect(document.querySelector('[data-number-hint]')).toBeNull();
    expect(field()).not.toHaveAttribute('aria-describedby');
  });
});

describe('NumberInput: load from server', () => {
  it('shows the new value in the same commit as the parent, with no stale frame', () => {
    const { rerender } = render(<NumberInput aria-label="field" value={0} onChange={() => {}} />);
    rerender(<NumberInput aria-label="field" value={900} onChange={() => {}} />);
    // No waitFor: a form that reads its fields right after a load must see 900.
    expect(field().value).toBe('900');
  });
});

describe('NumberInput: mouse wheel', () => {
  it('drops focus on wheel so a scrolling page cannot change the value', async () => {
    const user = userEvent.setup();
    const onEmit = vi.fn();
    render(<Harness initial={60} onEmit={onEmit} />);
    await user.click(field());
    expect(field()).toHaveFocus();

    fireEvent.wheel(field(), { deltaY: 100 });
    expect(field()).not.toHaveFocus();
    expect(field().value).toBe('60');
    expect(onEmit).not.toHaveBeenCalled();
  });
});

describe('NumberInput: pass-through', () => {
  it('passes id, placeholder, className, min/max/step and aria attributes to the input', () => {
    render(
      <NumberInput
        id="cooldown"
        aria-label="field"
        aria-describedby="help"
        className="setting-input"
        placeholder="seconds"
        value={60}
        min={0}
        max={3600}
        step={5}
        onChange={() => {}}
      />,
    );
    const el = field();
    expect(el.id).toBe('cooldown');
    expect(el.type).toBe('number');
    expect(el.className).toBe('setting-input');
    expect(el.placeholder).toBe('seconds');
    expect(el.min).toBe('0');
    expect(el.max).toBe('3600');
    expect(el.step).toBe('5');
    expect(el).toHaveAttribute('aria-describedby', 'help');
  });
});

describe('NumberInputScope: how a form learns it must not save', () => {
  function Form({ onSave }: { onSave: (v: number) => void }) {
    const [interval, setIntervalValue] = useState(6);
    const [show, setShow] = useState(true);
    const numbers = useNumberInputScope();
    return (
      <NumberInputScope scope={numbers}>
        {show && (
          <NumberInput aria-label="field" value={interval} min={3} max={24} integer onChange={setIntervalValue} />
        )}
        <button disabled={numbers.invalid} onClick={() => onSave(interval)}>save</button>
        <button onClick={numbers.reset}>reset</button>
        <button onClick={() => setShow(false)}>hide</button>
      </NumberInputScope>
    );
  }
  const save = () => screen.getByText('save') as HTMLButtonElement;

  it('disables Save while a field is blank and re-enables it when fixed', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<Form onSave={onSave} />);
    expect(save().disabled).toBe(false);

    await user.clear(field());
    expect(save().disabled).toBe(true);

    await user.type(field(), '12');
    expect(save().disabled).toBe(false);
    await user.click(save());
    expect(onSave).toHaveBeenCalledWith(12);
  });

  it('disables Save for a value under the minimum', async () => {
    const user = userEvent.setup();
    render(<Form onSave={vi.fn()} />);
    await user.clear(field());
    await user.type(field(), '1');
    expect(save().disabled).toBe(true);
  });

  it('reset() puts the saved value back in a blank field', async () => {
    const user = userEvent.setup();
    render(<Form onSave={vi.fn()} />);
    await user.clear(field());
    await user.click(screen.getByText('reset'));
    expect(field().value).toBe('6');
    expect(save().disabled).toBe(false);
  });

  it('stops blocking when the invalid field is removed', async () => {
    const user = userEvent.setup();
    render(<Form onSave={vi.fn()} />);
    await user.clear(field());
    expect(save().disabled).toBe(true);
    await user.click(screen.getByText('hide'));
    expect(save().disabled).toBe(false);
  });

  it('an inner scope also blocks the outer form, and an outer reset reaches inner fields', async () => {
    const user = userEvent.setup();
    function Nested() {
      const outer = useNumberInputScope();
      const inner = useNumberInputScope();
      const [v, setV] = useState(4);
      return (
        <NumberInputScope scope={outer}>
          <NumberInputScope scope={inner}>
            <NumberInput aria-label="field" value={v} onChange={setV} />
          </NumberInputScope>
          <output data-testid="outer">{String(outer.invalid)}</output>
          <output data-testid="inner">{String(inner.invalid)}</output>
          <button onClick={outer.reset}>reset-outer</button>
        </NumberInputScope>
      );
    }
    render(<Nested />);
    await user.clear(field());
    expect(screen.getByTestId('inner').textContent).toBe('true');
    expect(screen.getByTestId('outer').textContent).toBe('true');

    await user.click(screen.getByText('reset-outer'));
    expect(field().value).toBe('4');
    expect(screen.getByTestId('outer').textContent).toBe('false');
  });

  it('reports validity through onValidityChange for a field with no scope', async () => {
    const user = userEvent.setup();
    const onValidityChange = vi.fn();
    render(<Harness initial={3} onValidityChange={onValidityChange} />);
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
    await user.clear(field());
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    await act(async () => { await user.type(field(), '8'); });
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
  });
});

describe('evaluateNumberDraft / formatNumberDraft', () => {
  it('judges half-typed text the browser reports as bad input', () => {
    // A number input reports '' for "-" or "1e"; validity.badInput tells them from blank.
    expect(evaluateNumberDraft('', {}, true)).toEqual({ valid: false, reason: 'notANumber' });
    expect(evaluateNumberDraft('', { allowEmpty: true }, true)).toEqual({ valid: false, reason: 'notANumber' });
  });

  it('accepts trailing-dot and exponent forms the browser lets through', () => {
    expect(evaluateNumberDraft('1.')).toEqual({ valid: true, value: 1 });
    expect(evaluateNumberDraft('1e3')).toEqual({ valid: true, value: 1000 });
    expect(evaluateNumberDraft('-0.5', { min: -1 })).toEqual({ valid: true, value: -0.5 });
  });

  it('names the failed rule', () => {
    expect(evaluateNumberDraft('')).toEqual({ valid: false, reason: 'required' });
    expect(evaluateNumberDraft('   ')).toEqual({ valid: false, reason: 'required' });
    expect(evaluateNumberDraft('abc')).toEqual({ valid: false, reason: 'notANumber' });
    expect(evaluateNumberDraft('Infinity')).toEqual({ valid: false, reason: 'notANumber' });
    expect(evaluateNumberDraft('2.5', { integer: true })).toEqual({ valid: false, reason: 'integer' });
    expect(evaluateNumberDraft('2', { min: 3 })).toEqual({ valid: false, reason: 'min' });
    expect(evaluateNumberDraft('9', { max: 5 })).toEqual({ valid: false, reason: 'max' });
    expect(evaluateNumberDraft('9', { min: 1, max: 5 })).toEqual({ valid: false, reason: 'range' });
    expect(evaluateNumberDraft('0', { min: 0 })).toEqual({ valid: true, value: 0 });
  });

  it('formats a missing or non-finite parent value as blank', () => {
    expect(formatNumberDraft(null)).toBe('');
    expect(formatNumberDraft(undefined)).toBe('');
    expect(formatNumberDraft(NaN)).toBe('');
    expect(formatNumberDraft(0)).toBe('0');
    expect(formatNumberDraft(-1.5)).toBe('-1.5');
  });
});
