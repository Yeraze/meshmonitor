/**
 * TracePathsFieldInput (#5723): rows, per-row width and interval, validation hints.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import TracePathsFieldInput, { type TracePathDraft } from './TracePathsFieldInput';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const K = (c: string) => c.repeat(64);

function Harness({ initial, onValue }: { initial: unknown; onValue: (v: TracePathDraft[]) => void }) {
  const [value, setValue] = useState<unknown>(initial);
  return <TracePathsFieldInput value={value} onChange={(v) => { setValue(v); onValue(v); }} />;
}

describe('TracePathsFieldInput (#5723)', () => {
  it('adds a path with a 60-minute default and lets each row keep its own settings', () => {
    const onValue = vi.fn();
    render(<Harness initial={undefined} onValue={onValue} />);
    expect(screen.getByText(/No paths yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add path/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add path/ }));
    expect(screen.getAllByTestId('trace-path-row')).toHaveLength(2);
    const keys = screen.getAllByLabelText('Contact public key');
    fireEvent.change(keys[0], { target: { value: K('a') } });
    fireEvent.change(keys[1], { target: { value: K('b') } });
    fireEvent.change(screen.getAllByLabelText('Hop hash width')[1], { target: { value: '2' } });
    fireEvent.change(screen.getAllByLabelText('Every (minutes)')[1], { target: { value: '600' } });
    expect(onValue.mock.calls.at(-1)![0]).toEqual([
      { publicKey: K('a'), hashBytes: 'auto', intervalMinutes: 60 },
      { publicKey: K('b'), hashBytes: 2, intervalMinutes: 600 },
    ]);
  });

  it('flags a malformed key and a duplicate contact', () => {
    render(<Harness onValue={() => {}} initial={[
      { publicKey: 'abc', hashBytes: 'auto', intervalMinutes: 10 },
      { publicKey: K('a'), hashBytes: 1, intervalMinutes: 10 },
      { publicKey: K('A'), hashBytes: 1, intervalMinutes: 10 },
    ]} />);
    expect(screen.getByText('A contact key is 64 hex characters.')).toBeInTheDocument();
    expect(screen.getAllByText('This contact is already in the list.')).toHaveLength(2);
  });

  it('removes a row and loads stored values', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} initial={[
      { publicKey: K('a'), hashBytes: 2, intervalMinutes: 30, label: 'Hilltop' },
      { publicKey: K('b'), hashBytes: 'auto', intervalMinutes: 600 },
    ]} />);
    expect(screen.getAllByLabelText('Name (optional)')[0]).toHaveValue('Hilltop');
    expect(screen.getAllByLabelText('Hop hash width')[0]).toHaveValue('2');
    fireEvent.click(screen.getByRole('button', { name: 'Remove path 1' }));
    expect(onValue.mock.calls.at(-1)![0]).toEqual([{ publicKey: K('b'), hashBytes: 'auto', intervalMinutes: 600 }]);
  });
});
