/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DmFilterSelect } from './DmFilterSelect';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock((key: string) => key);
});

describe('DmFilterSelect', () => {
  it('offers all seven options by default', () => {
    render(<DmFilterSelect value="all" onChange={() => {}} />);
    expect((screen.getByTitle('messages.filter_conversations_title') as HTMLSelectElement).options.length).toBe(7);
  });
  it('offers a subset and reports changes', () => {
    const onChange = vi.fn();
    render(<DmFilterSelect value="all" onChange={onChange} options={['all', 'unread']} />);
    const sel = screen.getByTitle('messages.filter_conversations_title') as HTMLSelectElement;
    expect(Array.from(sel.options).map(o => o.value)).toEqual(['all', 'unread']);
    fireEvent.change(sel, { target: { value: 'unread' } });
    expect(onChange).toHaveBeenCalledWith('unread');
  });
});
