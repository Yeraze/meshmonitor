/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TokenInsertButtons } from './TokenInsertButtons';

describe('TokenInsertButtons (#5816)', () => {
  it('renders one "+ {TOKEN}" button per token and passes the token on click', () => {
    const onInsert = vi.fn();
    render(<TokenInsertButtons tokens={['{VERSION}', '{TIME}']} onInsert={onInsert} />);
    expect(screen.getAllByRole('button')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '+ {TIME}' }));
    expect(onInsert).toHaveBeenCalledWith('{TIME}');
  });

  it('disables every button when disabled', () => {
    render(<TokenInsertButtons tokens={['{VERSION}', '{TIME}']} onInsert={vi.fn()} disabled />);
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
  });
});
