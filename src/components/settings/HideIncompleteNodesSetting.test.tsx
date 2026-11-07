/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { HideIncompleteNodesSetting } from './HideIncompleteNodesSetting';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock((key: string) => key);
});

describe('HideIncompleteNodesSetting', () => {
  it('shows the default description and reports changes', () => {
    const onChange = vi.fn();
    render(<HideIncompleteNodesSetting checked={false} onChange={onChange} />);
    expect(screen.getByText('settings.hide_incomplete_description')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('uses a custom description and honours disabled', () => {
    render(<HideIncompleteNodesSetting checked onChange={vi.fn()} disabled description="custom hint" />);
    expect(screen.getByText('custom hint')).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  });
});
