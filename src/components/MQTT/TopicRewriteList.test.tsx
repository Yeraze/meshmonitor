/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TopicRewriteList } from './TopicRewriteList';
import { MAX_TOPIC_REWRITE_RULES } from '../../server/constants/mqttBridge.js';

// Render the inline English defaults so the test reads like the UI.
vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const two = [
  { from: 'msh/local', to: 'root/a' },
  { from: 'msh/local', to: 'root/b' },
];

describe('TopicRewriteList (#6516)', () => {
  it('adds an empty row, edits a row and removes a row', () => {
    const onChange = vi.fn();
    render(<TopicRewriteList title="Uplink" rows={two} onChange={onChange} />);

    fireEvent.click(screen.getByText('Add rule'));
    expect(onChange).toHaveBeenLastCalledWith([...two, { from: '', to: '' }]);

    fireEvent.change(screen.getByLabelText('Uplink 2 to'), { target: { value: 'root/c' } });
    expect(onChange).toHaveBeenLastCalledWith([two[0], { from: 'msh/local', to: 'root/c' }]);

    fireEvent.click(screen.getAllByLabelText('Remove rule')[0]);
    expect(onChange).toHaveBeenLastCalledWith([two[1]]);
  });

  it('labels the primary rule only when asked and there is more than one', () => {
    const { rerender } = render(<TopicRewriteList title="Uplink" rows={two} onChange={vi.fn()} markPrimary />);
    expect(screen.getByText(/Primary/)).toBeTruthy();
    rerender(<TopicRewriteList title="Uplink" rows={two} onChange={vi.fn()} />);
    expect(screen.queryByText(/Primary/)).toBeNull();
    rerender(<TopicRewriteList title="Uplink" rows={[two[0]]} onChange={vi.fn()} markPrimary />);
    expect(screen.queryByText(/Primary/)).toBeNull();
  });

  it(`stops adding at ${MAX_TOPIC_REWRITE_RULES} rules`, () => {
    const full = Array.from({ length: MAX_TOPIC_REWRITE_RULES }, (_, i) => ({ from: `a${i}`, to: 'b' }));
    render(<TopicRewriteList title="Downlink" rows={full} onChange={vi.fn()} />);
    expect((screen.getByText('Add rule').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
