import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useEnclosingNumberInputScope } from './numberInputScope';
import {
  evaluateNumberDraft,
  formatNumberDraft,
  type NumberDraftReason,
} from './numberInputValidation';
import styles from './NumberInput.module.css';

type PassThroughProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value' | 'defaultValue' | 'onChange' | 'type' | 'min' | 'max' | 'step'
>;

interface NumberInputBaseProps extends PassThroughProps {
  /** The parent's number. `null` / `undefined` / NaN show as blank. */
  value: number | null | undefined;
  min?: number;
  max?: number;
  step?: number | 'any';
  /** Only whole numbers are valid. */
  integer?: boolean;
  /**
   * Values that are valid even outside min/max: a sentinel such as 0 for
   * "use the firmware default" on a field whose real floor is higher.
   */
  alsoValid?: readonly number[];
  /** Told whenever the field turns valid or invalid. Most forms use a scope instead. */
  onValidityChange?: (valid: boolean) => void;
  /** Show the reason under the field as well as to assistive tech. */
  showReason?: boolean;
}

interface RequiredNumberInputProps extends NumberInputBaseProps {
  allowEmpty?: false;
  /** Called with valid numbers only. Blank or out-of-range text is never emitted. */
  onChange: (value: number) => void;
}

interface OptionalNumberInputProps extends NumberInputBaseProps {
  /** Blank is a legal value: no red outline, and the parent gets `null`. */
  allowEmpty: true;
  onChange: (value: number | null) => void;
}

export type NumberInputProps = RequiredNumberInputProps | OptionalNumberInputProps;

const REASON_KEYS: Record<NumberDraftReason, string> = {
  required: 'number_input.required',
  notANumber: 'number_input.not_a_number',
  integer: 'number_input.integer',
  min: 'number_input.min',
  max: 'number_input.max',
  range: 'number_input.range',
};

const REASON_DEFAULTS: Record<NumberDraftReason, string> = {
  required: 'Enter a number',
  notANumber: 'Not a valid number',
  integer: 'Enter a whole number',
  min: 'Must be {{min}} or more',
  max: 'Must be {{max}} or less',
  range: 'Must be between {{min}} and {{max}}',
};

/**
 * The one number field for the app (#5649).
 *
 * The field owns the text the user is typing, so it can be blank or half-typed
 * without the parent's number state putting the old value back. The parent
 * hears only valid numbers; while the text is invalid the field is outlined in
 * the error colour, sets `aria-invalid`, and reports to the enclosing
 * `NumberInputScope` so the form can block Save. Nothing is clamped or
 * rewritten while typing, and a blank required field stays blank on blur.
 *
 * A disabled or read-only field is never invalid: the user cannot fix it.
 */
export const NumberInput: React.FC<NumberInputProps> = (props) => {
  const {
    value,
    onChange,
    min,
    max,
    step,
    integer,
    allowEmpty,
    alsoValid,
    onValidityChange,
    showReason,
    className,
    disabled,
    readOnly,
    title,
    onFocus,
    onBlur,
    onWheel,
    'aria-describedby': describedBy,
    'aria-invalid': ariaInvalidProp,
    ...rest
  } = props;

  const { t } = useTranslation();
  const scope = useEnclosingNumberInputScope();
  const fieldId = useId();
  const reasonId = `${fieldId}-reason`;

  const [draft, setDraft] = useState(() => formatNumberDraft(value));
  const [badInput, setBadInput] = useState(false);
  const focusedRef = useRef(false);

  // Follow the parent when its value changes from outside (server load, reset)
  // and the user is not in the field. The user's own keystrokes also change
  // `value`, but the field has focus then, so the text is left alone.
  //
  // Done while rendering, not in an effect: the new text must be on screen in
  // the same commit as the parent's new value, or a form reads one frame of
  // stale numbers after a load.
  const [seenValue, setSeenValue] = useState(value);
  if (!Object.is(seenValue, value)) {
    setSeenValue(value);
    if (!focusedRef.current) {
      setDraft(formatNumberDraft(value));
      setBadInput(false);
    }
  }

  // A form reset leaves `value` unchanged when the invalid text was never
  // emitted, so the scope has to say so.
  const resetSignal = scope?.resetSignal ?? 0;
  const [seenReset, setSeenReset] = useState(resetSignal);
  if (seenReset !== resetSignal) {
    setSeenReset(resetSignal);
    setDraft(formatNumberDraft(value));
    setBadInput(false);
  }

  const rules = { min, max, integer, allowEmpty, alsoValid };
  const result = evaluateNumberDraft(draft, rules, badInput);
  const invalid = !result.valid && !disabled && !readOnly;

  const report = scope?.report;
  useEffect(() => {
    if (!report) return;
    report(fieldId, invalid);
    return () => report(fieldId, false);
  }, [report, fieldId, invalid]);

  const onValidityChangeRef = useRef(onValidityChange);
  useEffect(() => {
    onValidityChangeRef.current = onValidityChange;
  });
  useEffect(() => {
    onValidityChangeRef.current?.(!invalid);
  }, [invalid]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const text = e.target.value;
    const bad = e.target.validity?.badInput === true;
    setDraft(text);
    setBadInput(bad);
    const next = evaluateNumberDraft(text, rules, bad);
    if (!next.valid) return;
    if (next.value === null) {
      if (allowEmpty) (onChange as (v: number | null) => void)(null);
      return;
    }
    onChange(next.value);
  };

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    focusedRef.current = true;
    onFocus?.(e);
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    focusedRef.current = false;
    // Valid text settles on the parent's value ("1." -> "1", or whatever the
    // parent made of it). Invalid text stays as typed, blank included.
    if (evaluateNumberDraft(draft, rules, badInput).valid) {
      setDraft(formatNumberDraft(value));
    }
    onBlur?.(e);
  };

  // A focused number input changes its value on wheel while the page scrolls
  // under the pointer. Dropping focus lets the scroll through untouched.
  const handleWheel = (e: React.WheelEvent<HTMLInputElement>) => {
    if (document.activeElement === e.currentTarget) e.currentTarget.blur();
    onWheel?.(e);
  };

  const reason = invalid && !result.valid
    ? t(REASON_KEYS[result.reason], REASON_DEFAULTS[result.reason], { min, max })
    : undefined;

  const classes = [className, invalid ? styles.invalid : ''].filter(Boolean).join(' ') || undefined;
  const describedByIds = [describedBy, invalid ? reasonId : ''].filter(Boolean).join(' ') || undefined;

  return (
    <>
      <input
        {...rest}
        type="number"
        value={draft}
        min={min}
        max={max}
        step={step ?? (integer ? 1 : undefined)}
        disabled={disabled}
        readOnly={readOnly}
        className={classes}
        title={reason ?? title}
        aria-invalid={invalid ? true : ariaInvalidProp}
        aria-describedby={describedByIds}
        data-number-invalid={invalid ? 'true' : undefined}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onWheel={handleWheel}
      />
      {/*
        The reason is read through aria-describedby. Hidden, it lives in
        <body>: as a sibling it would join the text of a wrapping <label> (and
        so the field's name) and add a child to the form's flex row. Shown, it
        is aria-hidden so that the label does not pick it up either.
      */}
      {invalid && showReason && (
        <span id={reasonId} className={styles.reasonVisible} aria-hidden="true">
          {reason}
        </span>
      )}
      {invalid && !showReason && createPortal(
        <span id={reasonId} className={styles.reason}>{reason}</span>,
        document.body,
      )}
    </>
  );
};

export default NumberInput;
