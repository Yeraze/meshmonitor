/**
 * @vitest-environment jsdom
 *
 * MeshCoreAdvertModeField — Zero-hop / Flood choice for automated adverts,
 * with the flood cost + hourly floor warning next to the Flood option.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MeshCoreAdvertModeField } from './MeshCoreAdvertModeField';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

describe('MeshCoreAdvertModeField', () => {
  it('checks the current mode and reports a change', () => {
    const onChange = vi.fn();
    render(<MeshCoreAdvertModeField value="zero_hop" onChange={onChange} />);
    expect(screen.getByRole('radio', { name: 'Zero-hop (nearby nodes only)' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Flood (whole mesh)' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Flood (whole mesh)' }));
    expect(onChange).toHaveBeenCalledWith('flood');
  });

  it('shows the flood cost and the once-per-hour floor', () => {
    render(<MeshCoreAdvertModeField value="flood" onChange={vi.fn()} />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(/every repeater within 8 hops/);
    expect(note).toHaveTextContent(/9 s \(US\) \/ 25 s \(EU\)/);
    expect(note).toHaveTextContent(/at most once per hour per source; extra floods are skipped/);
  });

  it('disables both options', () => {
    render(<MeshCoreAdvertModeField value="flood" onChange={vi.fn()} disabled />);
    for (const r of screen.getAllByRole('radio')) expect(r).toBeDisabled();
  });
});
