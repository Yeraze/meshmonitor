/**
 * Device Configuration number fields (#5649), through one mesh interval:
 * the Position broadcast interval (MeshMonitor floor: 32 seconds).
 *
 * The section is rendered inside the real SaveBarProvider + SaveBar, with a
 * parent that holds the number state the way ConfigurationTab does. What must
 * hold:
 *   - the field can be cleared, and stays blank and invalid;
 *   - blank or below-floor text never reaches the parent (no NaN, no
 *     0-for-blank, no clamp to the floor), and Save is off;
 *   - a valid value reaches the parent as an integer and Save is back on;
 *   - what onSave reads is that integer.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PositionConfigSection from './PositionConfigSection';
import { SaveBarProvider } from '../../contexts/SaveBarContext';
import { SaveBar } from '../SaveBar/SaveBar';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

interface HarnessProps {
  initialBroadcastSecs?: number;
  onBroadcastSecs: (value: number) => void;
  onSave: (state: { positionBroadcastSecs: number }) => void;
}

/** Stands in for ConfigurationTab: owns the numbers, saves what it holds. */
function Harness({ initialBroadcastSecs = 900, onBroadcastSecs, onSave }: HarnessProps) {
  const [positionBroadcastSecs, setPositionBroadcastSecsState] = useState(initialBroadcastSecs);
  const [smart, setSmart] = useState(false);
  const setPositionBroadcastSecs = (value: number) => {
    onBroadcastSecs(value);
    setPositionBroadcastSecsState(value);
  };
  const noop = () => {};
  return (
    <SaveBarProvider>
      <PositionConfigSection
        positionBroadcastSecs={positionBroadcastSecs}
        positionSmartEnabled={smart}
        fixedPosition={false}
        fixedLatitude={0}
        fixedLongitude={0}
        fixedAltitude={0}
        gpsUpdateInterval={0}
        gpsMode={1}
        broadcastSmartMinimumDistance={0}
        broadcastSmartMinimumIntervalSecs={0}
        positionFlags={0}
        rxGpio={0}
        txGpio={0}
        gpsEnGpio={0}
        setPositionBroadcastSecs={setPositionBroadcastSecs}
        setPositionSmartEnabled={setSmart}
        setFixedPosition={noop}
        setFixedLatitude={noop}
        setFixedLongitude={noop}
        setFixedAltitude={noop}
        setGpsUpdateInterval={noop}
        setGpsMode={noop}
        setBroadcastSmartMinimumDistance={noop}
        setBroadcastSmartMinimumIntervalSecs={noop}
        setPositionFlags={noop}
        setRxGpio={noop}
        setTxGpio={noop}
        setGpsEnGpio={noop}
        isSaving={false}
        onSave={async () => onSave({ positionBroadcastSecs })}
      />
      <SaveBar />
    </SaveBarProvider>
  );
}

const interval = () => document.getElementById('positionBroadcastSecs') as HTMLInputElement;
const saveButton = () => document.querySelector('.save-bar-save') as HTMLButtonElement | null;

/** Make the section dirty through another field, so the SaveBar is on screen. */
async function dirtyTheSection(user: ReturnType<typeof userEvent.setup>) {
  await user.click(document.getElementById('positionSmartEnabled') as HTMLInputElement);
  await waitFor(() => expect(saveButton()).not.toBeNull());
}

describe('PositionConfigSection broadcast interval: a stored 0', () => {
  // The i18n mock answers with the key; zeroHints.test.ts pins the English text.
  const hint = () => screen.queryByText('zero_hint.position_broadcast');

  it('says what 0 means when the node reports 0, and 0 stays saveable', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<Harness initialBroadcastSecs={0} onBroadcastSecs={vi.fn()} onSave={onSave} />);

    expect(interval().value).toBe('0');
    expect(hint()).not.toBeNull();
    expect(interval()).toHaveAccessibleDescription('zero_hint.position_broadcast');
    expect(interval().getAttribute('aria-invalid')).toBeNull();

    await dirtyTheSection(user);
    expect(saveButton()!.disabled).toBe(false);
  });

  it('has no hint at a real interval, shows it when 0 is typed, and drops it again', async () => {
    const user = userEvent.setup();
    const onBroadcastSecs = vi.fn();
    render(<Harness onBroadcastSecs={onBroadcastSecs} onSave={vi.fn()} />);
    expect(hint()).toBeNull();

    await user.clear(interval());
    await user.type(interval(), '0');
    expect(hint()).not.toBeNull();
    expect(onBroadcastSecs).toHaveBeenLastCalledWith(0);

    await user.clear(interval());
    await user.type(interval(), '900');
    expect(hint()).toBeNull();
  });
});

