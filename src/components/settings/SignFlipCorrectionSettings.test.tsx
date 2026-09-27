/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SignFlipCorrectionSettings, { type SignFlipCorrectionSettingsProps } from './SignFlipCorrectionSettings';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, def?: string, opts?: Record<string, unknown>) => {
      if (typeof def !== 'string') return key;
      return def.replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts?.[k] ?? ''));
    },
  }),
}));

function setup(overrides: Partial<SignFlipCorrectionSettingsProps> = {}) {
  const props: SignFlipCorrectionSettingsProps = {
    enabled: true,
    rangeKm: 500,
    referenceLatitude: '',
    referenceLongitude: '',
    distanceUnit: 'km',
    onEnabledChange: vi.fn(),
    onRangeKmChange: vi.fn(),
    onReferenceLatitudeChange: vi.fn(),
    onReferenceLongitudeChange: vi.fn(),
    ...overrides,
  };
  render(<SignFlipCorrectionSettings {...props} />);
  return props;
}

describe('SignFlipCorrectionSettings (#5363)', () => {
  it('shows the range in km and stores km', () => {
    const props = setup();
    const input = screen.getByLabelText('Range (km)') as HTMLInputElement;
    expect(input.value).toBe('500');
    fireEvent.change(input, { target: { value: '250' } });
    expect(props.onRangeKmChange).toHaveBeenCalledWith(250);
  });

  it('shows the range in miles when the user prefers miles, and converts back to km', () => {
    const props = setup({ distanceUnit: 'mi' });
    const input = screen.getByLabelText('Range (mi)') as HTMLInputElement;
    expect(input.value).toBe('311');
    fireEvent.change(input, { target: { value: '100' } });
    const km = (props.onRangeKmChange as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(km).toBeCloseTo(160.93, 1);
  });

  it('clamps the range on blur', () => {
    const props = setup({ rangeKm: 3 });
    fireEvent.blur(screen.getByLabelText('Range (km)'));
    expect(props.onRangeKmChange).toHaveBeenCalledWith(10);
  });

  it('disables the inputs when off', () => {
    setup({ enabled: false });
    expect(screen.getByLabelText('Range (km)')).toBeDisabled();
    expect(screen.getByLabelText('Latitude')).toBeDisabled();
  });

  it('flags a half-entered reference point', () => {
    setup({ referenceLatitude: '27.9' });
    expect(screen.getByTestId('sign-flip-reference-invalid')).toBeInTheDocument();
  });

  it('accepts a blank or complete reference point', () => {
    setup({ referenceLatitude: '27.9', referenceLongitude: '-82.4' });
    expect(screen.queryByTestId('sign-flip-reference-invalid')).not.toBeInTheDocument();
  });

  it('puts the checkbox inside an inline row with its text, not stacked above it', () => {
    setup();
    const box = document.getElementById('signFlipCorrectionEnabled') as HTMLInputElement;
    // The global `.setting-item label` is a column flexbox, so the box must sit
    // in an inner row element, as the other Node Display checkboxes do.
    const row = box.parentElement!;
    expect(row.tagName).toBe('SPAN');
    expect(row.textContent).toContain('Correct sign-flipped positions');
    expect(row.parentElement!.tagName).toBe('LABEL');
  });

  it('disables every control when read-only', () => {
    setup({ disabled: true });
    expect(screen.getByLabelText('Correct sign-flipped positions')).toBeDisabled();
    expect(screen.getByLabelText('Range (km)')).toBeDisabled();
    expect(screen.getByLabelText('Latitude')).toBeDisabled();
    expect(screen.getByLabelText('Longitude')).toBeDisabled();
  });

  it('reports the toggle', () => {
    const props = setup({ enabled: false });
    fireEvent.click(screen.getByLabelText('Correct sign-flipped positions'));
    expect(props.onEnabledChange).toHaveBeenCalledWith(true);
  });
});