describe('PositionConfigSection broadcast interval (#5649)', () => {
  it('can be cleared and retyped: 900 -> 1800 by backspacing', async () => {
    const user = userEvent.setup();
    const onBroadcastSecs = vi.fn();
    render(<Harness onBroadcastSecs={onBroadcastSecs} onSave={vi.fn()} />);

    await user.click(interval());
    await user.keyboard('{Backspace}{Backspace}{Backspace}');
    expect(interval().value).toBe('');
    await user.keyboard('1800');
    expect(interval().value).toBe('1800');
    expect(onBroadcastSecs).toHaveBeenLastCalledWith(1800);
  });

  it('blank: stays blank, is never sent to the parent, and blocks Save', async () => {
    const user = userEvent.setup();
    const onBroadcastSecs = vi.fn();
    const onSave = vi.fn();
    render(<Harness onBroadcastSecs={onBroadcastSecs} onSave={onSave} />);
    await dirtyTheSection(user);
    expect(saveButton()!.disabled).toBe(false);

    await user.clear(interval());
    await user.tab();
    expect(interval().value).toBe('');
    expect(interval().getAttribute('aria-invalid')).toBe('true');
    // Not NaN, not 0-for-blank, not the 32 s floor: nothing at all.
    expect(onBroadcastSecs).not.toHaveBeenCalled();
    await waitFor(() => expect(saveButton()!.disabled).toBe(true));

    // Even a forced click cannot save.
    fireEvent.click(saveButton()!);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('below the 32 s floor: blocked, not clamped, not sent', async () => {
    const user = userEvent.setup();
    const onBroadcastSecs = vi.fn();
    const onSave = vi.fn();
    render(<Harness onBroadcastSecs={onBroadcastSecs} onSave={onSave} />);
    await dirtyTheSection(user);

    await user.clear(interval());
    await user.type(interval(), '5');
    expect(interval().value).toBe('5');
    expect(interval().getAttribute('aria-invalid')).toBe('true');
    expect(onBroadcastSecs).not.toHaveBeenCalled();
    await waitFor(() => expect(saveButton()!.disabled).toBe(true));
    expect(screen.getByText('savebar.fix_invalid_fields')).toBeTruthy();

    fireEvent.click(saveButton()!);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('a decimal is not an interval: 60.5 is blocked rather than truncated', async () => {
    const user = userEvent.setup();
    const onBroadcastSecs = vi.fn();
    render(<Harness onBroadcastSecs={onBroadcastSecs} onSave={vi.fn()} />);

    await user.clear(interval());
    await user.type(interval(), '60.5');
    expect(interval().getAttribute('aria-invalid')).toBe('true');
    expect(onBroadcastSecs).toHaveBeenLastCalledWith(60);
    expect(onBroadcastSecs).not.toHaveBeenCalledWith(60.5);
  });

  it('fixing the field re-enables Save, and Save sees an integer', async () => {
    const user = userEvent.setup();
    const onBroadcastSecs = vi.fn();
    const onSave = vi.fn();
    render(<Harness onBroadcastSecs={onBroadcastSecs} onSave={onSave} />);
    await dirtyTheSection(user);

    await user.clear(interval());
    await waitFor(() => expect(saveButton()!.disabled).toBe(true));

    await user.type(interval(), '600');
    expect(interval().getAttribute('aria-invalid')).toBeNull();
    await waitFor(() => expect(saveButton()!.disabled).toBe(false));

    await user.click(saveButton()!);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][0];
    expect(saved.positionBroadcastSecs).toBe(600);
    expect(Number.isInteger(saved.positionBroadcastSecs)).toBe(true);
    // Every value the parent ever heard was a whole number at or above the floor.
    for (const [value] of onBroadcastSecs.mock.calls) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(32);
    }
  });

  it('Dismiss puts the saved interval back in a blank field', async () => {
    const user = userEvent.setup();
    render(<Harness onBroadcastSecs={vi.fn()} onSave={vi.fn()} />);
    await dirtyTheSection(user);
    await user.clear(interval());
    expect(interval().value).toBe('');

    await user.click(document.querySelector('.save-bar-dismiss') as HTMLButtonElement);
    await waitFor(() => expect(interval().value).toBe('900'));
    expect(interval().getAttribute('aria-invalid')).toBeNull();
  });

  it('a device reporting 0 (firmware default) does not load red', () => {
    // ConfigurationTab sends that 0 back as 0 (ConfigurationTab.storedZero.test.tsx).
    render(<Harness initialBroadcastSecs={0} onBroadcastSecs={vi.fn()} onSave={vi.fn()} />);
    expect(interval().value).toBe('0');
    expect(interval().getAttribute('aria-invalid')).toBeNull();
  });

  it('any other device value under the floor loads invalid, so it is never written back as-is', () => {
    render(<Harness initialBroadcastSecs={5} onBroadcastSecs={vi.fn()} onSave={vi.fn()} />);
    expect(interval().value).toBe('5');
    expect(interval().getAttribute('aria-invalid')).toBe('true');
  });
});
